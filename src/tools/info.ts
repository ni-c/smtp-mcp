import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  addressParam,
  attachmentsParam,
  bccParam,
  bodyParam,
  ccParam,
  htmlParam,
  messageIdParam,
  quoteParam,
  referencesParam,
  subjectParam,
  toParam,
} from '../schema.js';

import { sanitizeText } from '../analyze.js';
import { allowedExtensions } from '../attachments.js';
import { missingConfigKeys } from '../config.js';
import { prepareMessage, type PreparedMessage } from '../prepare.js';
import { describeAllowlist, isAllowed } from '../recipients.js';
import { fencedUntrustedResult, jsonResult, run } from '../result.js';
import { ALL_TOOLS, INFO_TOOLS } from './catalogue.js';
import type { ToolContext } from './context.js';

/**
 * Splits a composed message into its header block and everything after it.
 *
 * RFC 5322 separates them with an empty line, so the first CRLFCRLF is the
 * boundary. A message with no body at all has no boundary, in which case the
 * whole thing is headers.
 */
function headerBlockOf(raw: Buffer): string {
  const text = raw.toString('utf8');
  const end = text.indexOf('\r\n\r\n');
  return end === -1 ? text : text.slice(0, end);
}

/** Renders the message for a human and a model to look at before it is sent. */
function renderPreview(
  prepared: PreparedMessage,
  htmlBody: string | undefined
): string {
  const lines = [headerBlockOf(prepared.composed.raw), ''];
  lines.push('--- text/plain ---');
  lines.push(sanitizeText(prepared.composed.textBody));
  if (htmlBody !== undefined) {
    lines.push('', '--- text/html (after sanitising) ---');
    lines.push(sanitizeText(htmlBody));
  }
  if (prepared.attachments.length > 0) {
    lines.push('', '--- attachments ---');
    for (const attachment of prepared.attachments) {
      const digest = createHash('sha256')
        .update(attachment.content)
        .digest('hex')
        .slice(0, 16);
      lines.push(
        `${attachment.filename}  ${attachment.contentType}  ` +
          `${attachment.bytes} bytes  sha256:${digest}…`
      );
    }
  }
  return lines.join('\n');
}

export function registerInfoTools(server: McpServer, ctx: ToolContext): void {
  const { client, config, limiter, version } = ctx;

  server.registerTool(
    'get_server_info',
    {
      title: 'Show how this server is configured',
      description:
        'Reports the SMTP endpoint, the fixed sender address, who this server ' +
        'is allowed to write to, the current limits and whether sending is ' +
        'switched on at all. Call this first: it answers "can I send, and to ' +
        'whom" without touching the network.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const missing = missingConfigKeys(config);
        return jsonResult({
          // The load-bearing fact about this server, stated first. Unlike its
          // counterpart imap-mcp, this one can put a message on the wire — so
          // everything below describes what narrows that.
          can_send: config.allowSend && missing.length === 0,
          sending_enabled: config.allowSend,
          sending_gate: 'SMTP_ALLOW_SEND (defaults to false)',
          configured: missing.length === 0,
          missing_environment_variables: missing,
          smtp: {
            host: config.smtp.host ?? null,
            port: config.smtp.port,
            tls: config.smtp.tls,
            insecure_tls: config.smtp.insecureTls,
          },
          from: config.smtp.from ?? null,
          from_is_fixed: true,
          allowed_recipients: describeAllowlist(config.allowedRecipients),
          limits: {
            max_recipients_per_message: config.maxRecipients,
            max_sends_per_hour: config.maxSendsPerHour,
            sends_remaining_this_hour: limiter.remaining(),
            max_message_bytes: config.maxMessageBytes,
            max_attachment_bytes: config.maxAttachmentBytes,
          },
          attachments: {
            enabled: config.attachmentDir !== undefined,
            gate: 'SMTP_ATTACHMENT_DIR',
            allowed_extensions: allowedExtensions(
              config.allowedAttachmentTypes
            ),
          },
          signature_configured: config.signature !== undefined,
          audit_log_configured: config.auditLog !== undefined,
          tools_registered: config.allowSend ? [...ALL_TOOLS] : [...INFO_TOOLS],
          every_send_requires_confirmation: true,
        });
      })
  );

  server.registerTool(
    'validate_recipients',
    {
      title: 'Check recipients against the allowlist',
      description:
        'Says which of the given addresses this server is allowed to write to, ' +
        'and why the others are refused. Nothing is sent and no connection is ' +
        'made. Use it before composing a message rather than discovering the ' +
        'refusal afterwards.',
      inputSchema: z.object({
        addresses: z
          .array(addressParam)
          .min(1)
          .max(100)
          .describe('The email addresses to check.'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ addresses }) =>
      run(async () => {
        const results = addresses.map((address) => ({
          address,
          allowed: isAllowed(address, config.allowedRecipients),
        }));
        const refused = results.filter((r) => !r.allowed).length;
        return jsonResult({
          allowlist: describeAllowlist(config.allowedRecipients),
          allowlist_variable: 'SMTP_ALLOWED_RECIPIENTS',
          max_recipients_per_message: config.maxRecipients,
          allowed_count: results.length - refused,
          refused_count: refused,
          results,
          note:
            refused === 0
              ? undefined
              : 'Refused addresses cannot be reached by this server. Ask the ' +
                'operator to add them to SMTP_ALLOWED_RECIPIENTS; the model ' +
                'cannot widen the allowlist.',
        });
      })
  );

  server.registerTool(
    'preview_mail',
    {
      title: 'Render a message without sending it',
      description:
        'Builds exactly the message send_mail would build and returns its ' +
        'headers and bodies, without connecting to anything. Every check a ' +
        'send performs runs here too — the allowlist, the recipient limit, the ' +
        'attachment policy and the size limit — so this is the way to find out ' +
        'whether a message is acceptable before asking a human to approve it. ' +
        'Attachment payloads are summarised by name, size and digest rather ' +
        'than printed.',
      inputSchema: z.object({
        to: toParam,
        cc: ccParam,
        bcc: bccParam,
        subject: subjectParam,
        body: bodyParam,
        html: htmlParam,
        quote: quoteParam,
        in_reply_to: messageIdParam.optional(),
        references: referencesParam,
        attachments: attachmentsParam,
      }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const prepared = await prepareMessage(args, config, version);
        const header =
          `This message would be sent from ${config.smtp.from ?? '(unset)'} ` +
          `to ${prepared.composed.envelope.to.length} recipient(s), ` +
          `${prepared.composed.bytes} bytes. Nothing has been sent.` +
          (prepared.composed.htmlRemoved.length === 0
            ? ''
            : `\nRemoved from the HTML part: ${prepared.composed.htmlRemoved.join(', ')}.`) +
          (prepared.bcc.length === 0
            ? ''
            : `\nBcc recipients (invisible to the others): ${prepared.bcc.length}.`);
        return fencedUntrustedResult(
          header,
          renderPreview(prepared, prepared.composed.htmlBody),
          prepared.suspiciousQuote
        );
      })
  );

  server.registerTool(
    'test_connection',
    {
      title: 'Check the SMTP connection',
      description:
        'Opens a connection to the SMTP server, negotiates TLS and ' +
        'authenticates, then closes it again. No message is sent. Use it to ' +
        'tell a configuration problem apart from a delivery problem.',
      inputSchema: z.object({}),
      // Nothing changes on the far side: this opens a session and closes it.
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        await client.verify();
        return jsonResult({
          reachable: true,
          host: config.smtp.host ?? null,
          port: config.smtp.port,
          tls: config.smtp.tls,
          authenticated: true,
          note: 'The connection works and the credentials were accepted. No message was sent.',
        });
      })
  );
}
