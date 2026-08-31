import { describe, expect, it } from 'vitest';

import { ToolInputError } from '../src/errors.js';
import { RateLimiter } from '../src/ratelimit.js';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** Reserve and commit in one step, for the cases that are not about the slot. */
function send(limiter: RateLimiter, at: number): void {
  limiter.reserve(at).commit(at);
}

describe('RateLimiter', () => {
  it('starts with the full allowance', () => {
    expect(new RateLimiter(3).remaining(T0)).toBe(3);
  });

  it('counts each committed send', () => {
    const limiter = new RateLimiter(3);
    send(limiter, T0);
    send(limiter, T0 + 1);
    expect(limiter.remaining(T0 + 2)).toBe(1);
  });

  it('refuses once the window is full, naming the variable', () => {
    const limiter = new RateLimiter(2);
    send(limiter, T0);
    send(limiter, T0 + 1);
    expect(() => limiter.reserve(T0 + 2)).toThrow(ToolInputError);
    expect(() => limiter.reserve(T0 + 2)).toThrow(/SMTP_MAX_SENDS_PER_HOUR/);
  });

  it('says nothing was sent when it refuses', () => {
    const limiter = new RateLimiter(1);
    send(limiter, T0);
    expect(() => limiter.reserve(T0 + 1)).toThrow(/Nothing was sent/);
  });

  it('slides rather than resetting on the hour', () => {
    const limiter = new RateLimiter(2);
    send(limiter, T0);
    send(limiter, T0 + 30 * 60 * 1000);
    expect(limiter.remaining(T0 + 31 * 60 * 1000)).toBe(0);
    // The first send ages out; the second has half an hour left to run.
    expect(limiter.remaining(T0 + HOUR + 1)).toBe(1);
    expect(limiter.remaining(T0 + 90 * 60 * 1000 + 1)).toBe(2);
  });

  it('estimates when the next slot frees up', () => {
    const limiter = new RateLimiter(1);
    send(limiter, T0);
    // Fifteen minutes in, forty-five remain on the oldest entry.
    expect(() => limiter.reserve(T0 + 15 * 60 * 1000)).toThrow(/45 minute/);
  });
});

describe('reserving a slot', () => {
  it('holds the slot from the moment it is taken', () => {
    // The whole point of reserving rather than checking. Five concurrent sends
    // used to read the same "one remaining" and all five went out, because
    // nothing was counted until the SMTP server answered — and MCP clients
    // issue tool calls in parallel.
    const limiter = new RateLimiter(1);
    limiter.reserve(T0);
    expect(limiter.remaining(T0)).toBe(0);
    expect(() => limiter.reserve(T0)).toThrow(/SMTP_MAX_SENDS_PER_HOUR/);
  });

  it('gives the slot back when nothing was sent', () => {
    // A declined dialog or a refused message must not burn quota.
    const limiter = new RateLimiter(1);
    const slot = limiter.reserve(T0);
    slot.release();
    expect(limiter.remaining(T0)).toBe(1);
    expect(() => limiter.reserve(T0)).not.toThrow();
  });

  it('keeps the slot once committed', () => {
    const limiter = new RateLimiter(1);
    limiter.reserve(T0).commit(T0);
    expect(limiter.remaining(T0)).toBe(0);
  });

  it('ignores a release after a commit, and a second commit', () => {
    const limiter = new RateLimiter(2);
    const slot = limiter.reserve(T0);
    slot.commit(T0);
    slot.release();
    slot.commit(T0);
    expect(limiter.remaining(T0)).toBe(1);
  });

  it('ignores a second release', () => {
    const limiter = new RateLimiter(2);
    const slot = limiter.reserve(T0);
    slot.release();
    slot.release();
    expect(limiter.remaining(T0)).toBe(2);
  });

  it('does not expire a reservation that is still waiting for a human', () => {
    // An elicitation dialog can sit in front of somebody for five minutes. If
    // the reservation aged out of the window meanwhile, its slot would be
    // handed to another call while it was still going to be used.
    const limiter = new RateLimiter(1);
    limiter.reserve(T0);
    expect(limiter.remaining(T0 + 2 * HOUR)).toBe(0);
  });

  it('dates the window from the commit, not from the reservation', () => {
    const limiter = new RateLimiter(1);
    const slot = limiter.reserve(T0);
    // Approved half an hour later; the hour runs from then.
    slot.commit(T0 + 30 * 60 * 1000);
    expect(limiter.remaining(T0 + HOUR + 1)).toBe(0);
    expect(limiter.remaining(T0 + 90 * 60 * 1000 + 1)).toBe(1);
  });

  it('lets a released slot be reused by the next caller', () => {
    const limiter = new RateLimiter(1);
    const first = limiter.reserve(T0);
    first.release();
    const second = limiter.reserve(T0);
    second.commit(T0);
    expect(limiter.remaining(T0)).toBe(0);
  });
});
