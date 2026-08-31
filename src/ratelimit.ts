import { ToolInputError } from './errors.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Caps how many messages leave in a sliding hour.
 *
 * What this is for: the confirmation dialog and the allowlist both assume the
 * attack is a single convincing message. This one bounds the other shape — a
 * model in a loop, a compromised session sending the same thing to everyone on
 * an allowlisted domain, a retry storm after a misread error. It turns "the
 * incident is however long nobody was watching" into "the incident is at most
 * N messages".
 *
 * Deliberately in-process and not persisted. A counter in a file would have to
 * be locked, would drift when two clients run the server at once, and would
 * turn a corrupt state file into a server that refuses to send at all. Restart
 * therefore resets the window, which is stated in the README rather than hidden:
 * this is a blast-radius limit, not a quota anyone should be billing against.
 */
export class RateLimiter {
  private readonly sends: number[] = [];

  constructor(
    private readonly maxPerHour: number,
    private readonly windowMs: number = HOUR_MS
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.sends.length > 0 && (this.sends[0] ?? 0) <= cutoff) {
      this.sends.shift();
    }
  }

  /** Messages that may still be sent in the current window. */
  remaining(now: number = Date.now()): number {
    this.prune(now);
    return Math.max(0, this.maxPerHour - this.sends.length);
  }

  /**
   * Refuses when the window is full.
   *
   * Called *before* the confirmation dialog, so a limit that is already reached
   * does not put a pointless question in front of a human — but nothing is
   * consumed here. A send that the user declines, or that the SMTP server
   * rejects, must not burn quota: otherwise a message the recipient never got
   * would still count towards the hour.
   */
  assertAvailable(now: number = Date.now()): void {
    if (this.remaining(now) > 0) return;
    const oldest = this.sends[0] ?? now;
    const freeInMinutes = Math.max(
      1,
      Math.ceil((oldest + this.windowMs - now) / 60_000)
    );
    throw new ToolInputError(
      `smtp-mcp: the send rate limit of ${this.maxPerHour} message(s) per hour ` +
        `is reached (SMTP_MAX_SENDS_PER_HOUR). The next slot frees up in about ` +
        `${freeInMinutes} minute(s). Nothing was sent.`
    );
  }

  /** Records a message the SMTP server accepted. */
  record(now: number = Date.now()): void {
    this.prune(now);
    this.sends.push(now);
  }
}
