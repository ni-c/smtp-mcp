import { describe, expect, it } from 'vitest';

import { ToolInputError } from '../src/errors.js';
import { RateLimiter } from '../src/ratelimit.js';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('RateLimiter', () => {
  it('starts with the full allowance', () => {
    expect(new RateLimiter(3).remaining(T0)).toBe(3);
  });

  it('counts each recorded send', () => {
    const limiter = new RateLimiter(3);
    limiter.record(T0);
    limiter.record(T0 + 1);
    expect(limiter.remaining(T0 + 2)).toBe(1);
  });

  it('refuses once the window is full, naming the variable', () => {
    const limiter = new RateLimiter(2);
    limiter.record(T0);
    limiter.record(T0 + 1);
    expect(() => limiter.assertAvailable(T0 + 2)).toThrow(ToolInputError);
    expect(() => limiter.assertAvailable(T0 + 2)).toThrow(
      /SMTP_MAX_SENDS_PER_HOUR/
    );
  });

  it('says nothing was sent when it refuses', () => {
    const limiter = new RateLimiter(1);
    limiter.record(T0);
    expect(() => limiter.assertAvailable(T0 + 1)).toThrow(/Nothing was sent/);
  });

  it('slides rather than resetting on the hour', () => {
    const limiter = new RateLimiter(2);
    limiter.record(T0);
    limiter.record(T0 + 30 * 60 * 1000);
    expect(limiter.remaining(T0 + 31 * 60 * 1000)).toBe(0);
    // The first send ages out; the second has half an hour left to run.
    expect(limiter.remaining(T0 + HOUR + 1)).toBe(1);
    expect(limiter.remaining(T0 + 90 * 60 * 1000 + 1)).toBe(2);
  });

  it('estimates when the next slot frees up', () => {
    const limiter = new RateLimiter(1);
    limiter.record(T0);
    // Fifteen minutes in, forty-five remain on the oldest entry.
    expect(() => limiter.assertAvailable(T0 + 15 * 60 * 1000)).toThrow(
      /45 minute/
    );
  });

  it('does not consume anything when it is merely asked', () => {
    // The check runs before the confirmation dialog; a declined dialog must not
    // burn quota, so asking has to be free.
    const limiter = new RateLimiter(2);
    limiter.assertAvailable(T0);
    limiter.assertAvailable(T0);
    expect(limiter.remaining(T0)).toBe(2);
  });
});
