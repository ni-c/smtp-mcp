/**
 * What this server has already put on the wire, so it does not do it twice.
 *
 * An approval proves that a person agreed to *this* message. It does not prove
 * that they agreed to it a second time: `mcp-approval` says in its own security
 * policy that the sealed elicitation state binds an answer to the question it
 * was given and stays redeemable until it expires. Everywhere else in this
 * family that is harmless, because the guarded operation is idempotent —
 * deleting an already-deleted note changes nothing. Here a second call reaches
 * a person, and neither copy can be recalled.
 *
 * The narrower reason matters just as much and does not depend on the protocol
 * revision at all: a tool call is at-least-once by nature. A client that times
 * out and retries, a host that reconnects mid-flow, a model that repeats itself
 * — each of those sends the message again today, with nobody asked and nothing
 * to notice it afterwards.
 *
 * So the key is the fingerprint the approval is already bound to, which covers
 * every recipient field, the subject, the body, the HTML part, the quoted
 * original and the attachment bytes. Anything genuinely different is a
 * different message and sends normally.
 */

/** What is remembered about a message that went out. */
export interface SentMessage {
  messageId: string;
  /** The addresses the SMTP server took, so a repeat answers what the first did. */
  accepted: string[];
}

/**
 * How long a send is remembered.
 *
 * Matched to `createApproval`'s default TTL rather than picked: the window this
 * has to cover is exactly the window in which an approval for the same message
 * could still be redeemed. Longer would start refusing repeats that a person
 * deliberately asked for — somebody re-sending the same reminder an hour later
 * is not the case this guards against, and silently not sending it would be a
 * worse failure than sending it twice.
 */
const REMEMBER_MS = 15 * 60 * 1000;

/**
 * Bounds the map, so a loop of distinct sends cannot grow it without limit.
 *
 * Generous on purpose: the rate limiter caps real sends long before this, so
 * reaching it means something is wrong elsewhere and dropping the oldest entry
 * is the least bad thing to do.
 */
const MAX_REMEMBERED = 512;

export class SentRegistry {
  private readonly sent = new Map<
    string,
    SentMessage & { expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = REMEMBER_MS) {}

  /**
   * What went out under this key, or undefined.
   *
   * Expiry is checked on read as well as swept on write, so a stale entry can
   * never answer for a message whose approval window has closed.
   */
  find(key: string): SentMessage | undefined {
    const entry = this.sent.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.sent.delete(key);
      return undefined;
    }
    return { messageId: entry.messageId, accepted: [...entry.accepted] };
  }

  /** Remembers a message the SMTP server accepted. */
  record(key: string, message: SentMessage): void {
    const now = Date.now();
    for (const [existing, entry] of this.sent) {
      if (now >= entry.expiresAt) this.sent.delete(existing);
    }
    if (this.sent.size >= MAX_REMEMBERED) {
      // Deleted before it is set below, so a re-recorded key moves to the end
      // rather than keeping the position of the one it replaced.
      for (const oldest of this.sent.keys()) {
        this.sent.delete(oldest);
        break;
      }
    }
    this.sent.delete(key);
    this.sent.set(key, { ...message, expiresAt: now + this.ttlMs });
  }
}
