import { describe, expect, it } from 'vitest';

import {
  messageFingerprint,
  type MailArgs,
  type PreparedMessage,
} from '../src/prepare.js';

/** The fingerprint of one message whose attachments carry the given bytes. */
function fingerprint(files: Array<[string, string]>): string {
  const args: MailArgs = {
    to: ['anna@example.net'],
    subject: 'Report',
    body: 'Attached.',
    attachments: files.map(([name]) => name),
  };
  const prepared = {
    attachments: files.map(([filename, text]) => ({
      filename,
      contentType: 'text/plain',
      content: Buffer.from(text),
      bytes: text.length,
    })),
  } as unknown as PreparedMessage;
  return messageFingerprint(args, prepared).join('|');
}

describe('the fingerprint over the attachment bytes', () => {
  it('is the same for the same files', () => {
    expect(
      fingerprint([
        ['a.txt', 'AB'],
        ['b.txt', 'C'],
      ])
    ).toBe(
      fingerprint([
        ['a.txt', 'AB'],
        ['b.txt', 'C'],
      ])
    );
  });

  it('tells the same bytes apart when they are split differently', () => {
    // Fed to the hash one file after another with nothing between them,
    // `AB` + `C` and `A` + `BC` were one byte string and one digest — so a
    // writer in SMTP_ATTACHMENT_DIR could move the tail of one approved file
    // to the head of the next between the two calls of the token path, and
    // the approval still matched.
    expect(
      fingerprint([
        ['a.txt', 'AB'],
        ['b.txt', 'C'],
      ])
    ).not.toBe(
      fingerprint([
        ['a.txt', 'A'],
        ['b.txt', 'BC'],
      ])
    );
  });

  it('tells an empty file apart from no file', () => {
    expect(fingerprint([['a.txt', '']])).not.toBe(fingerprint([]));
  });
});
