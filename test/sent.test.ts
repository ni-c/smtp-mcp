import { afterEach, describe, expect, it, vi } from 'vitest';

import { SentRegistry } from '../src/sent.js';

const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('SentRegistry', () => {
  it('remembers a message it was told about', () => {
    const registry = new SentRegistry();
    registry.record('send_mail:abc', { messageId: '<1@x.net>', accepted: 2 });
    expect(registry.find('send_mail:abc')).toEqual({
      messageId: '<1@x.net>',
      accepted: 2,
    });
  });

  it('knows nothing about a message it was not told about', () => {
    const registry = new SentRegistry();
    registry.record('send_mail:abc', { messageId: '<1@x.net>', accepted: 1 });
    expect(registry.find('send_mail:def')).toBeUndefined();
    // The tool name is part of the key: the same text through reply_mail is a
    // different message.
    expect(registry.find('reply_mail:abc')).toBeUndefined();
  });

  it('forgets once the approval it guards could no longer be redeemed', () => {
    // Longer would start refusing repeats a person deliberately asked for.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registry = new SentRegistry(15 * MINUTE);
    registry.record('send_mail:abc', { messageId: '<1@x.net>', accepted: 1 });

    vi.setSystemTime(14 * MINUTE);
    expect(registry.find('send_mail:abc')).toBeDefined();

    vi.setSystemTime(15 * MINUTE);
    expect(registry.find('send_mail:abc')).toBeUndefined();
  });

  it('sweeps expired entries on write as well as on read', () => {
    // A key nobody looks up again must not sit in the map for the life of the
    // process just because no read happened to touch it.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registry = new SentRegistry(5 * MINUTE);
    registry.record('send_mail:old', { messageId: '<1@x.net>', accepted: 1 });

    vi.setSystemTime(6 * MINUTE);
    registry.record('send_mail:new', { messageId: '<2@x.net>', accepted: 1 });
    expect(registry.find('send_mail:old')).toBeUndefined();
    expect(registry.find('send_mail:new')).toBeDefined();
  });

  it('drops the oldest entry rather than growing without bound', () => {
    // The rate limiter caps real sends long before this, so reaching the
    // ceiling means something is wrong elsewhere; the oldest is the least bad
    // thing to lose, being the one closest to expiring anyway.
    const registry = new SentRegistry();
    for (let i = 0; i < 600; i += 1) {
      registry.record(`send_mail:${i}`, { messageId: `<${i}>`, accepted: 1 });
    }
    expect(registry.find('send_mail:0')).toBeUndefined();
    expect(registry.find('send_mail:599')).toBeDefined();
  });

  it('moves a re-recorded key to the end rather than leaving it oldest', () => {
    const registry = new SentRegistry();
    registry.record('send_mail:a', { messageId: '<1>', accepted: 1 });
    registry.record('send_mail:b', { messageId: '<2>', accepted: 1 });
    registry.record('send_mail:a', { messageId: '<3>', accepted: 1 });
    expect(registry.find('send_mail:a')).toMatchObject({ messageId: '<3>' });
    for (let i = 0; i < 511; i += 1) {
      registry.record(`send_mail:${i}`, { messageId: `<${i}>`, accepted: 1 });
    }
    // `b` was the oldest by then, so it is the one that went.
    expect(registry.find('send_mail:b')).toBeUndefined();
    expect(registry.find('send_mail:a')).toBeDefined();
  });
});
