import {
  Client,
  InMemoryTransport,
  withInputRequired,
} from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { CallToolResult } from '@modelcontextprotocol/client';

import { DEFAULT_ATTACHMENT_TYPES, type Config } from '../src/config.js';
import { parseAllowlist } from '../src/recipients.js';
import { createServer } from '../src/server.js';
import { FakeSmtp } from './fake-smtp.js';

/**
 * A configuration for tests.
 *
 * Note the two defaults that mirror production rather than convenience:
 * `allowSend` is false, and the allowlist covers `@example.net` only. A test
 * that wants to send has to say so, which is the same decision an operator has
 * to make.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const allowedRecipientsRaw =
    overrides.allowedRecipientsRaw ?? '@example.net,partner@example.org';
  return {
    smtp: {
      host: 'smtp.example.net',
      port: 587,
      user: 'me@example.net',
      password: 'secret',
      tls: 'starttls',
      insecureTls: false,
      from: 'Me <me@example.net>',
      fromAddress: 'me@example.net',
      ...overrides.smtp,
    },
    allowSend: overrides.allowSend ?? false,
    elicitation: overrides.elicitation ?? true,
    allowedRecipients:
      overrides.allowedRecipients ?? parseAllowlist(allowedRecipientsRaw),
    allowedRecipientsRaw,
    maxRecipients: overrides.maxRecipients ?? 10,
    maxSendsPerHour: overrides.maxSendsPerHour ?? 20,
    maxMessageBytes: overrides.maxMessageBytes ?? 10 * 1024 * 1024,
    maxAttachmentBytes: overrides.maxAttachmentBytes ?? 5 * 1024 * 1024,
    attachmentDir: overrides.attachmentDir,
    allowedAttachmentTypes:
      overrides.allowedAttachmentTypes ?? DEFAULT_ATTACHMENT_TYPES,
    signature: overrides.signature,
    auditLog: overrides.auditLog,
    allowTools: overrides.allowTools,
    denyTools: overrides.denyTools,
  };
}

/** How a client with elicitation support answers the confirmation dialog. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel' | 'error';

export interface Harness {
  client: Client;
  smtp: FakeSmtp;
  /** Every message the server put in front of the user, in order. */
  prompts: string[];
  close(): Promise<void>;
}

/** Boots the real server against the fake SMTP and returns a connected client. */
export async function connect(
  options: {
    config?: Partial<Config>;
    smtp?: FakeSmtp;
    /** Omitted means the client does not support elicitation at all. */
    elicit?: ElicitBehaviour;
  } = {}
): Promise<Harness> {
  const smtp = options.smtp ?? new FakeSmtp();
  const config = testConfig(options.config ?? {});
  const prompts: string[] = [];

  const server = createServer(config, { smtpFactory: () => smtp });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'test', version: '0.0.0' },
    options.elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );

  if (options.elicit !== undefined) {
    const behaviour = options.elicit;
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      // Recorded so a test can assert on exactly what the human was shown —
      // which, for this server, is most of the security argument.
      prompts.push(params.message ?? '');
      if (behaviour === 'error') throw new Error('dialog unavailable');
      if (behaviour === 'cancel') return { action: 'cancel' };
      if (behaviour === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    smtp,
    prompts,
    close: async () => {
      await client.close();
    },
  };
}

export async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

/** Parses the JSON payload out of a tool result, ignoring any preamble. */
export function jsonOf(result: CallToolResult): unknown {
  const text = textOf(result);
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`no JSON in result: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

/** Pulls the confirm_token out of a confirmation prompt. */
export function tokenOf(result: CallToolResult): string {
  const match = /confirm_token="([0-9a-f]+)"/.exec(textOf(result));
  if (match?.[1] === undefined) {
    throw new Error(`no confirm token in: ${textOf(result)}`);
  }
  return match[1];
}

/** A minimal valid send_mail argument set, for tests that vary one thing. */
export function sendArgs(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    to: ['anna@example.net'],
    subject: 'Quarterly report',
    body: 'Here it is.',
    ...overrides,
  };
}

export interface ModernHarness {
  client: Client;
  smtp: FakeSmtp;
  /** One `send_mail` leg, carrying whatever the previous one asked for. */
  send(
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ): Promise<InputRequiredView>;
  close(): Promise<void>;
}

/** Enough of a result to tell a question from an answer. */
export interface InputRequiredView {
  resultType?: string;
  requestState?: string;
  inputRequests?: Record<string, { params: { message: string } }>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * The server on the 2026-07-28 revision, with the round trip left to the test.
 *
 * `connect()` above wires the transport by hand, which pins the connection to
 * the 2025 era — there the SDK's legacy shim answers the question in-process
 * and a test never sees it. serveStdio owns the era decision, and
 * `autoFulfill: false` keeps the client from answering on the user's behalf, so
 * a test can hand back exactly what it wants to hand back: the right answer,
 * no state, or somebody else's.
 */
export async function connectModern(
  options: { config?: Partial<Config>; smtp?: FakeSmtp } = {}
): Promise<ModernHarness> {
  const smtp = options.smtp ?? new FakeSmtp();
  const config = testConfig(options.config ?? {});
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createServer(config, { smtpFactory: () => smtp }),
    { transport: serverTransport }
  );
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false },
    }
  );
  await client.connect(clientTransport);

  return {
    client,
    smtp,
    send: async (args, extra = {}) =>
      (await client.request(
        {
          method: 'tools/call',
          params: { name: 'send_mail', arguments: args, ...extra },
        },
        withInputRequired(CallToolResultSchema),
        { allowInputRequired: true }
      )) as InputRequiredView,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}
