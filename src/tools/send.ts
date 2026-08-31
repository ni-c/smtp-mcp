import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { requestApproval } from '../approval.js';
import { audit } from '../audit.js';
import {
  setResourceKey,
  type ConfirmationDetail,
  type ConfirmationStore,
} from '../confirm.js';
import {
  messageFingerprint,
  prepareMessage,
  type MailArgs,
  type PreparedMessage,
} from '../prepare.js';
import type { RateLimitSlot } from '../ratelimit.js';
import { jsonResult, run } from '../result.js';
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
import type { ToolContext } from './context.js';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
  ctx: ToolContext,
  confirmations: ConfirmationStore,
  tool: string,
  verb: string,
  args: MailArgs,
  confirmToken: string | undefined
): Promise<CallToolResult> {
  const prepared = await prepareMessage(args, ctx.config, ctx.version);

  const slot = ctx.limiter.reserve();
  try {
    return await withSlot(
      server,
      ctx,
      confirmations,
      tool,
      verb,
      args,
      confirmToken,
      prepared,
      slot
    );
  } catch (error) {
    slot.release();
    throw error;
  }
}

async function withSlot(
  server: McpServer,
  ctx: ToolContext,
  confirmations: ConfirmationStore,
  tool: string,
  verb: string,
  args: MailArgs,
  confirmToken: string | undefined,
  prepared: PreparedMessage,
  slot: RateLimitSlot
): Promise<CallToolResult> {
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
  if (prepared.attachments.length > 0) {
    details.push({
      label: 'Attachments',
      value: prepared.attachments
        .map((a) => `${a.filename} (${a.bytes} bytes)`)
        .join(', '),
    });
  }

  let consequence =
    'Mail cannot be recalled once the SMTP server has accepted it.';
  if (prepared.suspiciousQuote.length > 0) {
    // Server-authored text naming server-authored constants: the pattern names
    // are ours, the quoted text is not repeated here. The person approving a
    // forward deserves to know the thing they are forwarding tries to give
    // orders, without that text getting a second chance to be read as one.
    consequence +=
      `\n\nNote: the quoted original matches ${prepared.suspiciousQuote.length} ` +
      `known prompt-injection shape(s): ${prepared.suspiciousQuote.join(', ')}. ` +
      'It is being passed on unchanged, which is correct for a quote — but ' +
      'check who asked for this message to be sent.';
  }
  if (prepared.composed.htmlRemoved.length > 0) {
    consequence +=
      `\n\nRemoved from the HTML part before sending: ` +
      `${prepared.composed.htmlRemoved.join(', ')}.`;
  }

  const approval = await requestApproval(server, confirmations, {
    what: `${verb} to ${prepared.composed.envelope.to.length} recipient(s)`,
    consequence,
    resourceKey: setResourceKey(tool, messageFingerprint(args, prepared)),
    token: confirmToken,
    details,
  });
  if (!approval.approved) {
    // Asked and not answered yet, or declined. Either way nothing left the
    // building, so the slot goes back.
    slot.release();
    return approval.result;
  }

  const outcome = await ctx.client.send({
    envelope: prepared.composed.envelope,
    raw: prepared.composed.raw,
  });

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
      attachments:
        prepared.attachments.length > 0
          ? prepared.attachments.map((a) => a.filename)
          : undefined,
      accepted: outcome.accepted.length,
      rejected: outcome.rejected.length > 0 ? outcome.rejected : undefined,
    },
    ctx.config.auditLog
  );

  return jsonResult({
    sent: true,
    message_id: prepared.composed.messageId,
    accepted: outcome.accepted,
    rejected: outcome.rejected,
    bytes: prepared.composed.bytes,
    sends_remaining_this_hour: ctx.limiter.remaining(),
    note:
      outcome.rejected.length === 0
        ? 'The SMTP server accepted the message. It cannot be recalled.'
        : 'The SMTP server accepted the message for some recipients and ' +
          'refused others — see "rejected". Those people did not receive it.',
  });
}

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
      inputSchema: {
        to: toParam,
        cc: ccParam,
        bcc: bccParam,
        subject: subjectParam,
        body: bodyParam,
        html: htmlParam,
        attachments: attachmentsParam,
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ confirm_token, ...args }) =>
      run(() =>
        performSend(
          server,
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
      inputSchema: {
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
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ confirm_token, original_subject, subject, ...rest }) =>
      run(() =>
        performSend(
          server,
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
      inputSchema: {
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
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ confirm_token, original_subject, subject, ...rest }) =>
      run(() =>
        performSend(
          server,
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
