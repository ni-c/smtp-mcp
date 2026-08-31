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

/** Long recipient lists are abbreviated so one bulk call cannot flood the log. */
function format(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 20
      ? `[${value.slice(0, 20).join(',')},…+${value.length - 20}]`
      : `[${value.join(',')}]`;
  }
  // Quoted because a subject contains spaces, which would otherwise run into
  // the next key=value pair and make the line unparseable. The schema already
  // refuses CR and LF, so this cannot produce a second log line.
  const text = String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}
