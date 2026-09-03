import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Prepares the throwaway Mailpit and the environment to point the server at.
 *
 * Mailpit needs no setup: it accepts mail from anyone, with or without
 * authentication, and that is exactly why the compose file binds to loopback —
 * published on `0.0.0.0` it is an open relay on the local network for as long
 * as it runs.
 *
 * The two ports are overridable because 8025 in particular is a popular one
 * and a workstation that already has something there should not need a patched
 * compose file. Pass the same values to `docker compose` and to the suite.
 */

const SMTP_PORT = process.env.MAILPIT_SMTP_PORT ?? '1025';
const UI_PORT = process.env.MAILPIT_UI_PORT ?? '8025';

export interface Sandbox {
  /** Mailpit's REST API, which is how "what actually arrived" is read back. */
  api: string;
  /** The whole environment the server is started with. */
  env: Record<string, string>;
  /** Holds the file `attachments: ['report.pdf']` refers to. */
  attachmentDir: string;
}

export async function bootstrap(): Promise<Sandbox> {
  const api = `http://127.0.0.1:${UI_PORT}/api/v1`;
  assertLoopback(api);
  await waitForHttp(`${api}/messages`, {
    timeoutSeconds: 120,
    ready: (response) => response.ok,
  });

  // A real file, so the attachment path has something to carry and the MIME
  // part is built from bytes rather than from a fixture string.
  const attachmentDir = await mkdtemp(join(tmpdir(), 'smtp-mcp-integration-'));
  await writeFile(
    join(attachmentDir, 'report.pdf'),
    '%PDF-1.7\nintegration attachment\n%%EOF\n'
  );

  await clearMailbox(api);

  return {
    api,
    attachmentDir,
    env: {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: SMTP_PORT,
      SMTP_TLS: 'none',
      SMTP_USER: 'sandbox',
      // Distinct from every other string in the fixture on purpose, so a test
      // can assert it never appears in a tool result. Mailpit accepts any
      // credentials, so the value is arbitrary.
      SMTP_PASSWORD: 'the-password-must-never-be-echoed',
      SMTP_FROM: 'Sandbox <sandbox@example.net>',
      // Off by default in this server, and the suite is the one place it is
      // deliberately on: nothing else in the repository sends anything.
      SMTP_ALLOW_SEND: 'true',
      SMTP_ALLOWED_RECIPIENTS: '@example.net',
      SMTP_ATTACHMENT_DIR: attachmentDir,
      SMTP_SIGNATURE: 'Sent from the smtp-mcp integration suite',
    },
  };
}

export async function clearMailbox(api: string): Promise<void> {
  await fetch(`${api}/messages`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
}

async function get(api: string, path: string): Promise<unknown> {
  const response = await fetch(`${api}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} for ${path}`);
  }
  return response.json();
}

export interface Summary {
  ID: string;
  Subject: string;
}

export interface Delivered {
  Subject: string;
  From: { Address: string };
  To: { Address: string }[];
  Cc: { Address: string }[];
  Text: string;
  Attachments: { FileName: string; ContentType: string }[];
}

export async function inbox(
  api: string
): Promise<{ messages_count: number; messages: Summary[] }> {
  return (await get(api, '/messages')) as {
    messages_count: number;
    messages: Summary[];
  };
}

export async function delivered(api: string, id: string): Promise<Delivered> {
  return (await get(api, `/message/${id}`)) as Delivered;
}

/**
 * The raw message, with one caveat that matters.
 *
 * Mailpit's `/raw` is **not** the wire message: it prepends a `Bcc:` line it
 * reconstructs from the envelope — envelope recipients minus To and Cc —
 * above even its own `Received` header. So `/raw` cannot answer "did the Bcc
 * travel in the headers": it always says yes. The wire bytes are asserted in
 * `test/compose.test.ts`; what the suite checks here is the observable
 * consequence instead.
 */
export async function raw(api: string, id: string): Promise<string> {
  const response = await fetch(`${api}/message/${id}/raw`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} for the raw message`);
  }
  return response.text();
}
