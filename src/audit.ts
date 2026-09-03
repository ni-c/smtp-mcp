import { appendFileSync } from 'node:fs';

/**
 * Records every message this server hands to the SMTP server.
 *
 * The line goes to stderr, which is the one channel the model never reads: the
 * MCP transport owns stdout, and tool results go back to the model. So this is
 * the only place a human can afterwards reconstruct what a hijacked session
 * actually sent — the model's own account of events is not evidence, and a
 * message that has left the building cannot be recalled by reading a chat log.
 *
 * `SMTP_AUDIT_LOG` adds a file sink for the same lines. That is the difference
 * that matters in practice: stderr belongs to whoever started the process, and
 * on a desktop MCP client that is a window nobody keeps. The question this
 * server has to be able to answer months later is "what went out, to whom, and
 * when" — so recipients, subject and the Message-ID are recorded.
 *
 * The **body is never recorded**, and the subject is. That split is deliberate:
 * a subject is what identifies the message in the recipient's mailbox, so
 * without it the log cannot be matched against anything, while a body is the
 * confidential part and would turn the audit file into a second copy of the
 * correspondence.
 */
export function audit(
  operation: string,
  details: Record<string, unknown>,
  logPath?: string
): void {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${format(value)}`)
    .join(' ');
  const line = `smtp-mcp audit ${new Date().toISOString()} ${operation} ${fields}`;
  console.error(line);

  if (logPath === undefined) return;
  try {
    appendFileSync(logPath, `${line}\n`, { mode: 0o600 });
  } catch (error) {
    // The message has already been sent by the time this runs. Throwing here
    // would report a delivered message as failed, which is the one wrong answer
    // — so the failure is reported and the caller still learns the truth.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `smtp-mcp: WARNING: could not append to SMTP_AUDIT_LOG (${reason}). ` +
        'The line above was written to stderr only.'
    );
  }
}

/**
 * One field value, quoted so it cannot be read as more than one field.
 *
 * Quoting used to be conditional on the value containing whitespace, and that
 * condition was the bug. A subject with no space in it went out bare, so
 * `Invoice_bcc=[quiet@evil.example]_accepted=1` produced a line reading
 * `… subject=Invoice_bcc=[quiet@evil.example]_accepted=1 message_id=<…>` — and
 * anything splitting on `key=` reads a `bcc` that never existed. The caller
 * chooses the subject and the attachment names; this file is the record of what
 * a hijacked session actually sent, so the one thing it must not do is let the
 * attacker write it. Array elements were never quoted at all, and
 * `assertPlainFilename` permits both commas and spaces in an attachment name.
 *
 * Numbers and booleans stay bare: they cannot contain a separator, and a JSON
 * string always begins with a quote, so the two are never ambiguous.
 *
 * Long recipient lists are still abbreviated, so one bulk call cannot flood it.
 */
function format(value: unknown): string {
  if (Array.isArray(value)) {
    const entries = value.map((entry: unknown) => quote(entry));
    return entries.length > 20
      ? `[${entries.slice(0, 20).join(',')},…+${entries.length - 20}]`
      : `[${entries.join(',')}]`;
  }
  return quote(value);
}

function quote(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // The schema already refuses CR and LF, so this cannot produce a second log
  // line; JSON.stringify escapes them anyway if it ever gets one.
  return JSON.stringify(String(value));
}
