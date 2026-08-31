import { z } from 'zod';

/** Ceiling on how many addresses one message may carry, before the config cap. */
export const MAX_ADDRESSES = 50;
/** Ceiling on a body, before the composed-message cap in `compose.ts`. */
export const MAX_BODY_CHARS = 500_000;

/**
 * A single email address.
 *
 * Line breaks are refused because a recipient is written into a mail header: a
 * CR here would let the caller append headers of its own — a Bcc, a Reply-To
 * pointing somewhere else — to a message a human thought they had approved.
 * That is the whole attack, and it is cheap to close here.
 *
 * The shape is deliberately narrow: exactly one `@`, a dot in the domain, no
 * whitespace, no display name. Two consequences worth knowing. `Name <a@b.net>`
 * is refused — the display name of a *recipient* is decoration this server does
 * not need, and parsing it correctly means implementing RFC 5322 phrase syntax.
 * And `a@evil.example@corp.example` cannot match, because neither the local
 * part nor the domain may contain a second `@` — which is what stops the oldest
 * trick for getting past an allowlist that splits on the first one.
 */
export const addressParam = z
  .string()
  .min(3)
  .max(320)
  .refine((v) => !/[\r\n\0]/.test(v), 'must not contain line breaks')
  .refine(
    (v) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v),
    'must be a bare email address such as person@example.net, with no display name'
  )
  .describe('A single email address, e.g. person@example.net.');

export const toParam = z
  .array(addressParam)
  .min(1)
  .max(MAX_ADDRESSES)
  .describe(
    'Primary recipients. Every address must pass SMTP_ALLOWED_RECIPIENTS.'
  );

export const ccParam = z
  .array(addressParam)
  .max(MAX_ADDRESSES)
  .optional()
  .describe(
    'Carbon-copy recipients, visible to everyone who receives the message.'
  );

export const bccParam = z
  .array(addressParam)
  .max(MAX_ADDRESSES)
  .optional()
  .describe(
    'Blind carbon-copy recipients. They receive the message but are not listed ' +
      'in it. They are shown separately in the confirmation, count towards ' +
      'SMTP_MAX_RECIPIENTS and must pass SMTP_ALLOWED_RECIPIENTS like any other.'
  );

/**
 * A subject line.
 *
 * Capped at 255 rather than at the 998-octet header limit: anything longer is
 * truncated by the recipient's client anyway, and a subject is one of the two
 * values a human sees in the confirmation dialog. A subject that fills the
 * dialog is a subject that pushes the recipient list off the screen.
 */
export const subjectParam = z
  .string()
  .max(255)
  .refine((v) => !/[\r\n\0]/.test(v), 'must not contain line breaks')
  .describe('Subject line. Must fit on one line.');

export const bodyParam = z
  .string()
  .max(MAX_BODY_CHARS)
  .describe('Plain-text body of the message.');

export const htmlParam = z
  .string()
  .max(MAX_BODY_CHARS)
  .optional()
  .describe(
    'Optional HTML body, sent as multipart/alternative alongside the plain ' +
      'text. Scripts, event handlers, remotely loaded images and unsafe URL ' +
      'schemes are removed; preview_mail reports exactly what was removed.'
  );

/**
 * A Message-ID, with or without the angle brackets.
 *
 * Not validated against RFC 5322 in full — real ones in the wild are stranger
 * than the grammar allows. What is enforced is what matters here: no
 * whitespace, no line break, no nested angle brackets, bounded length. Those
 * are the properties that keep it inside the header it is written into.
 */
export const messageIdParam = z
  .string()
  .min(3)
  .max(256)
  .refine(
    (v) => !/[\s<>\0]/.test(v.replace(/^<|>$/g, '')),
    'must be a single Message-ID'
  )
  .refine((v) => v.includes('@'), 'must contain @, like <abc123@example.net>')
  .describe(
    'Message-ID of the message being answered, e.g. "<abc123@example.net>". ' +
      'Take it verbatim from the original.'
  );

export const referencesParam = z
  .array(messageIdParam)
  .max(50)
  .optional()
  .describe(
    'The References chain of the original, oldest first. Pass it through ' +
      'unchanged so mail clients thread the reply correctly.'
  );

export const quoteParam = z
  .string()
  .max(MAX_BODY_CHARS)
  .optional()
  .describe(
    'The original message text to quote below the reply. It is included ' +
      'verbatim; if it contains instruction-like passages, the confirmation ' +
      'says so rather than altering it.'
  );

export const attachmentsParam = z
  .array(
    z
      .string()
      .min(1)
      .max(255)
      .describe(
        'File name inside SMTP_ATTACHMENT_DIR, without any directory part.'
      )
  )
  .max(10)
  .optional()
  .describe(
    'Files to attach, named relative to SMTP_ATTACHMENT_DIR. Attachments are ' +
      'unavailable unless that variable is set.'
  );

export const confirmTokenParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Confirmation token from a previous call of this tool with the same arguments. Omit on the first call.'
  );
