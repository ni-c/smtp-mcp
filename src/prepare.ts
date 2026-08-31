import { createHash } from 'node:crypto';

import { detectSuspicious } from './analyze.js';
import { loadAttachments, type LoadedAttachment } from './attachments.js';
import { composeMessage, type ComposedMessage } from './compose.js';
import type { Config } from './config.js';
import { ToolInputError } from './errors.js';
import { refusedRecipients } from './recipients.js';

/** The arguments every message-shaped tool accepts, after zod validation. */
export interface MailArgs {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  html?: string | undefined;
  quote?: string | undefined;
  in_reply_to?: string | undefined;
  references?: string[] | undefined;
  attachments?: string[] | undefined;
  /** Test seams; real calls leave these unset. */
  date?: Date | undefined;
  message_id?: string | undefined;
}

export interface PreparedMessage {
  composed: ComposedMessage;
  to: string[];
  cc: string[];
  bcc: string[];
  /** Every address the message will reach, in envelope order. */
  all: string[];
  attachments: LoadedAttachment[];
  /**
   * Injection shapes found in the quoted original. A signal for the human
   * approving the send, never a reason to refuse or to alter the quote.
   */
  suspiciousQuote: string[];
}

/**
 * Everything that happens to a message before anyone is asked to approve it.
 *
 * `preview_mail` and the three sending tools share this function on purpose. A
 * preview that took a different path would be a preview of something else, and
 * a check that only the sending tools ran would be a check the preview quietly
 * lacked.
 *
 * The order is the interesting part, and each step names the variable that
 * caused it:
 *
 *  1. **Recipients against the allowlist**, before anything is read from disk
 *     or composed. A refused message should cost nothing and leak nothing —
 *     in particular it should not report whether an attachment exists.
 *  2. **Recipient count**, so a message to a thousand people is refused as a
 *     list rather than discovered one address at a time.
 *  3. **Attachments**, each of which is a filesystem read and a policy check.
 *  4. **Composition**, which enforces the total size.
 *
 * The rate limit and the human confirmation come after this, in the sending
 * tools — they are about the act of sending, and the preview does neither.
 */
export async function prepareMessage(
  args: MailArgs,
  config: Config,
  version: string
): Promise<PreparedMessage> {
  const to = args.to;
  const cc = args.cc ?? [];
  const bcc = args.bcc ?? [];
  const all = [...to, ...cc, ...bcc];

  const refused = refusedRecipients(all, config.allowedRecipients);
  if (refused.length > 0) {
    throw new ToolInputError(
      `smtp-mcp: refused — ${refused.length} recipient(s) are not covered by ` +
        `SMTP_ALLOWED_RECIPIENTS: ${refused.join(', ')}. Nothing was sent.`
    );
  }

  // Duplicates are not an error — a person legitimately appears in To and Cc
  // of a thread — so they count once here and are deduplicated in the envelope
  // below, which is what stops the server delivering two copies.
  const distinct = new Set(all.map((address) => address.toLowerCase()));
  if (distinct.size > config.maxRecipients) {
    throw new ToolInputError(
      `smtp-mcp: ${distinct.size} distinct recipients across To, Cc and Bcc, ` +
        `over the limit of ${config.maxRecipients} (SMTP_MAX_RECIPIENTS). ` +
        'Nothing was sent.'
    );
  }

  const attachments = await loadAttachments(args.attachments ?? [], {
    directory: config.attachmentDir,
    allowedTypes: config.allowedAttachmentTypes,
    maxBytes: config.maxAttachmentBytes,
  });

  const composed = await composeMessage(
    {
      to,
      cc,
      bcc,
      subject: args.subject,
      body: args.body,
      html: args.html,
      quote: args.quote,
      inReplyTo: args.in_reply_to,
      references: args.references,
      attachments,
      date: args.date,
      messageId: args.message_id,
    },
    config,
    version
  );

  return {
    composed: {
      ...composed,
      envelope: {
        from: composed.envelope.from,
        to: [...new Set(composed.envelope.to)],
      },
    },
    to,
    cc,
    bcc,
    all,
    attachments,
    suspiciousQuote:
      args.quote === undefined || args.quote === ''
        ? []
        : detectSuspicious(args.quote),
  };
}

/**
 * Binds a confirmation to this exact message.
 *
 * Recipients *and* content: without the content digest an approval for "the
 * quarterly report to the team" could be spent on a different message to the
 * same team, which is the same hole the recipient fingerprint closes in the
 * other direction. Hashed rather than included, because the key is compared,
 * never read, and a body does not belong in a map key.
 *
 * Computed from the **arguments**, deliberately not from the composed bytes.
 * Every composition stamps a fresh `Date` and a random `Message-ID`, so a
 * digest of the message would differ between the call that issues the token and
 * the call that redeems it — the gate would reject every second call and there
 * would be no way to send anything at all. What has to be stable across those
 * two calls is what the caller asked for, and that is what is hashed.
 */
export function messageFingerprint(args: MailArgs, all: string[]): string[] {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        args.subject,
        args.body,
        args.html ?? '',
        args.quote ?? '',
        args.in_reply_to ?? '',
        args.references ?? [],
        args.attachments ?? [],
      ])
    )
    .digest('hex')
    .slice(0, 32);
  return [...all, `content:${digest}`];
}
