import { randomUUID } from 'node:crypto';

import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import type { LoadedAttachment } from './attachments.js';
import type { Config } from './config.js';
import { ToolInputError } from './errors.js';
import { composeBodies, type BodyFormat } from './compose-body.js';

export interface MessageInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  format: BodyFormat;
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
  /** What rendering the Markdown changed, in compose-body's words. */
  bodyNotes: string[];
  /** Every link destination in the HTML part: caller text, shown in the dialog. */
  bodyLinks: string[];
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

  const replyTo = config.smtp.replyTo;

  assertHeaderSafe('From', from);
  if (replyTo !== undefined) assertHeaderSafe('Reply-To', replyTo);
  assertHeaderSafe('Subject', input.subject);
  for (const address of [...input.to, ...input.cc, ...input.bcc]) {
    assertHeaderSafe('To', address);
    assertSingleRecipient(address);
  }

  // The text part is always the caller's body; an HTML part exists only as a
  // rendering of it, so the two cannot say different things.
  const bodies = composeBodies({
    body: input.body,
    format: input.format,
    quote: input.quote,
    signature: config.signature,
  });
  const text = bodies.text;
  const html = bodies.html;

  const messageId =
    input.messageId ?? `<${randomUUID()}@${fromAddress.split('@')[1]}>`;

  const composer = new MailComposer({
    from,
    // A header and only a header. It does not join the envelope below and it is
    // not checked against the allowlist, because it addresses nothing this
    // server will contact: it is an instruction to the recipient's mail client
    // about where *they* should write. The allowlist governs who this server
    // writes to, and a Reply-To does not make it write anywhere.
    ...(replyTo === undefined ? {} : { replyTo }),
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
    bodyNotes: bodies.notes,
    bodyLinks: bodies.links,
    textBody: text,
    htmlBody: html,
  };
}
