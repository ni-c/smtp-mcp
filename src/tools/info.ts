import { createHash } from 'node:crypto';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
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
import { READ_ONLY } from './annotations.js';
import { allowedExtensions } from '../attachments.js';
import { missingConfigKeys } from '../config.js';
import {
  prepareMessage,
  suspiciousPatterns,
  type PreparedMessage,
} from '../prepare.js';
import { describeAllowlist, isAllowed } from '../recipients.js';
import {
  errorResult,
  fencedUntrustedResult,
  jsonResult,
  run,
} from '../result.js';
import { untrustedFields } from '../output-schema.js';
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
      annotations: READ_ONLY,
      // No untrusted marker anywhere in this file's first, second and fourth
      // tool: every field below is this server's own configuration, read from
      // its own environment. preview_mail is the exception, and carries it.
      outputSchema: z.object({
        can_send: z
          .boolean()
          .describe('The load-bearing fact: both switched on and configured.'),
        sending_enabled: z.boolean(),
        sending_gate: z.string(),
        configured: z.boolean(),
        missing_environment_variables: z.array(z.string()),
        smtp: z.object({
          host: z.string().describe('Null when SMTP_HOST is unset.').nullable(),
          port: z.number().int(),
          tls: z.string(),
          insecure_tls: z.boolean(),
        }),
        from: z
          .string()
          .describe('The one address this can send as.')
          .nullable(),
        from_is_fixed: z.literal(true),
        allowed_recipients: z.string(),
        limits: z.object({
          max_recipients_per_message: z.number().int(),
          max_sends_per_hour: z.number().int(),
          sends_remaining_this_hour: z.number().int(),
          max_message_bytes: z.number().int(),
          max_attachment_bytes: z.number().int(),
        }),
        attachments: z.object({
          enabled: z.boolean(),
          gate: z.string(),
          allowed_extensions: z.array(z.string()),
        }),
        signature_configured: z.boolean(),
        audit_log_configured: z.boolean(),
        tools_registered: z.array(z.string()),
        elicitation_enabled: z.boolean(),
        confirmation: z
          .string()
          .describe('Whether a person is asked, or a token the model redeems.'),
      }),
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
          // This used to be a constant `every_send_requires_confirmation: true`
          // and it was not always true. With ELICITATION=false `mcp-approval`
          // takes the two-call token path, which the model redeems on its own
          // — nobody is asked. The description tells a model to call this tool
          // first, so a wrong answer here is a wrong answer about the only
          // thing standing between it and a message that cannot be recalled.
          elicitation_enabled: config.elicitation,
          confirmation: config.elicitation
            ? 'dialog — a person is asked before every send'
            : 'two-call token — no person is asked; the model can redeem it ' +
              'itself (the operator set ELICITATION=false)',
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
      annotations: READ_ONLY,
      outputSchema: z.object({
        allowlist: z.string(),
        allowlist_variable: z.literal('SMTP_ALLOWED_RECIPIENTS'),
        max_recipients_per_message: z.number().int(),
        allowed_count: z.number().int(),
        refused_count: z.number().int(),
        results: z.array(
          z.object({ address: z.string(), allowed: z.boolean() })
        ),
        note: z.string().optional(),
      }),
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
      // This tool is registered whether or not sending is switched on, so its
      // description may not name a sending tool as though it were present: with
      // SMTP_ALLOW_SEND unset they are absent from tools/list, and a reader left
      // holding a reference to a tool that is not there reads the gap as a
      // defect rather than as the default it is.
      description:
        'Builds exactly the message a send would build and returns its ' +
        'headers and bodies, without connecting to anything. Every check a ' +
        'send performs runs here too — the allowlist, the recipient limit, the ' +
        'attachment policy and the size limit — so this is the way to find out ' +
        'whether a message is acceptable before asking a human to approve it. ' +
        'The sending tools register only when SMTP_ALLOW_SEND is true and may ' +
        'therefore be absent even where this preview succeeds; get_server_info ' +
        'reports whether sending is on. Attachment payloads are summarised by ' +
        'name, size and digest rather than printed.',
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
      annotations: READ_ONLY,
      // The only tool here that carries the marker: a quoted original was
      // written by whoever sent it, and anyone in the world can send mail.
      outputSchema: z.object({
        ...untrustedFields,
        from: z
          .string()
          .describe('The envelope sender, null when it was not recorded.')
          .nullable(),
        recipient_count: z.number().int(),
        bcc_count: z
          .number()
          .int()
          .describe('Invisible to the other recipients.'),
        bytes: z.number().int(),
        html_removed: z
          .array(z.string())
          .describe('What the HTML sanitiser took out.'),
        suspicious: z
          .array(z.string())
          .describe(
            'Prompt-injection shapes matched anywhere in the caller-supplied text.'
          ),
        suspicious_in: z
          .array(z.enum(['quote', 'body', 'html']))
          .describe(
            'Which fields matched. "quote" is a forwarded message giving orders; ' +
              '"body" or "html" is this message giving them.'
          ),
        text_html_diverge: z
          .boolean()
          .describe(
            'True when the plain-text body and the HTML part say noticeably different things.'
          ),
        headers: z.string().describe('The composed header block, verbatim.'),
        text_body: z.string(),
        html_body: z.string().optional().describe('After sanitising.'),
        attachments: z.array(
          z.object({
            filename: z.string(),
            content_type: z.string(),
            bytes: z.number().int(),
            sha256: z.string().describe('First 16 hex characters.'),
          })
        ),
      }),
    },
    (args) =>
      run(async () => {
        const prepared = await prepareMessage(args, config, version);
        const header =
          `This message would be sent from ${config.smtp.from ?? '(unset)'} ` +
          `to ${prepared.composed.envelope.to.length} recipient(s), ` +
          `${prepared.composed.bytes} bytes. Nothing has been sent.` +
          // The count, not the list. Each entry names the scheme the caller
          // wrote before a colon, and this header sits *outside* the fence,
          // under a preamble telling the reader that everything outside it
          // came from this server. `send_mail` gets the same list right, as a
          // capped detail; here it was server voice carrying caller text. The
          // entries themselves are in `html_removed`, which is data.
          (prepared.composed.htmlRemoved.length === 0
            ? ''
            : `\n${prepared.composed.htmlRemoved.length} thing(s) were removed ` +
              'from the HTML part; they are listed in html_removed, which is ' +
              'caller-supplied text like the message itself.') +
          (prepared.bcc.length === 0
            ? ''
            : `\nBcc recipients (invisible to the others): ${prepared.bcc.length}.`);
        return fencedUntrustedResult(
          header,
          renderPreview(prepared, prepared.composed.htmlBody),
          suspiciousPatterns(prepared.suspicious),
          {
            from: config.smtp.from ?? null,
            recipient_count: prepared.composed.envelope.to.length,
            bcc_count: prepared.bcc.length,
            bytes: prepared.composed.bytes,
            html_removed: prepared.composed.htmlRemoved,
            suspicious: suspiciousPatterns(prepared.suspicious),
            suspicious_in: prepared.suspicious.map((s) => s.field),
            text_html_diverge: prepared.textHtmlDiverge,
            headers: headerBlockOf(prepared.composed.raw),
            text_body: sanitizeText(prepared.composed.textBody),
            ...(prepared.composed.htmlBody === undefined
              ? {}
              : { html_body: sanitizeText(prepared.composed.htmlBody) }),
            attachments: prepared.attachments.map((attachment) => ({
              filename: attachment.filename,
              content_type: attachment.contentType,
              bytes: attachment.bytes,
              sha256: createHash('sha256')
                .update(attachment.content)
                .digest('hex')
                .slice(0, 16),
            })),
          }
        );
      })
  );

  // The last attempt and when it was made, for the cooldown below. One per
  // server, like the rate limiter: the process is the session.
  let lastAttempt: { at: number; outcome: CallToolResult } | undefined;

  server.registerTool(
    'test_connection',
    {
      title: 'Check the SMTP connection',
      description:
        'Opens a connection to the SMTP server, negotiates TLS and ' +
        'authenticates, then closes it again. No message is sent. Use it to ' +
        'tell a configuration problem apart from a delivery problem. Tries ' +
        'the server at most once every ten seconds; a call inside that window ' +
        'repeats the previous outcome and says so.',
      inputSchema: z.object({}),
      // Nothing changes on the far side: this opens a session and closes it.
      annotations: READ_ONLY,
      outputSchema: z.object({
        reachable: z.literal(true),
        host: z.string().describe('Null when SMTP_HOST is unset.').nullable(),
        port: z.number().int(),
        tls: z.string(),
        authenticated: z.literal(true),
        cached: z
          .boolean()
          .describe(
            'True when this repeats an attempt made within the last ten seconds.'
          ),
        note: z.string(),
      }),
    },
    async () => {
      // Every call is an AUTH against the operator's own mailbox provider,
      // and providers lock an account after a handful of failed logins in
      // quick succession. A model that reads "authentication refused" and
      // tries again — and again, because the tool is read-only, idempotent
      // and cheap by its own annotations — turns one wrong password into a
      // locked mailbox. Nothing here sends, so the send rate limit does not
      // cover it; this does. Inside the window the previous outcome is
      // repeated, marked as such, rather than a fresh attempt made.
      const now = Date.now();
      if (
        lastAttempt !== undefined &&
        now - lastAttempt.at < CONNECTION_TEST_COOLDOWN_MS
      ) {
        const wait = Math.ceil(
          (CONNECTION_TEST_COOLDOWN_MS - (now - lastAttempt.at)) / 1000
        );
        return repeatOutcome(lastAttempt.outcome, wait);
      }
      const outcome = (await run(async () => {
        await client.verify();
        // The description says this opens a session and closes it again, and
        // it has to be true: `verify()` leaves an authenticated, pooled
        // connection open for the lifetime of the process, and a diagnostic
        // that quietly holds a session is not a diagnostic. `send` reopens.
        client.close();
        return jsonResult({
          reachable: true,
          host: config.smtp.host ?? null,
          port: config.smtp.port,
          tls: config.smtp.tls,
          authenticated: true,
          cached: false,
          note: 'The connection works and the credentials were accepted. No message was sent.',
        });
      })) as CallToolResult;
      lastAttempt = { at: now, outcome };
      return outcome;
    }
  );
}

/** How long `test_connection` waits before it will dial the server again. */
const CONNECTION_TEST_COOLDOWN_MS = 10_000;

/**
 * The previous outcome of `test_connection`, marked as a repeat.
 *
 * A failure is repeated as a failure — that is what the caller would get from
 * a fresh attempt inside the window, minus the login attempt against the
 * provider — and a success as a success with `cached: true`.
 */
function repeatOutcome(
  outcome: CallToolResult,
  waitSeconds: number
): CallToolResult {
  const notice =
    `test_connection tries the server at most once every ten seconds. This ` +
    `repeats the outcome of the last attempt; the next real attempt is ` +
    `possible in about ${waitSeconds} second(s).`;
  if (outcome.isError === true) {
    return errorResult(`${textOfResult(outcome)}\n\n(Not retried: ${notice})`);
  }
  return jsonResult({
    ...outcome.structuredContent,
    cached: true,
    note: `${notice} The connection worked then, and no message was sent.`,
  });
}

function textOfResult(outcome: CallToolResult): string {
  return outcome.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}
