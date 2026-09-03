import { createHash } from 'node:crypto';

import { detectSuspicious } from './analyze.js';
import { loadAttachments, type LoadedAttachment } from './attachments.js';
import { composeMessage, type ComposedMessage } from './compose.js';
import type { Config } from './config.js';
import { ToolInputError } from './errors.js';
import { refusedRecipients } from './recipients.js';
import { htmlToText } from './sanitize.js';

/** Keeps the first spelling of each address, comparing case-insensitively. */
function dedupeAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(address);
  }
  return kept;
}

/** The arguments every message-shaped tool accepts, after zod validation. */
export interface MailArgs {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  html?: string | undefined;
  quote?: string | undefined;
  in_reply_to?: string | undefined;
  references?: string[] | undefined;
  attachments?: string[] | undefined;
  /** Test seams; real calls leave these unset. */
  date?: Date | undefined;
  message_id?: string | undefined;
}

export interface PreparedMessage {
  composed: ComposedMessage;
  to: string[];
  cc: string[];
  bcc: string[];
  /** Every address the message will reach, in envelope order. */
  all: string[];
  attachments: LoadedAttachment[];
  /**
   * Injection shapes found in the text the caller supplied, by field.
   *
   * The quote is the obvious place to look, and looking only there was a gap:
   * `forward_mail` documents `body` as "your own text", which is exactly the
   * parameter an injected instruction would ask a model to use instead. The
   * detector is a signal rather than a filter, so widening it costs nothing but
   * a line in the dialog.
   *
   * Kept per field, because the two readings are not alike and the dialog has
   * to say which one it is. A match in the quote is a forwarded message that
   * tries to give orders — passed on unchanged, correctly. A match in the body
   * or the HTML part is the model writing those orders itself, which is the
   * thing the quote was trying to make happen.
   */
  suspicious: SuspiciousField[];
  /**
   * Whether the plain-text and HTML parts say noticeably different things.
   *
   * A `multipart/alternative` message carries two versions and promises they
   * are the same. Nothing enforces that: the person approving reads the body
   * line in the dialog, most recipients see only the HTML part, and a message
   * whose two parts disagree is the classic shape of both a phishing mail and a
   * filter-evasion trick. A signal, not a filter — a summary in the body next to
   * a formatted table in the HTML also trips it, and the dialog says so.
   */
  textHtmlDiverge: boolean;
}

/** Words of three letters or more, lowercased, as a set. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3)
  );
}

/**
 * Whether the two texts share less than half their vocabulary.
 *
 * Jaccard similarity over word sets. Short texts are exempt: with fewer than
 * five words on either side the measure is noise.
 */
export function textsDiverge(a: string, b: string): boolean {
  const wordsA = wordSet(a);
  const wordsB = wordSet(b);
  if (wordsA.size < 5 || wordsB.size < 5) return false;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  const union = wordsA.size + wordsB.size - shared;
  return shared / union < 0.5;
}

export interface SuspiciousField {
  field: 'quote' | 'body' | 'html';
  patterns: string[];
}

/** Every pattern name across all fields, each once, for the flat summaries. */
export function suspiciousPatterns(
  fields: readonly SuspiciousField[]
): string[] {
  return [...new Set(fields.flatMap((f) => f.patterns))];
}

/**
 * Everything that happens to a message before anyone is asked to approve it.
 *
 * `preview_mail` and the three sending tools share this function on purpose. A
 * preview that took a different path would be a preview of something else, and
 * a check that only the sending tools ran would be a check the preview quietly
 * lacked.
 *
 * The order is the interesting part, and each step names the variable that
 * caused it:
 *
 *  1. **Recipients against the allowlist**, before anything is read from disk
 *     or composed. A refused message should cost nothing and leak nothing —
 *     in particular it should not report whether an attachment exists.
 *  2. **Recipient count**, so a message to a thousand people is refused as a
 *     list rather than discovered one address at a time.
 *  3. **Attachments**, each of which is a filesystem read and a policy check.
 *  4. **Composition**, which enforces the total size.
 *
 * The rate limit and the human confirmation come after this, in the sending
 * tools — they are about the act of sending, and the preview does neither.
 */
export async function prepareMessage(
  args: MailArgs,
  config: Config,
  version: string
): Promise<PreparedMessage> {
  const to = args.to;
  const cc = args.cc ?? [];
  const bcc = args.bcc ?? [];
  const all = [...to, ...cc, ...bcc];

  const refused = refusedRecipients(all, config.allowedRecipients);
  if (refused.length > 0) {
    throw new ToolInputError(
      `smtp-mcp: refused — ${refused.length} recipient(s) are not covered by ` +
        `SMTP_ALLOWED_RECIPIENTS: ${refused.join(', ')}. Nothing was sent.`
    );
  }

  // Duplicates are not an error — a person legitimately appears in To and Cc
  // of a thread — so they count once here and are deduplicated in the envelope
  // below, which is what stops the server delivering two copies.
  const distinct = new Set(all.map((address) => address.toLowerCase()));
  if (distinct.size > config.maxRecipients) {
    throw new ToolInputError(
      `smtp-mcp: ${distinct.size} distinct recipients across To, Cc and Bcc, ` +
        `over the limit of ${config.maxRecipients} (SMTP_MAX_RECIPIENTS). ` +
        'Nothing was sent.'
    );
  }

  const attachments = await loadAttachments(args.attachments ?? [], {
    directory: config.attachmentDir,
    allowedTypes: config.allowedAttachmentTypes,
    maxBytes: config.maxAttachmentBytes,
  });

  // A lower bound on the composed size, before anything is composed. The size
  // check in `composeMessage` is exact and stays; this one exists because ten
  // attachments at the default ceiling are 50 MB on disk and about 67 MB once
  // base64 has run over them — all of it allocated, encoded and then refused by
  // that exact check, and reachable through `preview_mail` with no gate, no
  // confirmation and no rate limit. What cannot fit is refused before it is
  // built. Only sure things are counted: base64 grows by exactly 4/3 plus a
  // line break every 76 characters, and a body is at least as long as itself.
  const attachmentBytes = attachments.reduce((sum, a) => sum + a.bytes, 0);
  const lowerBound =
    Math.ceil(attachmentBytes / 3) * 4 * (78 / 76) +
    args.body.length +
    (args.html?.length ?? 0) +
    (args.quote?.length ?? 0);
  if (lowerBound > config.maxMessageBytes) {
    throw new ToolInputError(
      `smtp-mcp: the message would be at least ${Math.ceil(lowerBound)} bytes ` +
        `once encoded, over the limit of ${config.maxMessageBytes} ` +
        '(SMTP_MAX_MESSAGE_BYTES). Attachments grow by about a third when ' +
        'encoded. Nothing was composed.'
    );
  }

  const composed = await composeMessage(
    {
      to,
      cc,
      bcc,
      subject: args.subject,
      body: args.body,
      html: args.html,
      quote: args.quote,
      inReplyTo: args.in_reply_to,
      references: args.references,
      attachments,
      date: args.date,
      messageId: args.message_id,
    },
    config,
    version
  );

  return {
    composed: {
      ...composed,
      envelope: {
        from: composed.envelope.from,
        // Deduplicated case-insensitively, matching how the recipient count is
        // taken. A case-sensitive Set counted `A@x.net` and `a@x.net` as one
        // address against the limit and then sent two RCPTs for them.
        to: dedupeAddresses(composed.envelope.to),
      },
    },
    to,
    cc,
    bcc,
    all,
    attachments,
    suspicious: (
      [
        ['quote', args.quote],
        ['body', args.body],
        ['html', args.html],
      ] as const
    )
      .filter(
        (entry): entry is readonly [SuspiciousField['field'], string] =>
          entry[1] !== undefined && entry[1] !== ''
      )
      .map(([field, text]) => ({ field, patterns: detectSuspicious(text) }))
      .filter((entry) => entry.patterns.length > 0),
    // Only when both parts were written by the caller. A text part derived
    // from the HTML (empty body) cannot diverge from it.
    textHtmlDiverge:
      args.body !== '' &&
      composed.htmlBody !== undefined &&
      textsDiverge(composed.textBody, htmlToText(composed.htmlBody)),
  };
}

/**
 * Binds a confirmation to this exact message.
 *
 * Recipients *and* content: without the content digest an approval for "the
 * quarterly report to the team" could be spent on a different message to the
 * same team, which is the same hole the recipient fingerprint closes in the
 * other direction. Hashed rather than included, because the key is compared,
 * never read, and a body does not belong in a map key.
 *
 * Computed from the **arguments**, deliberately not from the composed bytes.
 * Every composition stamps a fresh `Date` and a random `Message-ID`, so a
 * digest of the message would differ between the call that issues the token and
 * the call that redeems it — the gate would reject every second call and there
 * would be no way to send anything at all. What has to be stable across those
 * two calls is what the caller asked for, and that is what is hashed.
 */
export function messageFingerprint(
  args: MailArgs,
  prepared: PreparedMessage
): string[] {
  const content = createHash('sha256').update(
    JSON.stringify([
      args.subject,
      args.body,
      args.html ?? '',
      args.quote ?? '',
      args.in_reply_to ?? '',
      args.references ?? [],
      args.attachments ?? [],
    ])
  );
  // The attachment *bytes*, not just the names. Between the two calls of the
  // token path the files are read again, so anyone able to write into
  // SMTP_ATTACHMENT_DIR could otherwise swap the contents after approval and
  // before the send. Hashing them makes that a fresh prompt instead.
  for (const attachment of prepared.attachments)
    content.update(attachment.content);
  const digest = content.digest('hex').slice(0, 32);

  // The three recipient fields are hashed separately rather than folded into
  // one sorted list. `setResourceKey` sorts what it is given, so a single list
  // binds only the multiset of addresses — and moving somebody from To to Bcc,
  // or from Bcc to To, leaves that multiset unchanged. Both directions matter:
  // the first hides a recipient the human saw, the second exposes one they were
  // told was hidden.
  return [
    `to:${[...args.to].sort().join(',')}`,
    `cc:${[...(args.cc ?? [])].sort().join(',')}`,
    `bcc:${[...(args.bcc ?? [])].sort().join(',')}`,
    `content:${digest}`,
  ];
}
