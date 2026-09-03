import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import { defuseAutoFetch, stripInvisible } from './analyze.js';
import { ToolInputError } from './errors.js';

/** Upper bound on how many files one message may carry. */
export const MAX_ATTACHMENTS = 10;
const MAX_FILENAME_LENGTH = 120;

/**
 * Extensions that are executable somewhere.
 *
 * In a reading server this list keeps a stranger's payload off the disk. Here
 * it points the other way: it keeps this server from becoming the thing that
 * mails an executable out of the operator's machine under their own name and
 * their own DKIM signature. That is worse than receiving one, because it is
 * trusted on arrival.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'ade',
  'adp',
  'app',
  'appimage',
  'application',
  'appref-ms',
  'asp',
  'aspx',
  'bas',
  'bat',
  'cer',
  'chm',
  'cmd',
  'com',
  'cpl',
  'crt',
  'csh',
  'deb',
  'dll',
  'dmg',
  'exe',
  'fxp',
  'gadget',
  'hlp',
  'hta',
  'inf',
  'ins',
  'iso',
  'isp',
  'its',
  'jar',
  'js',
  'jse',
  'ksh',
  'lnk',
  'mad',
  'maf',
  'mag',
  'mam',
  'maq',
  'mar',
  'mas',
  'mat',
  'mau',
  'mav',
  'maw',
  'mda',
  'mdb',
  'mde',
  'mdt',
  'mdw',
  'mdz',
  'msc',
  'msh',
  'msh1',
  'msh2',
  'mshxml',
  'msi',
  'msp',
  'mst',
  'ops',
  'pcd',
  'pif',
  'pkg',
  'pl',
  'plg',
  'prf',
  'prg',
  'ps1',
  'ps2',
  'psc1',
  'psc2',
  'py',
  'pyc',
  'pyo',
  'rb',
  'reg',
  'rpm',
  'scf',
  'scr',
  'sct',
  'sh',
  'shb',
  'shs',
  'url',
  'vb',
  'vbe',
  'vbs',
  'vsmacros',
  'vsw',
  'ws',
  'wsc',
  'wsf',
  'wsh',
  'xll',
]);

/** Extension to content type, for the types this server is willing to send. */
const EXTENSION_TYPES: ReadonlyMap<string, string> = new Map([
  ['pdf', 'application/pdf'],
  ['json', 'application/json'],
  ['xml', 'application/xml'],
  ['zip', 'application/zip'],
  ['rtf', 'application/rtf'],
  ['odt', 'application/vnd.oasis.opendocument.text'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  [
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['txt', 'text/plain'],
  ['md', 'text/plain'],
  ['log', 'text/plain'],
  ['csv', 'text/csv'],
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['ics', 'text/calendar'],
]);

export interface AttachmentPolicy {
  directory: string | undefined;
  allowedTypes: readonly string[];
  maxBytes: number;
}

export interface LoadedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  bytes: number;
}

/** Strips a filename down to something safe to print and to reason about. */
export function sanitizeFilename(raw: string): string {
  const cleaned = defuseAutoFetch(stripInvisible(raw.normalize('NFKC')))
    .replace(/[/\\]/g, '_')
    .trim();
  if (cleaned === '') return '(unnamed)';
  return cleaned.length > MAX_FILENAME_LENGTH
    ? `${cleaned.slice(0, MAX_FILENAME_LENGTH)}…`
    : cleaned;
}

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Rejects a name that is anything other than a plain file name.
 *
 * The caller names a file; it does not name a path. Every separator form is
 * refused rather than normalised away, because "normalise then check" is the
 * shape that keeps producing traversal bugs — and a caller with a legitimate
 * file in a subdirectory can be given a second attachment directory.
 */
function assertPlainFilename(name: string): void {
  if (name !== basename(name) || name.includes('/') || name.includes('\\')) {
    throw new ToolInputError(
      `smtp-mcp: "${sanitizeFilename(name)}" must be a plain file name, not a ` +
        'path. Attachments are read from SMTP_ATTACHMENT_DIR only.'
    );
  }
  if (name === '.' || name === '..' || name.startsWith('.')) {
    throw new ToolInputError(
      'smtp-mcp: attachment names must not start with a dot.'
    );
  }
  if (/[\r\n\0]/.test(name)) {
    throw new ToolInputError(
      'smtp-mcp: attachment names must not contain line breaks.'
    );
  }
}

/**
 * Identifies content by its leading bytes.
 *
 * The extension is a claim by the caller; this is the only check that looks at
 * what is actually in the file. One guard is not a guard: a compiled binary
 * copied to `report.pdf` passes the extension allowlist and fails here.
 */
export function sniffExecutable(buffer: Buffer): string | undefined {
  const byte = (i: number): number => buffer[i] ?? -1;

  if (byte(0) === 0x4d && byte(1) === 0x5a) return 'application/x-msdownload';
  if (
    byte(0) === 0x7f &&
    byte(1) === 0x45 &&
    byte(2) === 0x4c &&
    byte(3) === 0x46
  ) {
    return 'application/x-elf';
  }
  // `>>> 0` is load-bearing: JS bitwise operators produce a *signed* 32-bit
  // result, so without it 0xfeedface arrives as a negative number and none of
  // the Mach-O comparisons can ever match.
  const magic32 =
    ((byte(0) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3)) >>> 0;
  if (
    magic32 === 0xfeedface ||
    magic32 === 0xfeedfacf ||
    magic32 === 0xcafebabe
  ) {
    return 'application/x-mach-binary';
  }
  if (byte(0) === 0x23 && byte(1) === 0x21) return 'text/x-shellscript';
  return undefined;
}

/**
 * Reads one attachment out of the configured directory.
 *
 * Everything here exists because this is the point where bytes from the
 * operator's disk get an addressee:
 *
 * - The directory comes only from `SMTP_ATTACHMENT_DIR`. A caller — and
 *   therefore a message that talked the model into a tool call — cannot choose
 *   which part of the filesystem gets mailed out. Unset means no attachments at
 *   all, which is the default.
 * - The name is checked for separators *and* the resolved path is checked
 *   against the directory, because one guard is not a guard.
 * - Symlinks are refused outright. A link is a way for the contents of the
 *   directory to point somewhere the directory does not control, and the whole
 *   value of naming a directory is that its contents were put there on purpose.
 * - The extension allowlist and the magic bytes are two independent opinions
 *   about what the file is; both have to agree it is not executable.
 */
export async function loadAttachment(
  name: string,
  policy: AttachmentPolicy
): Promise<LoadedAttachment> {
  if (policy.directory === undefined) {
    throw new ToolInputError(
      'smtp-mcp: attachments are disabled. Set SMTP_ATTACHMENT_DIR to the ' +
        'directory this server may read files from.'
    );
  }
  assertPlainFilename(name);

  const base = resolve(policy.directory);
  const target = resolve(join(base, name));
  // assertPlainFilename should already have made this impossible; if it ever
  // stops being true, the read must not be the place where that is discovered.
  if (!target.startsWith(base + sep)) {
    throw new ToolInputError(
      'smtp-mcp: refused to read outside SMTP_ATTACHMENT_DIR.'
    );
  }

  const extension = extensionOf(name);
  if (extension === '' || EXECUTABLE_EXTENSIONS.has(extension)) {
    throw new ToolInputError(
      `smtp-mcp: refused to attach "${sanitizeFilename(name)}" — ` +
        `${extension === '' ? 'it has no file extension' : `.${extension} is an executable file type`}.`
    );
  }
  const contentType = EXTENSION_TYPES.get(extension);
  if (contentType === undefined || !policy.allowedTypes.includes(contentType)) {
    throw new ToolInputError(
      `smtp-mcp: refused to attach "${sanitizeFilename(name)}" — .${extension} ` +
        'is not in the allowlist (SMTP_ATTACHMENT_TYPES).'
    );
  }

  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    throw new ToolInputError(
      `smtp-mcp: could not read "${sanitizeFilename(name)}" from ` +
        `SMTP_ATTACHMENT_DIR: ${describe(error)}`
    );
  }
  if (stats.isSymbolicLink()) {
    throw new ToolInputError(
      `smtp-mcp: refused to attach "${sanitizeFilename(name)}" — it is a ` +
        'symbolic link, which points outside what SMTP_ATTACHMENT_DIR controls.'
    );
  }
  if (!stats.isFile()) {
    throw new ToolInputError(
      `smtp-mcp: "${sanitizeFilename(name)}" is not a regular file.`
    );
  }
  if (stats.size > policy.maxBytes) {
    throw new ToolInputError(
      `smtp-mcp: "${sanitizeFilename(name)}" is ${stats.size} bytes, over the ` +
        `limit of ${policy.maxBytes} (SMTP_MAX_ATTACHMENT_BYTES).`
    );
  }

  // O_NOFOLLOW closes the window between the lstat above and the open below:
  // without it a link swapped in after the check would still be followed. Not
  // available on every platform, hence the fallback to the plain flags — the
  // lstat is what carries the guarantee there.
  const flags = fsConstants.O_NOFOLLOW
    ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    : fsConstants.O_RDONLY;
  let content: Buffer;
  let handle;
  try {
    handle = await open(target, flags | fsConstants.O_NONBLOCK);
    // The checks above ran on the path; these run on the file that was actually
    // opened, and they are the ones that hold. Between `lstat` and `open`, a
    // writer in the directory — who is in the threat model, which is why the
    // attachment bytes are in the approval fingerprint — can swap the regular
    // file for a FIFO, which a blocking open would wait on forever, or grow it
    // past the ceiling, which an unbounded read would then allocate in full.
    // `O_NONBLOCK` makes the FIFO open return instead of wait; the fstat sees
    // what it is; and the read is capped at the size the fstat reported.
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new ToolInputError(
        `smtp-mcp: "${sanitizeFilename(name)}" is not a regular file.`
      );
    }
    if (opened.size > policy.maxBytes) {
      throw new ToolInputError(
        `smtp-mcp: "${sanitizeFilename(name)}" is ${opened.size} bytes, over ` +
          `the limit of ${policy.maxBytes} (SMTP_MAX_ATTACHMENT_BYTES).`
      );
    }
    content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        opened.size - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // Shorter than the fstat said: the file shrank under us. Send what is
    // there rather than a zero-padded tail.
    if (offset < opened.size) content = content.subarray(0, offset);
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    throw new ToolInputError(
      `smtp-mcp: could not read "${sanitizeFilename(name)}" from ` +
        `SMTP_ATTACHMENT_DIR: ${describe(error)}`
    );
  } finally {
    await handle?.close();
  }

  const executable = sniffExecutable(content);
  if (executable !== undefined) {
    throw new ToolInputError(
      `smtp-mcp: refused to attach "${sanitizeFilename(name)}" — the file ` +
        `declares itself as .${extension} but its contents are ${executable}.`
    );
  }

  return {
    filename: basename(name),
    contentType,
    content,
    bytes: content.length,
  };
}

/** Reads every named attachment, refusing the whole set if one fails. */
export async function loadAttachments(
  names: readonly string[],
  policy: AttachmentPolicy
): Promise<LoadedAttachment[]> {
  if (names.length > MAX_ATTACHMENTS) {
    throw new ToolInputError(
      `smtp-mcp: at most ${MAX_ATTACHMENTS} attachments per message.`
    );
  }
  const loaded: LoadedAttachment[] = [];
  // Sequential rather than Promise.all: the first refusal should name the file
  // that caused it, and a batch of parallel rejections makes that ambiguous.
  for (const name of names) {
    loaded.push(await loadAttachment(name, policy));
  }
  return loaded;
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'ELOOP') return 'it is a symbolic link';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EISDIR') return 'it is a directory';
  return code ?? 'unknown error';
}

/** Names of the extensions this server will attach, for `get_server_info`. */
export function allowedExtensions(allowedTypes: readonly string[]): string[] {
  const extensions: string[] = [];
  for (const [extension, type] of EXTENSION_TYPES) {
    if (allowedTypes.includes(type) && !EXECUTABLE_EXTENSIONS.has(extension)) {
      extensions.push(extension);
    }
  }
  return extensions.sort();
}
