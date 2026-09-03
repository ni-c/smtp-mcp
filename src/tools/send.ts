import type {
  McpServer,
  CallToolResult,
  InputRequiredResult,
  ServerContext,
} from '@modelcontextprotocol/server';
import { setResourceKey } from 'mcp-approval';
import type { ConfirmationDetail, ConfirmationStore } from 'mcp-approval';
import {
  messageFingerprint,
  prepareMessage,
  type MailArgs,
  type PreparedMessage,
} from '../prepare.js';
import {
  attachmentsParam,
  bccParam,
  bodyParam,
  ccParam,
  confirmTokenParam,
  htmlParam,
  messageIdParam,
  quoteParam,
  referencesParam,
  subjectParam,
  toParam,
} from '../schema.js';
import { z } from 'zod';

import { audit } from '../audit.js';
import type { RateLimitSlot } from '../ratelimit.js';
import { ToolInputError } from '../errors.js';
import { jsonResult, run } from '../result.js';
import { htmlToText } from '../sanitize.js';
import type { ToolContext } from './context.js';

const MAX_SUBJECT = 255;

/** `Re:` once, not `Re: Re: Re:`. */
export function replySubject(original: string): string {
  const subject = /^re:\s/i.test(original.trim())
    ? original.trim()
    : `Re: ${original.trim()}`;
  return subject.slice(0, MAX_SUBJECT);
}

/** `Fwd:` once, accepting the `Fw:` and `Fwd:` spellings already in the wild. */
export function forwardSubject(original: string): string {
  const subject = /^(fwd?|fw):\s/i.test(original.trim())
    ? original.trim()
    : `Fwd: ${original.trim()}`;
  return subject.slice(0, MAX_SUBJECT);
}

/** How many entries of a recipient list are shown before it is abbreviated. */
const MAX_SHOWN = 20;

function listFor(addresses: readonly string[]): string {
  return addresses.length > MAX_SHOWN
    ? `${addresses.slice(0, MAX_SHOWN).join(', ')}, … and ${addresses.length - MAX_SHOWN} more`
    : addresses.join(', ');
}

/**
 * The one path by which a message leaves this server.
 *
 * All three sending tools funnel through here, so there is exactly one place
 * where the order of the checks is decided and exactly one place to read when
 * asking "what stands between an injected instruction and an outbound mail".
 *
 * The order matters in two non-obvious ways:
 *
 * - The **rate-limit slot is reserved before the dialog** and only committed
 *   once the server accepts. Reserving matters as much as committing: checking
 *   availability and counting afterwards leaves the whole round trip to the
 *   SMTP server as a window in which concurrent calls all see the same slot
 *   free, and MCP clients issue tool calls in parallel. A declined dialog or a
 *   refused message releases the slot, because sending is what is limited, not
 *   asking.
 * - The **audit line is written after the send**, because it records what
 *   happened rather than what was intended, and a message the server refused
 *   must not appear in the log as one that went out.
 */
async function performSend(
  server: McpServer,
  mcp: ServerContext,
  ctx: ToolContext,
  confirmations: ConfirmationStore,
  tool: string,
  verb: string,
  args: MailArgs,
  confirmToken: string | undefined
): Promise<CallToolResult | InputRequiredResult> {
  const prepared = await prepareMessage(args, ctx.config, ctx.version);
  const resourceKey = setResourceKey(tool, messageFingerprint(args, prepared));

  // At-most-once, before anything else costs anything.
  //
  // A tool call is at-least-once by nature: a client that times out and
  // retries, a host that reconnects mid-flow, a model that repeats itself.
  // Everywhere else in this family that is harmless, because the guarded
  // operation is idempotent. Here the second call reaches a person, and
  // neither copy can be recalled — so the fingerprint the approval is already
  // bound to is remembered, and a repeat is answered rather than sent.
  const already = ctx.sent.find(resourceKey);
  if (already !== undefined) {
    return jsonResult({
      sent: false,
      already_sent: true,
      message_id: already.messageId,
      // The addresses, not a count. Both branches of this tool answer with the
      // same key, and one of them used to put a number where the other put a
      // list — which nothing noticed until the tool had to declare what it
      // returns.
      accepted: already.accepted,
      rejected: [],
      sends_remaining_this_hour: ctx.limiter.remaining(),
      note:
        'This exact message — same recipients, subject, body, quote, HTML and ' +
        `attachments — was already accepted by the SMTP server as ` +
        `${already.messageId}. It was NOT sent a second time, and nobody was ` +
        'asked again. If a second copy really is wanted, change something in ' +
        'the message.',
    });
  }

  const slot = ctx.limiter.reserve();
  try {
    return await withSlot(
      server,
      mcp,
      ctx,
      confirmations,
      tool,
      verb,
      args,
      confirmToken,
      prepared,
      slot,
      resourceKey
    );
  } catch (error) {
    slot.release();
    throw error;
  }
}

async function withSlot(
  server: McpServer,
  mcp: ServerContext,
  ctx: ToolContext,
  confirmations: ConfirmationStore,
  tool: string,
  verb: string,
  args: MailArgs,
  confirmToken: string | undefined,
  prepared: PreparedMessage,
  slot: RateLimitSlot,
  resourceKey: string
): Promise<CallToolResult | InputRequiredResult> {
  const details: ConfirmationDetail[] = [
    {
      label: 'From (fixed by SMTP_FROM)',
      value: ctx.config.smtp.from ?? '(unset)',
    },
    { label: 'To', value: listFor(prepared.to) },
  ];
  if (prepared.cc.length > 0) {
    details.push({ label: 'Cc', value: listFor(prepared.cc) });
  }
  if (prepared.bcc.length > 0) {
    // Its own line, its own wording. A Bcc that a human does not see in the
    // dialog is the ideal exfiltration channel: the message looks like the one
    // they approved, and the extra recipient appears nowhere in it.
    details.push({
      label: 'Bcc (hidden from the other recipients)',
      value: listFor(prepared.bcc),
    });
  }
  details.push({ label: 'Subject', value: args.subject });
  // The message itself, which the dialog used not to show at all.
  //
  // Every other layer bound the *envelope*: the allowlist says who may be
  // written to, the fingerprint ties the approval to these exact recipients,
  // the rate limit caps how many go out. None of them looks at what is written.
  // A model steered by an injected instruction that mails local secrets to an
  // address already on the allowlist passed all three, and the human agreed to
  // a body nobody had read.
  //
  // `mcp-approval` cuts every value to 200 characters and flattens it to one
  // line, so this cannot push the recipients off the screen — and the character
  // count in the label is what makes the part that is *not* shown visible.
  for (const [label, value] of [
    ['Body', args.body],
    ['Quoted original', args.quote],
    ['HTML part', args.html],
  ] as const) {
    if (value === undefined) continue;
    details.push({
      label: `${label} (${value.length} characters)`,
      value: value === '' ? '(empty)' : value,
    });
  }
  if (prepared.composed.htmlBody !== undefined) {
    // The HTML part as the recipient will read it, not as it is written. The
    // first 200 characters of markup are mostly tags, so the line above shows
    // the human almost nothing of what an HTML client will display — and on a
    // message with no plain body, that display *is* the message. The text is
    // derived from the sanitised part, the same way the text/plain alternative
    // is derived when the body is empty.
    const asText = htmlToText(prepared.composed.htmlBody);
    details.push({
      label: `HTML part as the recipient reads it (${asText.length} characters)`,
      value: asText === '' ? '(empty)' : asText,
    });
  }
  if (prepared.attachments.length > 0) {
    details.push({
      label: 'Attachments',
      value: prepared.attachments
        .map((a) => `${a.filename} (${a.bytes} bytes)`)
        .join(', '),
    });
  }
  if (prepared.composed.htmlRemoved.length > 0) {
    // A detail rather than part of the consequence, and not for tidiness:
    // `mcp-approval` flattens and caps every detail value and leaves the
    // consequence alone, and this list carries caller-derived text — a scheme
    // name is whatever the caller wrote before the colon.
    details.push({
      label: 'Removed from the HTML part before sending',
      value: prepared.composed.htmlRemoved.join(', '),
    });
  }

  let consequence =
    'Mail cannot be recalled once the SMTP server has accepted it.';
  for (const { field, patterns } of prepared.suspicious) {
    // Server-authored text naming server-authored constants: the pattern names
    // are ours, the matched text is not repeated here. The two readings differ
    // and the sentence has to say which one this is. A quote that gives orders
    // is a forwarded message that tries to — passed on unchanged, correctly. A
    // body or HTML part that gives orders is the model writing them, which is
    // what such a quote was trying to make happen.
    const shapes = `${patterns.length} known prompt-injection shape(s): ${patterns.join(', ')}`;
    consequence +=
      field === 'quote'
        ? `\n\nNote: the quoted original matches ${shapes}. It is being passed ` +
          'on unchanged, which is correct for a quote — but check who asked for ' +
          'this message to be sent.'
        : `\n\nWARNING: the ${field === 'body' ? 'body' : 'HTML part'} — text ` +
          `the model wrote itself — matches ${shapes}. That is not a forwarded ` +
          'message giving orders; it is this message giving them. Check who ' +
          'asked for it before approving.';
  }
  if (prepared.textHtmlDiverge) {
    consequence +=
      '\n\nNote: the plain-text body and the HTML part say different things. ' +
      'Most recipients see only the HTML part; read the "HTML part as the ' +
      'recipient reads it" line, not just the body.';
  }

  const outcome = await ctx.approval.requestApproval(
    server,
    mcp,
    confirmations,
    {
      what: `${verb} to ${prepared.composed.envelope.to.length} recipient(s)`,
      consequence,
      resourceKey,
      token: confirmToken,
      toolName: tool,
      details,
    }
  );
  if (outcome.decision !== 'approved') {
    // Asked and not answered yet, refused, or declined. Either way nothing left
    // the building, so the slot goes back. The caller's catch would release it
    // for the two that throw, but releasing here keeps all four in one place.
    slot.release();
    if (outcome.decision === 'rejected') {
      throw new ToolInputError(`smtp-mcp: ${outcome.reason}`);
    }
    if (outcome.decision === 'declined') {
      throw new ToolInputError(
        'smtp-mcp: the user declined. Nothing was sent.'
      );
    }
    return outcome.result;
  }

  // A failure here is not one failure but two that look alike. A refused
  // connection, bad credentials or a rejected envelope means nothing left the
  // building. A connection lost after the end of DATA and before the 250 means
  // the message may already be queued for delivery — and nodemailer cannot tell
  // the two apart either, so neither can this.
  //
  // Both consequences therefore follow the unsafe reading. The rate-limit slot
  // is kept rather than released, because a message that may be on its way has
  // to count against the hour. And a line is written recording the outcome as
  // unknown, because a delivered message with no record at all is precisely the
  // failure this log exists to prevent — it describes itself as the place a
  // person reconstructs what a hijacked session actually sent.
  //
  // What is deliberately not done is remembering it as sent. Most failures on
  // this path are real failures, and locking the retry out for fifteen minutes
  // would be the wrong trade for the common case. So a retry after this one
  // error is the single path on which this server can still deliver twice, and
  // SECURITY.md says so rather than leaving it to be discovered.
  let sent;
  try {
    sent = await ctx.client.send({
      envelope: prepared.composed.envelope,
      raw: prepared.composed.raw,
    });
  } catch (error) {
    slot.commit();
    audit(
      tool,
      {
        from: ctx.config.smtp.fromAddress,
        to: prepared.to,
        cc: prepared.cc.length > 0 ? prepared.cc : undefined,
        bcc: prepared.bcc.length > 0 ? prepared.bcc : undefined,
        subject: args.subject,
        message_id: prepared.composed.messageId,
        bytes: prepared.composed.bytes,
        outcome: 'unknown — the server did not confirm; it may have been sent',
        error: error instanceof Error ? error.message : String(error),
      },
      ctx.config.auditLog
    );
    throw error;
  }

  slot.commit();
  // Before the audit line and before the result: from here on a retry of this
  // same call must be answered, not repeated.
  ctx.sent.record(resourceKey, {
    messageId: prepared.composed.messageId,
    accepted: sent.accepted,
  });
  audit(
    tool,
    {
      from: ctx.config.smtp.fromAddress,
      to: prepared.to,
      cc: prepared.cc.length > 0 ? prepared.cc : undefined,
      bcc: prepared.bcc.length > 0 ? prepared.bcc : undefined,
      subject: args.subject,
      message_id: prepared.composed.messageId,
      bytes: prepared.composed.bytes,
      attachments:
        prepared.attachments.length > 0
          ? prepared.attachments.map((a) => a.filename)
          : undefined,
      accepted: sent.accepted.length,
      rejected: sent.rejected.length > 0 ? sent.rejected : undefined,
    },
    ctx.config.auditLog
  );

  return jsonResult({
    sent: true,
    already_sent: false,
    message_id: prepared.composed.messageId,
    accepted: sent.accepted,
    rejected: sent.rejected,
    bytes: prepared.composed.bytes,
    sends_remaining_this_hour: ctx.limiter.remaining(),
    note:
      sent.rejected.length === 0
        ? 'The SMTP server accepted the message. It cannot be recalled.'
        : 'The SMTP server accepted the message for some recipients and ' +
          'refused others — see "rejected". Those people did not receive it.',
  });
}

/**
 * What the three send tools answer with — one shape for both outcomes.
 *
 * A repeat of a message already accepted answers `sent: false` with
 * `already_sent: true` and the same `message_id`, rather than a different
 * shape: a client should be able to read one field to find out what happened.
 * Making that true also turned up a defect — the two branches used `accepted`
 * for an address list and for a count of them.
 */
const sendOutcome = z.object({
  sent: z.boolean().describe('False when this exact message already went out.'),
  already_sent: z.boolean(),
  message_id: z.string(),
  accepted: z
    .array(z.string())
    .describe('Addresses the SMTP server took responsibility for.'),
  // Strings, not `unknown`: nodemailer types the entry as an address object,
  // but `sendMail` in `smtp.ts` maps every one of them through `String` before
  // it gets here.
  rejected: z
    .array(z.string())
    .describe('Addresses it refused. These people did not receive it.'),
  bytes: z.number().int().optional(),
  sends_remaining_this_hour: z.number().int(),
  note: z.string(),
});

export function registerSendTools(
  server: McpServer,
  ctx: ToolContext,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'send_mail',
    {
      title: 'Send a new message',
      description:
        'Sends a new message from the configured sender. Asks the user to ' +
        'confirm first; where the client cannot show a prompt, it falls back ' +
        'to a two-call token. Recipients must be covered by ' +
        'SMTP_ALLOWED_RECIPIENTS. There is no "from" parameter — the sender is ' +
        'fixed by SMTP_FROM. Use preview_mail first if you want to see the ' +
        'message without sending it.',
      inputSchema: z.object({
        to: toParam,
        cc: ccParam,
        bcc: bccParam,
        subject: subjectParam,
        body: bodyParam,
        html: htmlParam,
        attachments: attachmentsParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Sending is the case these four hints were not designed for. Nothing
        // is destroyed — and the message is in somebody else's inbox and
        // cannot be recalled. destructiveHint is the closest the vocabulary
        // comes to that; the dialog is the real gate. Not idempotent: each
        // call sends another copy.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: sendOutcome,
    },
    ({ confirm_token, ...args }, mcp) =>
      run(() =>
        performSend(
          server,
          mcp,
          ctx,
          confirmations,
          'send_mail',
          'send a message',
          args,
          confirm_token
        )
      )
  );

  server.registerTool(
    'reply_mail',
    {
      title: 'Reply to a message',
      description:
        'Sends a reply that mail clients will thread under the original. Pass ' +
        'in_reply_to and references verbatim from the message being answered — ' +
        "imap-mcp's get_message returns both. The subject is derived from " +
        'original_subject with a single "Re: " unless you override it. Asks ' +
        'the user to confirm, like every sending tool here.',
      inputSchema: z.object({
        to: toParam,
        cc: ccParam,
        bcc: bccParam,
        original_subject: subjectParam.describe(
          'Subject of the message being answered. "Re: " is added unless it is already there.'
        ),
        subject: subjectParam
          .optional()
          .describe('Overrides the subject derived from original_subject.'),
        body: bodyParam,
        html: htmlParam,
        quote: quoteParam,
        in_reply_to: messageIdParam,
        references: referencesParam,
        attachments: attachmentsParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Sending is the case these four hints were not designed for. Nothing
        // is destroyed — and the message is in somebody else's inbox and
        // cannot be recalled. destructiveHint is the closest the vocabulary
        // comes to that; the dialog is the real gate. Not idempotent: each
        // call sends another copy.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: sendOutcome,
    },
    ({ confirm_token, original_subject, subject, ...rest }, mcp) =>
      run(() =>
        performSend(
          server,
          mcp,
          ctx,
          confirmations,
          'reply_mail',
          'send a reply',
          { ...rest, subject: subject ?? replySubject(original_subject) },
          confirm_token
        )
      )
  );

  server.registerTool(
    'forward_mail',
    {
      title: 'Forward a message',
      description:
        'Forwards a message to new recipients. Put the original text in ' +
        '"quote" — it is included verbatim, and if it contains ' +
        'instruction-like passages the confirmation says so rather than ' +
        'altering it. Attachments of the original are not carried over ' +
        'automatically; name them in "attachments" after saving them into ' +
        'SMTP_ATTACHMENT_DIR. Asks the user to confirm.',
      inputSchema: z.object({
        to: toParam,
        cc: ccParam,
        bcc: bccParam,
        original_subject: subjectParam.describe(
          'Subject of the message being forwarded. "Fwd: " is added unless it is already there.'
        ),
        subject: subjectParam
          .optional()
          .describe('Overrides the subject derived from original_subject.'),
        body: bodyParam.describe(
          'Your own text, placed above the forwarded content. May be empty.'
        ),
        quote: quoteParam.describe(
          'The original message text, included below your own. Passed through unchanged.'
        ),
        html: htmlParam,
        references: referencesParam,
        attachments: attachmentsParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Sending is the case these four hints were not designed for. Nothing
        // is destroyed — and the message is in somebody else's inbox and
        // cannot be recalled. destructiveHint is the closest the vocabulary
        // comes to that; the dialog is the real gate. Not idempotent: each
        // call sends another copy.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: sendOutcome,
    },
    ({ confirm_token, original_subject, subject, ...rest }, mcp) =>
      run(() =>
        performSend(
          server,
          mcp,
          ctx,
          confirmations,
          'forward_mail',
          'forward a message',
          { ...rest, subject: subject ?? forwardSubject(original_subject) },
          confirm_token
        )
      )
  );
}
