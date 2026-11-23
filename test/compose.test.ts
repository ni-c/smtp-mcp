import { describe, expect, it } from 'vitest';

import { composeMessage, normalizeMessageId } from '../src/compose.js';
import { ToolInputError } from '../src/errors.js';

import { testConfig } from './harness.js';

const DATE = new Date('2026-08-31T10:00:00Z');

async function compose(
  overrides: Partial<Parameters<typeof composeMessage>[0]> = {},
  config = testConfig()
) {
  return composeMessage(
    {
      to: ['anna@example.net'],
      cc: [],
      bcc: [],
      subject: 'Quarterly report',
      body: 'Here it is.',
      format: 'text',
      attachments: [],
      date: DATE,
      messageId: '<fixed@example.net>',
      ...overrides,
    },
    config,
    '1.2.3'
  );
}

function headerBlock(raw: Buffer): string {
  const text = raw.toString('utf8');
  return text.slice(0, text.indexOf('\r\n\r\n'));
}

describe('composeMessage', () => {
  it('writes the configured sender, never one from the caller', async () => {
    const composed = await compose();
    expect(headerBlock(composed.raw)).toContain('From: Me <me@example.net>');
    expect(composed.envelope.from).toBe('me@example.net');
  });

  it('stamps X-Mailer with the package version', async () => {
    expect(headerBlock((await compose()).raw)).toContain(
      'X-Mailer: smtp-mcp/1.2.3'
    );
  });

  it('puts To and Cc in the headers', async () => {
    const composed = await compose({
      to: ['anna@example.net', 'bob@example.net'],
      cc: ['carol@example.net'],
    });
    const headers = headerBlock(composed.raw);
    expect(headers).toContain('anna@example.net');
    expect(headers).toContain('carol@example.net');
    expect(headers).toMatch(/^Cc:/m);
  });

  it('keeps Bcc out of the headers but in the envelope', async () => {
    // That is what makes it blind. Delivery follows the envelope, so naming the
    // recipient there is what actually reaches them.
    const composed = await compose({ bcc: ['secret@example.net'] });
    // The whole message, not just the header block: a Bcc leaking anywhere in
    // the bytes discloses the hidden recipient to everyone else on the message.
    // Worth asserting here because it cannot be checked through Mailpit, which
    // reconstructs a Bcc line from the envelope for its own display.
    expect(composed.raw.toString('utf8')).not.toContain('secret@example.net');
    expect(composed.envelope.to).toContain('secret@example.net');
  });

  it('writes no Reply-To header unless one is configured', async () => {
    expect(headerBlock((await compose()).raw)).not.toContain('Reply-To');
  });

  it('writes the configured Reply-To exactly once, keeping the display name', async () => {
    const composed = await compose(
      {},
      testConfig({
        smtp: {
          ...testConfig().smtp,
          replyTo: 'The Team <team@example.net>',
          replyToAddress: 'team@example.net',
        },
      })
    );
    const headers = headerBlock(composed.raw);
    expect(headers).toContain('Reply-To: The Team <team@example.net>');
    expect(headers.match(/^Reply-To:/gm)).toHaveLength(1);
  });

  it('keeps the Reply-To out of the envelope', async () => {
    // The point of the header: it tells the recipient's client where to write,
    // and changes nothing about who this server delivers to. If it reached the
    // envelope it would become a recipient — one the allowlist never saw.
    const composed = await compose(
      {},
      testConfig({
        smtp: {
          ...testConfig().smtp,
          replyTo: 'team@example.net',
          replyToAddress: 'team@example.net',
        },
      })
    );
    expect(composed.envelope.to).toEqual(['anna@example.net']);
    expect(composed.envelope.from).toBe('me@example.net');
  });

  it('encodes a non-ASCII Reply-To display name rather than sending raw UTF-8', async () => {
    const composed = await compose(
      {},
      testConfig({
        smtp: {
          ...testConfig().smtp,
          replyTo: 'Grüße <team@example.net>',
          replyToAddress: 'team@example.net',
        },
      })
    );
    const headers = headerBlock(composed.raw);
    expect(headers).toMatch(/Reply-To: =\?/);
    expect(headers).not.toContain('Grüße');
  });

  it('builds the envelope from the address lists, not from the headers', async () => {
    const composed = await compose({
      to: ['anna@example.net'],
      cc: ['carol@example.net'],
      bcc: ['dan@example.net'],
    });
    expect(composed.envelope.to).toEqual([
      'anna@example.net',
      'carol@example.net',
      'dan@example.net',
    ]);
  });

  it('refuses a line break in a header value', async () => {
    // The schema rejects these first; this is the second lock on the same door.
    await expect(
      compose({ subject: 'Invoice\r\nBcc: attacker@evil.example' })
    ).rejects.toThrow(ToolInputError);
    await expect(
      compose({ to: ['a@example.net\nBcc: x@y.example'] })
    ).rejects.toThrow(/line breaks/);
  });

  it('encodes a non-ASCII subject rather than sending raw UTF-8', async () => {
    const composed = await compose({ subject: 'Grüße aus Köln' });
    const headers = headerBlock(composed.raw);
    expect(headers).toMatch(/Subject: =\?/);
    expect(headers).not.toContain('Grüße');
  });

  it('threads a reply with In-Reply-To and References', async () => {
    const composed = await compose({
      inReplyTo: 'abc@example.net',
      references: ['<root@example.net>', 'mid@example.net'],
    });
    const headers = headerBlock(composed.raw);
    // Angle brackets are added where the caller left them off.
    expect(headers).toContain('In-Reply-To: <abc@example.net>');
    expect(headers).toContain('<root@example.net>');
    expect(headers).toContain('<mid@example.net>');
  });

  it('quotes the original with the conventional "> " prefix', async () => {
    const composed = await compose({ quote: 'line one\n\nline two' });
    expect(composed.textBody).toContain('> line one');
    expect(composed.textBody).toContain('> line two');
  });

  it('appends the signature below the standard delimiter', async () => {
    const composed = await compose(
      {},
      testConfig({ signature: 'Ada Lovelace\nExample GmbH' })
    );
    expect(composed.textBody).toContain('\n-- \nAda Lovelace\nExample GmbH');
  });

  it('sends plain text alone by default', async () => {
    const composed = await compose({ body: 'Hi **there**' });
    expect(composed.htmlBody).toBeUndefined();
    expect(composed.raw.toString('utf8')).not.toContain('text/html');
  });

  it('adds an HTML part rendered from a Markdown body', async () => {
    const composed = await compose({
      body: 'Hi **there**\n\n<script>steal()</script> ![p](https://t.example/p.gif)',
      format: 'markdown',
    });
    expect(composed.textBody).toBe(
      'Hi **there**\n\n<script>steal()</script> ![p](https://t.example/p.gif)'
    );
    expect(composed.htmlBody).toContain('<strong>there</strong>');
    expect(composed.htmlBody).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(composed.htmlBody).toContain(
      '<a href="https://t.example/p.gif">p</a>'
    );
    expect(composed.htmlBody).not.toMatch(/<(script|img)/);
    expect(composed.raw.toString('utf8')).toContain('multipart/alternative');
  });

  it('puts quote and signature into both parts, the HTML ones escaped', async () => {
    const composed = await compose(
      { body: 'Yes.', format: 'markdown', quote: 'Was it <b>you</b>?' },
      testConfig({ signature: 'Ada & Co' })
    );
    expect(composed.textBody).toBe(
      'Yes.\n\n> Was it <b>you</b>?\n\n-- \nAda & Co'
    );
    expect(composed.htmlBody).toContain(
      '<blockquote>Was it &lt;b&gt;you&lt;/b&gt;?</blockquote>'
    );
    expect(composed.htmlBody).toContain('<div>-- <br>\nAda &amp; Co</div>');
  });

  it('reports what rendering changed, in its own words', async () => {
    const composed = await compose({
      body: '[bank.example](https://evil.example)',
      format: 'markdown',
    });
    expect(composed.bodyNotes).toEqual([
      expect.stringMatching(/^1 link showed text that did not match/),
    ]);
  });

  it('refuses a Markdown body over its ceiling as a caller error', async () => {
    await expect(
      compose({ body: 'a'.repeat(100_001), format: 'markdown' })
    ).rejects.toThrow(ToolInputError);
  });

  it('refuses a message over the size limit, naming the variable', async () => {
    await expect(
      compose({ body: 'x'.repeat(3000) }, testConfig({ maxMessageBytes: 1000 }))
    ).rejects.toThrow(/SMTP_MAX_MESSAGE_BYTES/);
  });

  it('refuses to compose without a configured sender', async () => {
    const config = testConfig();
    config.smtp.from = undefined;
    config.smtp.fromAddress = undefined;
    await expect(compose({}, config)).rejects.toThrow(/SMTP_FROM/);
  });

  it('generates a Message-ID in the sender domain when none is given', async () => {
    const composed = await composeMessage(
      {
        to: ['anna@example.net'],
        cc: [],
        bcc: [],
        subject: 's',
        body: 'b',
        format: 'text',
        attachments: [],
        date: DATE,
      },
      testConfig(),
      '1.2.3'
    );
    expect(composed.messageId).toMatch(/^<[0-9a-f-]+@example\.net>$/);
  });

  it('carries attachments with their type and filename', async () => {
    const composed = await compose({
      attachments: [
        {
          filename: 'report.pdf',
          contentType: 'application/pdf',
          content: Buffer.from('%PDF-1.7 body'),
          bytes: 13,
        },
      ],
    });
    const raw = composed.raw.toString('utf8');
    expect(raw).toContain('report.pdf');
    expect(raw).toContain('application/pdf');
    // Base64 of the payload, i.e. the bytes really travelled.
    expect(raw).toContain(Buffer.from('%PDF-1.7 body').toString('base64'));
  });
});

describe('normalizeMessageId', () => {
  it('adds the angle brackets exactly once', () => {
    expect(normalizeMessageId('abc@example.net')).toBe('<abc@example.net>');
    expect(normalizeMessageId('<abc@example.net>')).toBe('<abc@example.net>');
    expect(normalizeMessageId('  <abc@example.net>  ')).toBe(
      '<abc@example.net>'
    );
  });
});
