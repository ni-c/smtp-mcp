import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

/**
 * The window between `lstat` and `open`.
 *
 * `lstat` looks at a path; whatever is there a microsecond later is what gets
 * opened. A writer in `SMTP_ATTACHMENT_DIR` is in the threat model — it is why
 * the attachment bytes are part of the approval fingerprint — and such a writer
 * can put something else at the path in that window. So the checks that hold
 * are the ones run on the opened handle, and this file makes the path-based
 * `lstat` lie to prove that the handle-based ones catch what it missed.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: async (path: string) => {
      const stats = await real.lstat(path);
      if (!path.endsWith('.swapped.txt')) return stats;
      // Report what the attacker wants believed: a small regular file.
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        size: 10,
        isFile: () => true,
        isSymbolicLink: () => false,
      });
    },
  };
});

const { loadAttachment } = await import('../src/attachments.js');
const { DEFAULT_ATTACHMENT_TYPES } = await import('../src/config.js');
const { ToolInputError } = await import('../src/errors.js');

async function fixtureDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'smtp-mcp-race-'));
}

describe('checks on the opened file, not the path', () => {
  it('refuses a FIFO swapped in after the stat, without hanging on it', async () => {
    const directory = await fixtureDirectory();
    const target = join(directory, 'fifo.swapped.txt');
    execFileSync('mkfifo', [target]);
    // A blocking open of a FIFO with no writer waits forever; the test's own
    // timeout is the assertion that it does not.
    await expect(
      loadAttachment('fifo.swapped.txt', {
        directory,
        allowedTypes: DEFAULT_ATTACHMENT_TYPES,
        maxBytes: 1024,
      })
    ).rejects.toThrow(/not a regular file/);
  }, 2_000);

  it('refuses a file grown past the ceiling after the stat', async () => {
    const directory = await fixtureDirectory();
    await writeFile(join(directory, 'grown.swapped.txt'), 'x'.repeat(4096));
    await expect(
      loadAttachment('grown.swapped.txt', {
        directory,
        allowedTypes: DEFAULT_ATTACHMENT_TYPES,
        maxBytes: 1024,
      })
    ).rejects.toThrow(ToolInputError);
    await expect(
      loadAttachment('grown.swapped.txt', {
        directory,
        allowedTypes: DEFAULT_ATTACHMENT_TYPES,
        maxBytes: 1024,
      })
    ).rejects.toThrow(/4096 bytes, over the limit/);
  });

  it('still reads an honest file in full', async () => {
    const directory = await fixtureDirectory();
    await writeFile(join(directory, 'honest.txt'), 'plain text');
    const loaded = await loadAttachment('honest.txt', {
      directory,
      allowedTypes: DEFAULT_ATTACHMENT_TYPES,
      maxBytes: 1024,
    });
    expect(loaded.content.toString()).toBe('plain text');
    expect(loaded.bytes).toBe(10);
  });
});
