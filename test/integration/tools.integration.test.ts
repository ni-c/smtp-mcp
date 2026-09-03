import {
  expectEveryToolDeclaresOutputSchema,
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  tokenOf,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import { bootstrap, delivered, inbox, raw, type Sandbox } from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real SMTP server in Docker.
 *
 * Ported from `scripts/sandbox/smoke.mjs`, which did all of this correctly —
 * exit code included — and which nothing ran.
 *
 * The gap it closes is specific. Everything in `test/` runs against an
 * in-memory fake, which is the right trade for a unit suite and proves nothing
 * about MIME encoding, the SMTP dialogue or the envelope. Here a message is
 * composed by the tools, carried over a real SMTP connection, and then read
 * back out of Mailpit — so every assertion is about what *arrived*, not about
 * what the tool said it did.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

const SUBJECT = 'smtp-mcp integration suite';

function parse<T>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

/** The message the send tests compose, reused so the preview matches the send. */
const MAIL = {
  to: ['anna@example.net'],
  cc: ['carol@example.net'],
  bcc: ['hidden@example.net'],
  subject: SUBJECT,
  body: 'Integration body.',
  html:
    '<p>Integration body.</p><script>steal()</script>' +
    '<img src="https://tracker.example/p.gif">' +
    // The two shapes that used to walk straight through: a `<` in an earlier
    // attribute value, which stopped the tag pattern reaching the closing `>`,
    // and `srcset`, which `\bsrc` never matched at all. Both are beacons and
    // both are asserted on the transmitted bytes below.
    '<img alt="<" src="https://tracker.example/hidden.gif">' +
    '<img srcset="https://tracker.example/set.gif 2x">' +
    '<script a="<">peek()</script>',
  attachments: ['report.pdf'],
};

interface Sent {
  sent: boolean;
  accepted: string[];
  message_id: string;
}

let sent: Sent;

beforeAll(async () => {
  sandbox = await bootstrap();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the connection', () => {
  it('reports how the server is configured', async () => {
    const info = await asking.call('get_server_info');
    expect(info).toContain('127.0.0.1');
    expect(info).toContain('"sending_enabled": true');
    // The password must not come back out, on a tool whose whole job is to
    // describe the configuration and which a model will call first.
    expect(info).not.toContain('the-password-must-never-be-echoed');
  });

  it('reaches the SMTP server without sending anything', async () => {
    const result = parse<{ reachable: boolean }>(
      await asking.call('test_connection')
    );
    expect(result.reachable).toBe(true);
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });

  it('checks recipients against the allowlist without sending', async () => {
    const checked = await asking.call('validate_recipients', {
      addresses: ['anna@example.net', 'stranger@evil.example'],
    });
    expect(checked).toContain('anna@example.net');
    expect(checked).toContain('stranger@evil.example');
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });
});

describe('the allowlist', () => {
  it('refuses a recipient outside it, and names the variable', async () => {
    // The reason, not a bare `expectError: true`: a renamed parameter makes the
    // schema refuse the call, and a guard test written that way stays green
    // while the guard it is named after is no longer reached at all.
    const refused = await asking.call(
      'send_mail',
      {
        to: ['stranger@evil.example'],
        subject: SUBJECT,
        body: 'This must not go out.',
      },
      { expectError: /not covered by SMTP_ALLOWED_RECIPIENTS/ }
    );
    expect(refused).toContain('stranger@evil.example');
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });
});

describe('the attachment policy', () => {
  it('refuses a path that leaves SMTP_ATTACHMENT_DIR', async () => {
    await asking.call(
      'send_mail',
      {
        to: ['anna@example.net'],
        subject: SUBJECT,
        body: 'This must not go out.',
        attachments: ['../../../etc/passwd'],
      },
      { expectError: /must be a plain file name, not a path/ }
    );
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });

  it('refuses an executable file type', async () => {
    await asking.call(
      'send_mail',
      {
        to: ['anna@example.net'],
        subject: SUBJECT,
        body: 'This must not go out.',
        attachments: ['payload.exe'],
      },
      { expectError: /is an executable file type/ }
    );
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });
});

describe('markup that cannot be cleaned', () => {
  it('is refused rather than sent with a script still in it', async () => {
    // Refusing is the right failure for outgoing text: nothing arrives that
    // cannot be recalled. An unterminated attribute quote is the case no
    // pattern here can resolve, so it is the case that must stop.
    await asking.call(
      'send_mail',
      {
        to: ['anna@example.net'],
        subject: SUBJECT,
        body: 'This must not go out.',
        html: '<p>x</p><script a="',
      },
      { expectError: /still contains a <script> tag/ }
    );
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });

  it('refuses an RFC 2047 encoded-word in the subject', async () => {
    // Shown to the human as written, decoded by the recipient's client into a
    // different sentence entirely.
    await asking.call(
      'send_mail',
      {
        to: ['anna@example.net'],
        subject: '=?utf-8?B?UGF5bWVudCBkZXRhaWxzIGNoYW5nZWQ=?=',
        body: 'This must not go out.',
      },
      { expectError: /encoded-word/ }
    );
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });
});

describe('the preview', () => {
  it('shows what would be sent, and sends nothing', async () => {
    const result = await asking.raw('preview_mail', MAIL);
    const preview = (result.content ?? [])
      .map((part) => part.text ?? '')
      .join('');
    expect(preview).toContain('From: Sandbox');
    expect(preview).toContain('X-Mailer: smtp-mcp/');
    // The sanitiser's work, visible before anything is committed — as data.
    // It names the scheme the caller wrote before a colon, so it belongs in a
    // field rather than in the server's own header, which sits outside the
    // untrusted fence.
    expect(preview).toMatch(/thing\(s\) were removed from the HTML part/);
    expect(result.structuredContent).toMatchObject({
      html_removed: expect.arrayContaining([
        expect.stringContaining('<script> element'),
      ]),
    });
    // The Bcc is not in the header block: that is the whole point of a Bcc,
    // and a preview that leaked it would teach the wrong thing.
    expect(preview.split('--- text/plain ---')[0]).not.toContain(
      'hidden@example.net'
    );
    expect((await inbox(sandbox.api)).messages_count).toBe(0);
  });
});

describe('sending, and what actually arrived', () => {
  it('sends only on the second call', async () => {
    // An error result: the prompt says nothing was sent. It has to be one — a
    // tool that declares an `outputSchema` may not answer without
    // `structuredContent` unless the result is an error.
    const first = await plain.call('send_mail', MAIL, {
      expectError: /confirm_token=/,
    });
    expect(first).toContain('confirm_token');
    // The first call is a question. Nothing left the process.
    expect((await inbox(sandbox.api)).messages_count).toBe(0);

    sent = parse<Sent>(
      await plain.call('send_mail', { ...MAIL, confirm_token: tokenOf(first) })
    );
    expect(sent.sent).toBe(true);
    // To, Cc and Bcc: three envelope recipients from one call.
    expect(sent.accepted).toHaveLength(3);
  });

  it('will not send the same message a second time', async () => {
    // The strongest form of the at-most-once claim: not "the tool said no" but
    // "nothing else arrived at the SMTP server". An approval binds an answer to
    // a question and stays redeemable until it expires, so without a record of
    // what already went out a retried leg puts a second copy in an inbox.
    const before = (await inbox(sandbox.api)).messages_count;
    // Not a prompt and not an error: the at-most-once record answers before
    // anybody is asked again.
    const repeat = await plain.call('send_mail', MAIL);
    expect(repeat).toContain('already_sent');
    expect(repeat).toContain(sent.message_id);
    expect((await inbox(sandbox.api)).messages_count).toBe(before);
  });

  it('delivers what was composed', async () => {
    const list = await inbox(sandbox.api);
    expect(list.messages_count).toBe(1);
    const id = list.messages[0]!.ID;
    const message = await delivered(sandbox.api, id);
    const wire = await raw(sandbox.api, id);

    expect(message.Subject).toBe(SUBJECT);
    expect(message.From.Address).toBe('sandbox@example.net');
    expect(message.To).toHaveLength(1);
    expect(message.Cc).toHaveLength(1);

    // The Bcc recipient got it, and is in neither To nor Cc. Mailpit's /raw
    // cannot answer this — see the note on `raw` in bootstrap.ts — so the
    // observable consequence is what is asserted.
    expect(sent.accepted).toContain('hidden@example.net');
    expect([...message.To, ...message.Cc].map((a) => a.Address)).not.toContain(
      'hidden@example.net'
    );

    expect(wire).toContain(sent.message_id);
    expect(wire).toMatch(/^X-Mailer: smtp-mcp\//m);
    expect(message.Text).toContain('Sent from the smtp-mcp integration suite');

    // None of them survived the sanitiser, and this is the only place that can
    // be checked on the bytes that were actually transmitted. `hidden.gif`,
    // `set.gif` and `peek()` are the three that used to go out under the
    // operator's own DKIM signature while the dialog said they had been removed.
    expect(wire).not.toContain('tracker.example');
    expect(wire).not.toContain('steal()');
    expect(wire).not.toContain('peek()');

    expect(message.Attachments).toHaveLength(1);
    expect(message.Attachments[0]!.FileName).toBe('report.pdf');
    expect(message.Attachments[0]!.ContentType).toBe('application/pdf');
  });
});

describe('threading', () => {
  it('replies under the original', async () => {
    await plain.confirmed('reply_mail', {
      to: ['anna@example.net'],
      original_subject: SUBJECT,
      body: 'Thanks.',
      quote: 'Integration body.',
      in_reply_to: sent.message_id,
      references: [sent.message_id],
    });

    const list = await inbox(sandbox.api);
    const reply = list.messages.find((m) => m.Subject.startsWith('Re: '));
    expect(reply).toBeDefined();

    const wire = await raw(sandbox.api, reply!.ID);
    expect(wire).toContain(`In-Reply-To: ${sent.message_id}`);
    // The quoted original is prefixed, so a reader can tell the two apart.
    expect(wire).toContain('> Integration body.');
  });

  it('forwards, carrying the original along', async () => {
    await asking.call('forward_mail', {
      to: ['bob@example.net'],
      original_subject: SUBJECT,
      body: 'Passing this on.',
      quote: 'Integration body.',
    });

    const list = await inbox(sandbox.api);
    const forwarded = list.messages.find((m) => m.Subject.startsWith('Fwd: '));
    expect(forwarded).toBeDefined();

    const message = await delivered(sandbox.api, forwarded!.ID);
    expect(message.To.map((a) => a.Address)).toContain('bob@example.net');
    expect(message.Text).toContain('Integration body.');
  });

  it('asked a person on one harness and nobody on the other', () => {
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});

it('declares an output schema on every tool', async () => {
  // The unit suite checks the same thing against a stub. Here it is checked
  // against the server that has just answered every one of these tools against
  // a real SMTP server — and each of those answers went through the SDK's
  // validation against the schema below it.
  const { tools } = await asking.client.listTools();
  expectEveryToolDeclaresOutputSchema(tools);
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([...asking.called, ...plain.called]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `smtp-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real SMTP server`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
