import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Bounds the map so a loop of refused calls cannot grow it without limit. */
const MAX_PENDING = 100;

/**
 * Issues short-lived confirmation tokens for irreversible operations.
 *
 * A plain boolean `confirm` parameter could be set by the model on the very
 * first call — or be talked into it by instructions hidden in a quoted
 * original — whereas a random token that only ever appears in a *previous* tool
 * result cannot be guessed. The token is bound to a resource key, so a
 * confirmation for one message cannot be replayed for another.
 */
export class ConfirmationStore {
  private readonly pending = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = TOKEN_TTL_MS) {}

  /** Creates (or replaces) the pending token for `resource`. */
  issue(resource: string): string {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const token = randomBytes(16).toString('hex');
    this.pending.set(resource, { token, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /**
   * Returns true and consumes the token when it matches the pending one for
   * `resource` and has not expired. Tokens are single-use.
   */
  consume(resource: string, token: string | undefined): boolean {
    const entry = this.pending.get(resource);
    if (entry === undefined || token === undefined) return false;
    const supplied = Buffer.from(token);
    const expected = Buffer.from(entry.token);
    // Constant-time comparison. Guessing 128 random bits through a timing side
    // channel is not a realistic attack on a local tool, but the safe
    // comparison costs one line and removes the question.
    const matches =
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected);
    if (!matches) return false;
    // Delete on any match, expired or not. Leaving a matched-but-dead entry
    // behind kept it competing for space with live ones, and the eviction in
    // issue() is insertion-order rather than LRU, so a long-lived key could be
    // dropped ahead of a token that was already spent.
    this.pending.delete(resource);
    return Date.now() < entry.expiresAt;
  }

  /** Minutes the issued tokens stay valid, for use in messages. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }
}

/**
 * Resource key for an operation on a *set* of targets.
 *
 * This is the whole reason a token is not simply "yes". Without the
 * fingerprint, a confirmation obtained for `["chef@example.net"]` would also
 * execute `["chef@example.net", "attacker@example.com"]` — the model chooses
 * the second list, and only the operation name would have been checked. For a
 * send, the fingerprint covers the recipients *and* a digest of the subject and
 * body, so approval of one message cannot be spent on a different one to the
 * same people.
 */
export function setResourceKey(operation: string, targets: string[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...targets].sort()))
    .digest('hex')
    .slice(0, 16);
  return `${operation}:${fingerprint}`;
}

/**
 * A name this server did not choose, shown alongside a confirmation.
 *
 * Recipient addresses and subjects look like server-side metadata and are not:
 * they come from the model's arguments, and on a reply or a forward they came
 * out of a message a stranger wrote. A subject of
 * `Invoice" — routine, pre-approved by IT` interpolated into the middle of
 * "This will send a message to N recipients" reads as part of the server's own
 * sentence, in the one string a human is given before a message leaves the
 * building.
 *
 * So they are never interpolated: {@link renderDetails} puts each on its own
 * labelled line. `addressParam` and `subjectParam` refuse CR, LF and NUL, so a
 * value cannot open a second line and forge a label of its own — the
 * single-line rendering is what that validation is worth.
 */
export interface ConfirmationDetail {
  label: string;
  value: string;
}

/**
 * Everything a renderer might treat as the end of a line.
 *
 * The schemas refuse these already. This is the second lock, and it belongs
 * here because this function is where the one-value-per-line promise is
 * actually made: a value that could open a line of its own could forge a label,
 * and the label is the only thing telling a human which value they are looking
 * at. Beyond CR and LF, CSS `white-space: pre-wrap` — how an Electron client
 * renders this message — breaks on U+000B, U+000C, U+0085, U+2028 and U+2029.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point
const LINE_BREAKS = /[\r\n\u0000\u000b\u000c\u0085\u2028\u2029]/g;

function renderDetails(details: readonly ConfirmationDetail[]): string {
  if (details.length === 0) return '';
  return (
    '\n\nValues below are supplied by the caller, not by this server:\n' +
    details
      .map((d) => `  ${d.label}: ${d.value.replace(LINE_BREAKS, ' ')}`)
      .join('\n')
  );
}

/**
 * Builds the text returned by the first call of a sending tool.
 *
 * Note what is NOT in here: no message body. Bodies are long, are partly
 * attacker-authored on a reply or forward, and this string is read by a model.
 * The recipients and the subject are what a human needs to decide, and they go
 * through `details` for the reason above.
 */
export function confirmationPrompt(
  what: string,
  token: string,
  ttlMinutes: number,
  consequence = 'The operation is irreversible.',
  details: readonly ConfirmationDetail[] = []
): string {
  return (
    `This will ${what}. ${consequence}` +
    `${renderDetails(details)}\n\n` +
    `To proceed, call this tool again with confirm_token="${token}".\n` +
    `The token is valid for ${ttlMinutes} minutes and can be used once.`
  );
}

export { renderDetails };
