import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  allowedExtensions,
  loadAttachment,
  loadAttachments,
  sanitizeFilename,
  sniffExecutable,
  type AttachmentPolicy,
} from '../src/attachments.js';
import { DEFAULT_ATTACHMENT_TYPES } from '../src/config.js';
import { ToolInputError } from '../src/errors.js';

let directory: string;
let policy: AttachmentPolicy;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'smtp-mcp-attach-'));
  policy = {
    directory,
    allowedTypes: DEFAULT_ATTACHMENT_TYPES,
    maxBytes: 1024,
  };
  await writeFile(join(directory, 'report.pdf'), '%PDF-1.7\nhello');
  await writeFile(join(directory, 'notes.txt'), 'plain text');
});

afterEach(() => {
  // Left in the OS temp directory on purpose: these are a few hundred bytes,
  // and a failed test is much easier to diagnose with its fixture still there.
  directory = '';
});

describe('loadAttachment', () => {
  it('reads a file and types it from its extension', async () => {
    const loaded = await loadAttachment('report.pdf', policy);
    expect(loaded.filename).toBe('report.pdf');
    expect(loaded.contentType).toBe('application/pdf');
    expect(loaded.content.toString()).toContain('%PDF-1.7');
    expect(loaded.bytes).toBe(14);
  });

  it('is unavailable until SMTP_ATTACHMENT_DIR is set', async () => {
    await expect(
      loadAttachment('report.pdf', { ...policy, directory: undefined })
    ).rejects.toThrow(/SMTP_ATTACHMENT_DIR/);
  });

  it('refuses a traversal, an absolute path and a subdirectory', async () => {
    for (const name of [
      '../secrets.txt',
      '../../etc/passwd',
      '/etc/passwd',
      'sub/notes.txt',
      'sub\\notes.txt',
    ]) {
      await expect(loadAttachment(name, policy)).rejects.toThrow(
        ToolInputError
      );
    }
  });

  it('refuses a dotfile', async () => {
    await writeFile(join(directory, '.env'), 'TOKEN=secret');
    await expect(loadAttachment('.env', policy)).rejects.toThrow(/dot/);
  });

  it('refuses a name containing a line break', async () => {
    await expect(loadAttachment('a\r\nb.txt', policy)).rejects.toThrow(
      ToolInputError
    );
  });

  it('refuses a symlink, even one pointing inside the directory', async () => {
    // The value of naming a directory is that its contents were put there on
    // purpose. A link is a way for that to stop being true.
    await symlink('/etc/passwd', join(directory, 'link.txt'));
    await expect(loadAttachment('link.txt', policy)).rejects.toThrow(
      /symbolic link/
    );
  });

  it('refuses a directory', async () => {
    await mkdir(join(directory, 'folder.txt'));
    await expect(loadAttachment('folder.txt', policy)).rejects.toThrow(
      /not a regular file/
    );
  });

  it('refuses an executable extension', async () => {
    await writeFile(join(directory, 'setup.sh'), 'echo hi');
    await expect(loadAttachment('setup.sh', policy)).rejects.toThrow(
      /executable file type/
    );
  });

  it('refuses a file with no extension at all', async () => {
    await writeFile(join(directory, 'README'), 'text');
    await expect(loadAttachment('README', policy)).rejects.toThrow(
      /no file extension/
    );
  });

  it('refuses a type outside the allowlist, naming the variable', async () => {
    await expect(
      loadAttachment('notes.txt', {
        ...policy,
        allowedTypes: ['application/pdf'],
      })
    ).rejects.toThrow(/SMTP_ATTACHMENT_TYPES/);
  });

  it('refuses a file over the size limit, naming the variable', async () => {
    await writeFile(join(directory, 'big.txt'), 'x'.repeat(2000));
    await expect(loadAttachment('big.txt', policy)).rejects.toThrow(
      /SMTP_MAX_ATTACHMENT_BYTES/
    );
  });

  it('refuses an executable renamed to a document extension', async () => {
    // The extension allowlist and the magic bytes are two independent opinions
    // about what the file is; both have to agree.
    await writeFile(
      join(directory, 'invoice.pdf'),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])
    );
    await expect(loadAttachment('invoice.pdf', policy)).rejects.toThrow(
      /contents are application\/x-elf/
    );
  });

  it('names the missing file rather than the directory', async () => {
    await expect(loadAttachment('absent.pdf', policy)).rejects.toThrow(
      /absent\.pdf.*no such file/s
    );
  });
});

describe('loadAttachments', () => {
  it('loads several in the order given', async () => {
    const loaded = await loadAttachments(['report.pdf', 'notes.txt'], policy);
    expect(loaded.map((a) => a.filename)).toEqual(['report.pdf', 'notes.txt']);
  });

  it('refuses the whole set when one file fails', async () => {
    await expect(
      loadAttachments(['report.pdf', 'absent.pdf'], policy)
    ).rejects.toThrow(/absent\.pdf/);
  });

  it('caps how many files one message may carry', async () => {
    await expect(
      loadAttachments(
        Array.from({ length: 11 }, () => 'notes.txt'),
        policy
      )
    ).rejects.toThrow(/at most 10 attachments/);
  });

  it('accepts an empty list without touching the filesystem', async () => {
    expect(
      await loadAttachments([], { ...policy, directory: undefined })
    ).toEqual([]);
  });
});

describe('sniffExecutable', () => {
  it('recognises the formats that matter', () => {
    expect(sniffExecutable(Buffer.from([0x4d, 0x5a]))).toBe(
      'application/x-msdownload'
    );
    expect(sniffExecutable(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(
      'application/x-elf'
    );
    expect(sniffExecutable(Buffer.from([0x23, 0x21, 0x2f, 0x62]))).toBe(
      'text/x-shellscript'
    );
    // 0xfeedface only matches when the shift result is read as unsigned.
    expect(sniffExecutable(Buffer.from([0xfe, 0xed, 0xfa, 0xce]))).toBe(
      'application/x-mach-binary'
    );
  });

  it('leaves ordinary documents alone', () => {
    expect(sniffExecutable(Buffer.from('%PDF-1.7'))).toBeUndefined();
    expect(sniffExecutable(Buffer.from('hello'))).toBeUndefined();
    expect(sniffExecutable(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('sanitizeFilename', () => {
  it('replaces separators and strips invisible characters', () => {
    expect(sanitizeFilename('a/b\\c.txt')).toBe('a_b_c.txt');
    // Written as an escape on purpose: a literal zero-width space here would
    // be invisible to the next person reading this test.
    expect(sanitizeFilename('inv\u200boice.pdf')).toBe('invoice.pdf');
  });

  it('defuses markdown image syntax in a name', () => {
    expect(sanitizeFilename('![](https://x.example/p.gif)')).not.toContain(
      ']('
    );
  });

  it('never returns an empty string', () => {
    expect(sanitizeFilename('   ')).toBe('(unnamed)');
  });
});

describe('allowedExtensions', () => {
  it('lists what the configured types actually permit', () => {
    expect(allowedExtensions(['application/pdf'])).toEqual(['pdf']);
    expect(allowedExtensions(DEFAULT_ATTACHMENT_TYPES)).toContain('docx');
  });

  it('never lists an executable extension', () => {
    expect(allowedExtensions(DEFAULT_ATTACHMENT_TYPES)).not.toContain('js');
  });
});
