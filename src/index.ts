#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from './tool-filter.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.smtp.insecureTls) {
    console.error(
      'smtp-mcp: SMTP_INSECURE_TLS=true — certificates are not verified, so ' +
        'anyone able to intercept the connection can read the credentials and ' +
        'every message. Prefer a proper internal CA.'
    );
  }
  // Said out loud at startup rather than left to be discovered: an operator who
  // believes sending is on and finds three tools missing has no reason to look
  // at an environment variable for the cause.
  console.error(
    config.allowSend
      ? 'smtp-mcp: SMTP_ALLOW_SEND=true — send_mail, reply_mail and ' +
          'forward_mail are registered. Every send still needs a confirmation, ' +
          `and recipients are limited to: ${config.allowedRecipientsRaw ?? '(none)'}`
      : 'smtp-mcp: SMTP_ALLOW_SEND is not "true" — this server can compose and ' +
          'preview messages but cannot send any. Set SMTP_ALLOW_SEND=true and ' +
          'SMTP_ALLOWED_RECIPIENTS to enable sending.'
  );

  let server;
  try {
    server = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash.
    if (error instanceof ToolFilterError) {
      console.error(`smtp-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    config.smtp.host === undefined
      ? 'smtp-mcp: connected without configuration — tools are listed but every call will fail'
      : `smtp-mcp: connected, ${config.smtp.host}:${config.smtp.port} (${config.smtp.tls})`
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error('smtp-mcp: fatal error:', error);
  process.exit(1);
});
