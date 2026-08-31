import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { audit } from '../src/audit.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('audit', () => {
  it('writes one line to stderr, the channel the model never reads', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    audit('send_mail', { to: ['anna@example.net'], bytes: 512 });
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toMatch(
      /^smtp-mcp audit \d{4}-\d{2}-\d{2}T[\d:.]+Z send_mail to=\[anna@example\.net\] bytes=512$/
    );
  });

  it('omits fields that are not set rather than printing undefined', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    audit('send_mail', { to: ['a@example.net'], bcc: undefined });
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('bcc');
  });

  it('quotes a value containing spaces so the line stays parseable', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    audit('send_mail', { subject: 'Quarterly report', bytes: 1 });
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain('subject="Quarterly report"');
    expect(line).toContain('bytes=1');
  });

  it('abbreviates a long recipient list so one call cannot flood the log', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    audit('send_mail', {
      to: Array.from({ length: 30 }, (_, i) => `a${i}@example.net`),
    });
    expect(String(errors.mock.calls[0]?.[0])).toContain(',…+10]');
  });

  it('appends the same line to the configured file', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'smtp-mcp-audit-'));
    const path = join(directory, 'audit.log');
    audit('send_mail', { to: ['anna@example.net'] }, path);
    audit('reply_mail', { to: ['bob@example.net'] }, path);
    const contents = await readFile(path, 'utf8');
    expect(contents.trimEnd().split('\n')).toHaveLength(2);
    expect(contents).toContain('send_mail');
    expect(contents).toContain('reply_mail');
  });

  it('creates the audit file readable only by its owner', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'smtp-mcp-audit-'));
    const path = join(directory, 'audit.log');
    audit('send_mail', { to: ['anna@example.net'] }, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('warns but does not throw when the file cannot be written', () => {
    // The message has already been sent by the time this runs. Throwing would
    // report a delivered message as failed, which is the one wrong answer.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      audit(
        'send_mail',
        { to: ['a@example.net'] },
        '/nonexistent-dir/audit.log'
      )
    ).not.toThrow();
    const said = errors.mock.calls.flat().map(String).join(' ');
    expect(said).toContain('SMTP_AUDIT_LOG');
    expect(said).toContain('smtp-mcp audit');
  });
});
