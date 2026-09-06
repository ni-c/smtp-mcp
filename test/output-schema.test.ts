import { describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../src/tools/catalogue.js';
import { call, connect, sendArgs, textOf } from './harness.js';

/**
 * Every tool answers within the schema it declared — checked by a client that
 * has loaded `tools/list` first.
 *
 * `z.object({...})` emits `additionalProperties: false`, and a client that
 * knows the schema validates `structuredContent` against it and throws a
 * `ProtocolError` when a field is not in it. It only does so on the success
 * path, and only once it has the schema — so a test that calls without listing
 * first, and every error-path test, stay green while a real client breaks. The
 * listing is what makes these calls the real thing.
 */
describe('every tool answers within its declared schema', () => {
  /** The arguments that take each tool down its success path. */
  const successPaths: Record<
    (typeof ALL_TOOLS)[number],
    Record<string, unknown>
  > = {
    get_server_info: {},
    validate_recipients: {
      addresses: ['anna@example.net', 'stranger@evil.example'],
    },
    preview_mail: sendArgs({
      html: '<p>Hello</p><img src="https://tracker.example/p.gif">',
      quote: 'Original text',
    }),
    test_connection: {},
    send_mail: sendArgs(),
    reply_mail: {
      ...sendArgs(),
      original_subject: 'Quarterly report',
      in_reply_to: '<abc@example.net>',
      references: ['<abc@example.net>'],
      quote: 'Original text',
    },
    forward_mail: {
      ...sendArgs(),
      original_subject: 'Quarterly report',
      quote: 'Original text',
    },
  };

  it('covers the whole catalogue', () => {
    expect(Object.keys(successPaths).toSorted()).toEqual(ALL_TOOLS.toSorted());
  });

  for (const [name, args] of Object.entries(successPaths)) {
    it(`${name}: structured content matches, text carries the same document`, async () => {
      const harness = await connect({
        config: { allowSend: true },
        elicit: 'accept',
      });
      await harness.client.listTools();
      const result = await call(harness.client, name, args);
      expect(result.isError, textOf(result)).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      // The text block and the structured half carry the same document.
      // preview_mail is the exception by design: its text is a fenced
      // rendering of the message, and the structured half states the fields.
      if (name !== 'preview_mail') {
        expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
      }
      await harness.close();
    });
  }

  it('send_mail: the already-sent answer is within the schema too', async () => {
    // The second shape a send can answer with, which a schema written for the
    // first would not cover.
    const harness = await connect({
      config: { allowSend: true },
      elicit: 'accept',
    });
    await harness.client.listTools();
    await call(harness.client, 'send_mail', sendArgs());
    const repeat = await call(harness.client, 'send_mail', sendArgs());
    expect(repeat.isError).not.toBe(true);
    expect(repeat.structuredContent).toMatchObject({ already_sent: true });
    expect(JSON.parse(textOf(repeat))).toEqual(repeat.structuredContent);
    await harness.close();
  });

  it('test_connection: the repeated answer is within the schema too', async () => {
    const harness = await connect();
    await harness.client.listTools();
    await call(harness.client, 'test_connection');
    const repeat = await call(harness.client, 'test_connection');
    expect(repeat.isError).not.toBe(true);
    expect(repeat.structuredContent).toMatchObject({ cached: true });
    expect(JSON.parse(textOf(repeat))).toEqual(repeat.structuredContent);
    await harness.close();
  });
});
