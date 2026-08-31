import { describe, expect, it } from 'vitest';

import { SmtpError } from '../src/errors.js';
import {
  asSmtpError,
  createSmtpConnection,
  SmtpClient,
  transportOptions,
} from '../src/smtp.js';

import { FakeSmtp } from './fake-smtp.js';
import { testConfig } from './harness.js';

const REQUEST = {
  envelope: { from: 'me@example.net', to: ['anna@example.net'] },
  raw: Buffer.from('Subject: hi\r\n\r\nbody\r\n'),
};

describe('SmtpClient', () => {
  it('refuses to connect until the configuration is complete', async () => {
    const config = testConfig();
    config.smtp.host = undefined;
    const smtp = new FakeSmtp();
    const client = new SmtpClient(config, () => smtp);
    await expect(client.verify()).rejects.toThrow(/SMTP_HOST/);
    // Not even the transport was created, so nothing was dialled.
    expect(smtp.calls).toHaveLength(0);
  });

  it('reuses one connection across calls', async () => {
    let created = 0;
    const smtp = new FakeSmtp();
    const client = new SmtpClient(testConfig(), () => {
      created += 1;
      return smtp;
    });
    await client.verify();
    await client.send(REQUEST);
    expect(created).toBe(1);
  });

  it('creates the transport lazily, so the server starts without credentials', () => {
    let created = 0;
    new SmtpClient(testConfig(), () => {
      created += 1;
      return new FakeSmtp();
    });
    expect(created).toBe(0);
  });

  it('reports a partial delivery rather than calling it a success', async () => {
    const smtp = new FakeSmtp();
    smtp.rejects.add('bob@example.net');
    const client = new SmtpClient(testConfig(), () => smtp);
    const outcome = await client.send({
      envelope: {
        from: 'me@example.net',
        to: ['anna@example.net', 'bob@example.net'],
      },
      raw: REQUEST.raw,
    });
    expect(outcome.accepted).toEqual(['anna@example.net']);
    expect(outcome.rejected).toEqual(['bob@example.net']);
  });

  it('treats "no recipient accepted" as a failure', async () => {
    // Reporting it as success would tell the user their message reached people
    // it did not.
    const smtp = new FakeSmtp();
    smtp.rejects.add('anna@example.net');
    const client = new SmtpClient(testConfig(), () => smtp);
    await expect(client.send(REQUEST)).rejects.toThrow(
      /accepted no recipients/
    );
  });

  it('wraps a transport failure with the action that was attempted', async () => {
    const smtp = new FakeSmtp();
    smtp.failNext = Object.assign(new Error('socket closed'), {
      code: 'ESOCKET',
    });
    const client = new SmtpClient(testConfig(), () => smtp);
    await expect(client.send(REQUEST)).rejects.toThrow(/sending the message/);
  });

  it('closes and forgets the connection', async () => {
    const smtp = new FakeSmtp();
    let created = 0;
    const client = new SmtpClient(testConfig(), () => {
      created += 1;
      return smtp;
    });
    await client.verify();
    client.close();
    expect(smtp.closed).toBe(true);
    await client.verify();
    expect(created).toBe(2);
  });

  it('closes cleanly when nothing was ever opened', () => {
    expect(() =>
      new SmtpClient(testConfig(), () => new FakeSmtp()).close()
    ).not.toThrow();
  });
});

describe('transportOptions', () => {
  const smtp = (overrides: Record<string, unknown> = {}) => ({
    ...testConfig().smtp,
    ...overrides,
  });

  it('requires STARTTLS rather than upgrading opportunistically', () => {
    // Left to nodemailer's default, STARTTLS is attempted when offered and
    // skipped when not — so stripping the capability from EHLO yields a
    // cleartext session silently. requireTLS makes that a failed connection.
    const options = transportOptions(smtp({ tls: 'starttls' }));
    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBe(true);
    expect(options.ignoreTLS).toBe(false);
  });

  it('uses implicit TLS without asking for an upgrade', () => {
    const options = transportOptions(smtp({ tls: 'implicit' }));
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBe(false);
  });

  it('means none when it says none', () => {
    // A mode whose behaviour depends on what the peer offers is a mode nobody
    // can reason about.
    const options = transportOptions(smtp({ tls: 'none' }));
    expect(options.secure).toBe(false);
    expect(options.ignoreTLS).toBe(true);
  });

  it('never disables certificate checking unless asked', () => {
    expect(transportOptions(smtp()).tls).toBeUndefined();
    expect(transportOptions(smtp({ insecureTls: true })).tls).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('keeps the SMTP dialogue off stdout, which the protocol owns', () => {
    const options = transportOptions(smtp());
    expect(options.logger).toBe(false);
    expect(options.debug).toBe(false);
  });

  it('greets with the sender domain, not the machine hostname', () => {
    // The EHLO name travels in a Received header on every message sent, so the
    // default would publish an internal hostname to every recipient.
    expect(transportOptions(smtp()).name).toBe('example.net');
    expect(transportOptions(smtp({ fromAddress: undefined })).name).toBe(
      'localhost'
    );
  });

  it('bounds every phase of the connection', () => {
    const options = transportOptions(smtp());
    expect(options.connectionTimeout).toBeGreaterThan(0);
    expect(options.greetingTimeout).toBeGreaterThan(0);
    expect(options.socketTimeout).toBeGreaterThan(0);
  });

  it('omits auth entirely when there are no credentials', () => {
    expect(
      transportOptions(smtp({ user: undefined, password: undefined })).auth
    ).toBeUndefined();
  });

  it('builds a usable connection object without opening a socket', () => {
    const connection = createSmtpConnection(smtp());
    expect(typeof connection.verify).toBe('function');
    expect(typeof connection.send).toBe('function');
    connection.close();
  });
});

describe('asSmtpError', () => {
  it('keeps the code and the server reply', () => {
    const error = asSmtpError(
      {
        code: 'EAUTH',
        response: '535 Invalid login',
        message: 'Invalid login',
      },
      'sending the message'
    );
    expect(error).toBeInstanceOf(SmtpError);
    expect(error.code).toBe('EAUTH');
    expect(error.responseText).toBe('535 Invalid login');
    expect(error.message).toMatch(/sending the message failed/);
  });

  it('does not copy the command, which for an AUTH holds the credentials', () => {
    const error = asSmtpError(
      {
        code: 'EAUTH',
        message: 'Invalid login',
        command: 'AUTH PLAIN AG1lQGV4YW1wbGUubmV0AHNlY3JldA==',
      } as never,
      'sending the message'
    );
    const serialised = `${error.message} ${error.responseText}`;
    expect(serialised).not.toContain('AUTH PLAIN');
    expect(serialised).not.toContain('AG1lQGV4YW1wbGUubmV0AHNlY3JldA==');
  });

  it('passes an SmtpError through unchanged', () => {
    const original = new SmtpError('already wrapped', 'EAUTH');
    expect(asSmtpError(original, 'x')).toBe(original);
  });

  it('copes with something that is not an error object at all', () => {
    const error = asSmtpError('plain string', 'connecting');
    expect(error.code).toBeUndefined();
    expect(error.message).toContain('connecting failed');
  });
});
