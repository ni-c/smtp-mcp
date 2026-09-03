import { z } from 'zod';

/** Ceiling on how many addresses one message may carry, before the config cap. */
export const MAX_ADDRESSES = 50;
/** Ceiling on a body, before the composed-message cap in `compose.ts`. */
export const MAX_BODY_CHARS = 500_000;
/**
 * Ceiling on an HTML body, well below the plain-text one.
 *
 * The HTML part is the only body that gets parsed rather than copied, and the
 * removal passes in `sanitize.ts` are regex-based with bounded scan windows.
 * Bounded is not the same as linear: a body full of unclosed tags makes each
 * window run at every position, and at 500 kB that was fourteen seconds of
 * blocked event loop per call — reachable through `preview_mail`, which needs
 * no send gate, no confirmation and no rate limit. The ceiling and the anchored
 * patterns in `sanitize.ts` are two halves of the same fix.
 */
export const MAX_HTML_CHARS = 64_000;

/**
 * Characters that end a line somewhere.
 *
 * CR and LF are the obvious ones — a CR in a recipient would let the caller
 * append headers of its own, a Bcc or a Reply-To pointing elsewhere, to a
 * message a human thought they had approved.
 *
 * The rest are here because of where these strings are rendered. The
 * confirmation dialog puts each caller-supplied value on its own labelled line,
 * and the comment in `confirm.ts` claims that refusing line breaks is what makes
 * that rendering trustworthy. CSS `white-space: pre-wrap` — which is how an
 * Electron MCP client shows that message — treats U+000B, U+000C, U+0085,
 * U+2028 and U+2029 as forced line breaks too. Without them a subject of
 * `Q3 report<U+2028>  To: chef@example.net` shows the human a recipient line the
 * server never wrote, in the one string they are given before a message leaves.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point
const LINE_BREAKS = /[\r\n\u0000\u000b\u000c\u0085\u2028\u2029]/;

/**
 * A single email address.
 *
 * The local part is an RFC 5322 dot-atom and nothing else. That is narrower
 * than it looks and the narrowness is load-bearing: a local part is allowed to
 * contain a comma, and nodemailer re-parses the address when it builds the
 * envelope and splits it there. So `ceo,anna@work.example` passed an allowlist
 * for `@work.example` — `domainOf` sees the one allowed domain — and then went
 * out as **two** RCPT commands, the first of them a bare `ceo` that no check
 * ever saw and that a submission relay qualifies with its own domain. The
 * dialog said one recipient; two were addressed.
 *
 * The domain is ASCII letters, digits, hyphens and dots. Non-ASCII domains
 * could never match the allowlist anyway (`parseAllowlist` only admits ASCII),
 * so refusing them here changes no outcome and removes a whole class of
 * question about what folds onto what.
 *
 * Display names are refused: `Name <a@b.net>` is decoration a *recipient* does
 * not need, and parsing it correctly means implementing RFC 5322 phrase syntax.
 */
const DOT_ATOM = String.raw`[A-Za-z0-9!#$%&'*+/=?^_\`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_\`{|}~-]+)*`;
const DOMAIN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+`;
const ADDRESS = new RegExp(`^${DOT_ATOM}@${DOMAIN}$`);

export const addressParam = z
  .string()
  .min(3)
  .max(320)
  .refine((v) => !LINE_BREAKS.test(v), 'must not contain line breaks')
  .refine(
    (v) => ADDRESS.test(v),
    'must be a bare email address such as person@example.net — no display name, ' +
      'no comma, no angle brackets, and an ASCII domain'
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
  .refine((v) => !LINE_BREAKS.test(v), 'must not contain line breaks')
  // An RFC 2047 encoded-word is pure ASCII on the way out and something else
  // entirely on the way in. `=?utf-8?B?UGF5bWVudCBkZXRhaWxzIGNoYW5nZWQ…?=`
  // shows the human that string, goes on the wire unchanged — MailComposer sees
  // no non-ASCII and leaves it alone — and arrives as "Payment details changed
  // - new IBAN below". The subject is one of only two caller values a person
  // sees before a message leaves, and it must be the one that arrives. Nothing
  // is lost by refusing: a model has no reason to encode a subject itself, and
  // real non-ASCII is encoded correctly during composition.
  .refine(
    (v) => !/=\?[^?]{1,40}\?[BbQq]\?/.test(v),
    'must not contain an RFC 2047 encoded-word such as "=?utf-8?B?…?=" — ' +
      'write the subject as plain text, including any non-ASCII characters; ' +
      'they are encoded correctly on the way out'
  )
  .describe('Subject line. Must fit on one line.');

export const bodyParam = z
  .string()
  .max(MAX_BODY_CHARS)
  .describe('Plain-text body of the message.');

export const htmlParam = z
  .string()
  .max(MAX_HTML_CHARS)
  .optional()
  .describe(
    'Optional HTML body, sent as multipart/alternative alongside the plain ' +
      'text. Scripts, event handlers, remotely loaded images (src, srcset, ' +
      'poster, background) and unsafe URL schemes are removed; preview_mail ' +
      'reports exactly what was removed. Markup that cannot be cleaned with ' +
      'confidence is refused rather than sent.'
  );

/**
 * A Message-ID, with or without the angle brackets.
 *
 * Not validated against RFC 5322 in full — real ones in the wild are stranger
 * than the grammar allows. What is enforced is what matters here: printable
 * ASCII only, no whitespace, no nested angle brackets, bounded length. Those
 * are the properties that keep it inside the header it is written into.
 *
 * Printable ASCII rather than merely "no line breaks": nodemailer encodes
 * every header it writes except `Message-ID`, `In-Reply-To` and `References`,
 * which go out byte for byte. A non-ASCII character here is an 8-bit header
 * on the wire, and U+2028 — not a line break to `\s`-minus-Unicode, but a
 * separator to nodemailer's `References` splitter — quietly turned one
 * identifier into two. A real Message-ID never needs anything outside ASCII.
 */
export const messageIdParam = z
  .string()
  .min(3)
  .max(256)
  .refine(
    (v) => /^[!-;=?-~]+$/.test(v.replace(/^<|>$/g, '')),
    'must be a single Message-ID in printable ASCII without whitespace or angle brackets'
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
