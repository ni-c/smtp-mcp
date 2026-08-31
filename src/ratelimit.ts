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
/** A slot held while a send is being approved and delivered. */
export interface RateLimitSlot {
  /** Keeps the slot: the SMTP server accepted the message. */
  commit(now?: number): void;
  /** Gives the slot back: nothing was sent. Idempotent. */
  release(): void;
}

interface Entry {
  at: number;
  committed: boolean;
}

export class RateLimiter {
  private readonly sends: Entry[] = [];

  constructor(
    private readonly maxPerHour: number,
    private readonly windowMs: number = HOUR_MS
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    // Only committed entries age out. A reserved one is a send in flight —
    // possibly sitting in front of a human for the full five minutes of the
    // elicitation timeout — and expiring it would hand its slot to somebody
    // else while it is still going to be used.
    while (
      this.sends.length > 0 &&
      this.sends[0] !== undefined &&
      this.sends[0].committed &&
      this.sends[0].at <= cutoff
    ) {
      this.sends.shift();
    }
  }

  /** Messages that may still be sent in the current window. */
  remaining(now: number = Date.now()): number {
    this.prune(now);
    return Math.max(0, this.maxPerHour - this.sends.length);
  }

  /**
   * Takes a slot for a send that is about to be attempted, or refuses.
   *
   * The slot is taken *now*, before the confirmation dialog, and this is the
   * whole point. Checking availability and only counting the send afterwards
   * looks equivalent and is not: MCP clients issue tool calls in parallel, so
   * five concurrent sends all read the same "one remaining" and all five went
   * out against a limit of one. The gap was the entire round trip to the SMTP
   * server, which on a real network is the common case rather than a race that
   * needs winning.
   *
   * Nothing is permanently consumed until {@link RateLimitSlot.commit}. A
   * declined dialog or a refused message calls `release` instead, because a
   * message the recipient never got must not count against the hour.
   */
  reserve(now: number = Date.now()): RateLimitSlot {
    if (this.remaining(now) === 0) {
      const oldest = this.sends[0]?.at ?? now;
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

    const entry: Entry = { at: now, committed: false };
    this.sends.push(entry);
    let settled = false;
    return {
      commit: (at: number = Date.now()) => {
        if (settled) return;
        settled = true;
        entry.committed = true;
        // Stamped at commit time, not at reservation time: the window should
        // start when the message actually went out.
        entry.at = at;
      },
      release: () => {
        if (settled) return;
        settled = true;
        const index = this.sends.indexOf(entry);
        if (index !== -1) this.sends.splice(index, 1);
      },
    };
  }
}
