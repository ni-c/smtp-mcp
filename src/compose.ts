import { randomUUID } from 'node:crypto';

import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import type { LoadedAttachment } from './attachments.js';
import type { Config } from './config.js';
import { ToolInputError } from './errors.js';
import { htmlToText, sanitizeHtml } from './sanitize.js';

export interface MessageInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html?: string | undefined;
  /** Original text quoted below the body, for a reply or a forward. */
  quote?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachments: LoadedAttachment[];
  /** Injected by the tests; real calls stamp the current time. */
  date?: Date | undefined;
  /** Injected by the tests; real calls generate one. */
  messageId?: string | undefined;
}

/** How many distinct removals are named before the rest is counted instead. */
const MAX_REMOVALS_SHOWN = 20;

/**
 * The removal list, bounded.
 *
 * Each entry names the scheme the caller wrote before a colon, so the number of
 * entries is chosen by whoever wrote the HTML: 4260 distinct schemes in a 64 kB
 * part produced 4260 entries, which then travelled twice — once in the text
 * block and once in `structuredContent`. The individual entry was already
 * capped; the count was not, and a per-item cap without a total is only half a
 * budget. What is dropped is said rather than left out.
 */
function summariseRemovals(removed: readonly string[]): string[] {
  if (removed.length <= MAX_REMOVALS_SHOWN) return [...removed];
  return [
    ...removed.slice(0, MAX_REMOVALS_SHOWN),
    `… and ${removed.length - MAX_REMOVALS_SHOWN} further removals not listed`,
  ];
}

export interface ComposedMessage {
  /** The complete RFC 5322 message, exactly as it will be handed to the server. */
  raw: Buffer;
  /**
   * The SMTP envelope, built from the validated address lists rather than read
   * back out of the headers.
   *
   * This is the second lock on recipient control. Every address here has been
   * through the schema, the allowlist and the count limit; delivery follows the
   * envelope, not the To header, so even a message whose headers were somehow
   * mangled cannot reach anyone who is not on this list.
   */
  envelope: { from: string; to: string[] };
  messageId: string;
  bytes: number;
  /** What `sanitizeHtml` took out, so the sender is told rather than surprised. */
  htmlRemoved: string[];
  /**
   * The bodies as they went into the message.
   *
   * Kept so `preview_mail` can show them without re-deriving them — a preview
   * assembled a second way is a preview of something else. The raw message
   * carries the same text, but base64-encoded and folded, which is unreadable
   * and would spend the whole result budget on an attachment payload.
   */
  textBody: string;
  htmlBody: string | undefined;
}

/**
 * A CRLF is only legal in a header when the next line starts with whitespace —
 * that is folding. Anything else ends the header and starts a new one, which is
 * exactly the injection this guards against. The schemas reject line breaks
 * already; this is the second lock on the same door.
 */
function assertHeaderSafe(name: string, value: string): void {
  if (/\r(?!\n)|(?<!\r)\n|\r\n(?![ \t])|\0/.test(value)) {
    throw new ToolInputError(
      `smtp-mcp: the ${name} header must not contain line breaks.`
    );
  }
}

/**
 * One address, one RCPT.
 *
 * `addressParam` already guarantees this — the local part is a dot-atom, so it
 * cannot contain a separator. This is the second lock on the same door, and it
 * exists because the door was open: a comma in a local part passed the
 * allowlist as one address (the domain was allowlisted) and then nodemailer's
 * own parser split it into two RCPT commands, the second of which no check had
 * ever seen. If the schema is ever loosened, delivery must fail here rather
 * than quietly address somebody nobody approved.
 */
function assertSingleRecipient(address: string): void {
  if (/[,;<>:()[\]\\"\s]/.test(address)) {
    throw new ToolInputError(
      `smtp-mcp: "${address}" is not a single recipient address — it contains ` +
        'a character that a mail server would read as a separator.'
    );
  }
}

/** Wraps a Message-ID in angle brackets if it does not have them already. */
export function normalizeMessageId(value: string): string {
  const bare = value.trim().replace(/^<|>$/g, '');
  return `<${bare}>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Quoted-reply convention: every line of the original prefixed with "> ". */
function quoteText(quote: string): string {
  return quote
    .split(/\r?\n/)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function buildTextBody(input: MessageInput, config: Config): string {
  const parts = [input.body];
  if (input.quote !== undefined && input.quote !== '') {
    parts.push(`\n\n${quoteText(input.quote)}`);
  }
  if (config.signature !== undefined) {
    // The standard signature delimiter. Mail clients hide everything below it
    // when quoting a reply, which is exactly what a signature is for.
    parts.push(`\n\n-- \n${config.signature}`);
  }
  return parts.join('');
}

function buildHtmlBody(
  input: MessageInput,
  config: Config,
  cleaned: string
): string {
  const parts = [cleaned];
  if (input.quote !== undefined && input.quote !== '') {
    parts.push(
      `\n<blockquote>${escapeHtml(input.quote).replace(/\r?\n/g, '<br>\n')}</blockquote>`
    );
  }
  if (config.signature !== undefined) {
    parts.push(
      `\n<div>-- <br>\n${escapeHtml(config.signature).replace(/\r?\n/g, '<br>\n')}</div>`
    );
  }
  return parts.join('');
}

/**
 * Builds the complete message.
 *
 * There is one composition path and both tools use it: `preview_mail` returns
 * what this produces, `send_mail` hands the same bytes to the SMTP server. That
 * is the point — a preview that is assembled differently from the real thing is
 * a preview of something else, and this server asks a human to approve a message
 * on the strength of it.
 */
export async function composeMessage(
  input: MessageInput,
  config: Config,
  version: string
): Promise<ComposedMessage> {
  const from = config.smtp.from;
  const fromAddress = config.smtp.fromAddress;
  if (from === undefined || fromAddress === undefined) {
    throw new ToolInputError(
      'smtp-mcp: no sender address configured — set SMTP_FROM.'
    );
  }

  assertHeaderSafe('From', from);
  assertHeaderSafe('Subject', input.subject);
  for (const address of [...input.to, ...input.cc, ...input.bcc]) {
    assertHeaderSafe('To', address);
    assertSingleRecipient(address);
  }

  let htmlRemoved: string[] = [];
  let html: string | undefined;
  if (input.html !== undefined && input.html !== '') {
    const sanitized = sanitizeHtml(input.html);
    htmlRemoved = summariseRemovals(sanitized.removed);
    html = buildHtmlBody(input, config, sanitized.html);
  }

  // An HTML-only message still gets a text part, derived from the cleaned HTML.
  // A message with no text alternative reads as spam to a fair number of
  // filters and is unreadable in any client configured to refuse HTML.
  const text =
    input.body === '' && html !== undefined
      ? htmlToText(html)
      : buildTextBody(input, config);

  const messageId =
    input.messageId ?? `<${randomUUID()}@${fromAddress.split('@')[1]}>`;

  const composer = new MailComposer({
    from,
    to: input.to,
    ...(input.cc.length > 0 ? { cc: input.cc } : {}),
    ...(input.bcc.length > 0 ? { bcc: input.bcc } : {}),
    subject: input.subject,
    text,
    ...(html === undefined ? {} : { html }),
    date: input.date ?? new Date(),
    messageId,
    ...(input.inReplyTo === undefined
      ? {}
      : { inReplyTo: normalizeMessageId(input.inReplyTo) }),
    ...(input.references === undefined || input.references.length === 0
      ? {}
      : { references: input.references.map(normalizeMessageId) }),
    headers: {
      // Always set, never configurable. It is what lets a postmaster answering
      // "where did this come from" reach an answer without guessing, and a
      // server that can be told to hide its own tracks is a worse server.
      'X-Mailer': `smtp-mcp/${version}`,
    },
    attachments: input.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
    })),
  });

  const raw = await composer.compile().build();

  if (raw.length > config.maxMessageBytes) {
    throw new ToolInputError(
      `smtp-mcp: the composed message is ${raw.length} bytes, over the limit ` +
        `of ${config.maxMessageBytes} (SMTP_MAX_MESSAGE_BYTES). Attachments ` +
        'grow by about a third when encoded.'
    );
  }

  return {
    raw,
    // Bcc appears in the envelope and not in the headers — that is what makes
    // it blind. MailComposer strips the Bcc header on its own; naming the
    // recipients here is what actually delivers to them.
    envelope: {
      from: fromAddress,
      to: [...input.to, ...input.cc, ...input.bcc],
    },
    messageId,
    bytes: raw.length,
    htmlRemoved,
    textBody: text,
    htmlBody: html,
  };
}
