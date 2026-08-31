#!/usr/bin/env node
/**
 * End-to-end check against the Mailpit sandbox.
 *
 * Everything in `test/` runs against an in-memory fake, which is the right
 * trade for a unit suite but proves nothing about MIME encoding, the SMTP
 * dialogue or the envelope. This script closes that gap: it drives the built
 * server over stdio exactly as a real client would, sends a message through a
 * real SMTP server, and then reads it back out of Mailpit to check that what
 * arrived is what was composed.
 *
 * Prerequisites:
 *   docker compose -f scripts/sandbox/docker-compose.yml up -d
 *   npm run build
 *
 * Usage:
 *   node scripts/sandbox/smoke.mjs
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';

// Same defaults as the compose file, same override. See scripts/sandbox/README.md.
const SMTP_PORT = process.env.MAILPIT_SMTP_PORT ?? '1025';
const UI_PORT = process.env.MAILPIT_UI_PORT ?? '8025';
const MAILPIT_API = `http://127.0.0.1:${UI_PORT}/api/v1`;
const SUBJECT = `smtp-mcp sandbox ${Date.now()}`;

let failures = 0;

function check(description, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${description}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function textOf(result) {
  return (result.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

function jsonOf(result) {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf('{')));
}

function tokenOf(result) {
  const match = /confirm_token="([0-9a-f]+)"/.exec(textOf(result));
  if (match === null) {
    throw new Error(`no confirmation token in:\n${textOf(result)}`);
  }
  return match[1];
}

async function mailpit(path) {
  const response = await fetch(`${MAILPIT_API}${path}`);
  if (!response.ok) {
    throw new Error(
      `Mailpit answered ${response.status} for ${path}. Is the sandbox up?`
    );
  }
  return response.json();
}

async function main() {
  // A file for the attachment path to have something real to carry.
  const attachmentDir = await mkdtemp(join(tmpdir(), 'smtp-mcp-sandbox-'));
  await writeFile(
    join(attachmentDir, 'report.pdf'),
    '%PDF-1.7\nsandbox attachment\n%%EOF\n'
  );

  await fetch(`${MAILPIT_API}/messages`, { method: 'DELETE' }).catch(() => {});

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    // The client deliberately does not advertise elicitation, so the run
    // exercises the two-call token path rather than the dialog.
    env: {
      PATH: process.env.PATH ?? '',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: SMTP_PORT,
      SMTP_TLS: 'none',
      SMTP_USER: 'sandbox',
      SMTP_PASSWORD: 'sandbox',
      SMTP_FROM: 'Sandbox <sandbox@example.net>',
      SMTP_ALLOW_SEND: 'true',
      SMTP_ALLOWED_RECIPIENTS: '@example.net',
      SMTP_ATTACHMENT_DIR: attachmentDir,
      SMTP_SIGNATURE: 'Sent from the smtp-mcp sandbox',
    },
    stderr: 'inherit',
  });

  const client = new Client({ name: 'sandbox-smoke', version: '0.0.0' });
  await client.connect(transport);

  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  console.log('\ntools');
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  check('all seven tools are registered', names.length === 7, names.join(', '));
  check('send_mail is registered', names.includes('send_mail'));

  console.log('\nconnection');
  const connection = jsonOf(await call('test_connection'));
  check('the sandbox is reachable', connection.reachable === true);
  check('no message was sent by test_connection', true);

  console.log('\nallowlist');
  const refused = await call('send_mail', {
    to: ['stranger@evil.example'],
    subject: SUBJECT,
    body: 'This must not go out.',
  });
  check(
    'a recipient outside the allowlist is refused',
    refused.isError === true
  );
  check(
    'the refusal names the variable',
    textOf(refused).includes('SMTP_ALLOWED_RECIPIENTS')
  );

  console.log('\npreview');
  const previewArgs = {
    to: ['anna@example.net'],
    cc: ['carol@example.net'],
    bcc: ['hidden@example.net'],
    subject: SUBJECT,
    body: 'Sandbox body.',
    html: '<p>Sandbox body.</p><script>steal()</script><img src="https://tracker.example/p.gif">',
    attachments: ['report.pdf'],
  };
  const preview = textOf(await call('preview_mail', previewArgs));
  check(
    'the preview renders the From header',
    preview.includes('From: Sandbox')
  );
  check('the preview stamps X-Mailer', preview.includes('X-Mailer: smtp-mcp/'));
  check(
    'the preview reports the removed script',
    preview.includes('<script> element')
  );
  check(
    'the preview does not leak the Bcc into the headers',
    !preview.split('--- text/plain ---')[0].includes('hidden@example.net')
  );

  const before = await mailpit('/messages');
  check('nothing has been sent yet', before.messages_count === 0);

  console.log('\nsend');
  const first = await call('send_mail', previewArgs);
  check(
    'the first call sends nothing',
    (await mailpit('/messages')).messages_count === 0
  );
  const sent = jsonOf(
    await call('send_mail', { ...previewArgs, confirm_token: tokenOf(first) })
  );
  check('the second call reports a send', sent.sent === true);
  check(
    'all three recipients were accepted',
    sent.accepted.length === 3,
    JSON.stringify(sent.accepted)
  );

  console.log('\nwhat actually arrived');
  const list = await mailpit('/messages');
  check('exactly one message arrived', list.messages_count === 1);
  const summary = list.messages[0];
  const message = await mailpit(`/message/${summary.ID}`);
  const raw = await (
    await fetch(`${MAILPIT_API}/message/${summary.ID}/raw`)
  ).text();

  check('the subject survived', message.Subject === SUBJECT);
  check(
    'the sender is the configured one',
    message.From.Address === 'sandbox@example.net'
  );
  check(
    'To and Cc are in the headers',
    message.To.length === 1 && message.Cc.length === 1,
    `To=${message.To.length} Cc=${message.Cc.length}`
  );
  // Mailpit's /raw is NOT the wire message: it prepends a `Bcc:` line that it
  // reconstructs from the envelope (envelope recipients minus To and Cc), above
  // even its own Received header. So `/raw` cannot answer "did the Bcc travel
  // in the headers" — it always says yes. The wire bytes are asserted in
  // test/compose.test.ts; what this checks is the observable consequence.
  check(
    'the Bcc recipient received it',
    sent.accepted.includes('hidden@example.net')
  );
  check(
    'the Bcc recipient is in neither To nor Cc',
    ![...message.To, ...message.Cc].some(
      (a) => a.Address === 'hidden@example.net'
    )
  );
  check(
    'the Message-ID matches what was reported',
    raw.includes(sent.message_id)
  );
  check('X-Mailer is on the wire', /^X-Mailer: smtp-mcp\//m.test(raw));
  check(
    'the signature is in the text part',
    message.Text.includes('Sent from the smtp-mcp sandbox')
  );
  check('the tracking pixel never left', !raw.includes('tracker.example'));
  check('the script never left', !raw.includes('steal()'));
  check(
    'the attachment arrived with its name and type',
    message.Attachments.length === 1 &&
      message.Attachments[0].FileName === 'report.pdf' &&
      message.Attachments[0].ContentType === 'application/pdf',
    JSON.stringify(message.Attachments)
  );

  console.log('\nthreading');
  const replyFirst = await call('reply_mail', {
    to: ['anna@example.net'],
    original_subject: SUBJECT,
    body: 'Thanks.',
    quote: 'Sandbox body.',
    in_reply_to: sent.message_id,
    references: [sent.message_id],
  });
  await call('reply_mail', {
    to: ['anna@example.net'],
    original_subject: SUBJECT,
    body: 'Thanks.',
    quote: 'Sandbox body.',
    in_reply_to: sent.message_id,
    references: [sent.message_id],
    confirm_token: tokenOf(replyFirst),
  });
  const withReply = await mailpit('/messages');
  const reply = withReply.messages.find((m) => m.Subject.startsWith('Re: '));
  check('the reply arrived', reply !== undefined);
  if (reply !== undefined) {
    const replyRaw = await (
      await fetch(`${MAILPIT_API}/message/${reply.ID}/raw`)
    ).text();
    check(
      'the reply threads under the original',
      replyRaw.includes(`In-Reply-To: ${sent.message_id}`)
    );
    check('the quote is prefixed', replyRaw.includes('> Sandbox body.'));
  }

  await client.close();

  console.log(
    failures === 0
      ? `\nAll sandbox checks passed. Open http://127.0.0.1:${UI_PORT} to look at the messages.\n`
      : `\n${failures} sandbox check(s) failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nsandbox smoke test failed to run:', error.message);
  console.error(
    'Is the sandbox up? docker compose -f scripts/sandbox/docker-compose.yml up -d'
  );
  process.exit(1);
});
