import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
  type SmtpConfig,
} from './config.js';
import { SmtpError, ToolInputError } from './errors.js';

/** Result of handing one message to the SMTP server. */
export interface SendOutcome {
  accepted: string[];
  rejected: string[];
  /** The server's final reply line, verbatim. Upstream text; treat as data. */
  response: string;
}

export interface SendRequest {
  envelope: { from: string; to: string[] };
  raw: Buffer;
}

/**
 * The narrow surface this server uses.
 *
 * Narrow on purpose: `test/fake-smtp.ts` implements exactly this and nothing
 * more, which is what keeps the fake from drifting into fiction. Everything
 * nodemailer can do beyond these three calls is something this server has
 * decided not to do.
 */
export interface SmtpConnection {
  /** Opens a connection, negotiates TLS and authenticates. Sends nothing. */
  verify(): Promise<void>;
  send(request: SendRequest): Promise<SendOutcome>;
  close(): void;
}

export type SmtpClientFactory = (config: SmtpConfig) => SmtpConnection;

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

/**
 * The real transport.
 *
 * Three settings here are the difference between a secure connection and one
 * that looks secure, and each is set explicitly rather than left to a default.
 *
 * Exported so `test/smtp.test.ts` can assert on the options it produces.
 * Building a transporter opens no socket, so those assertions cost nothing —
 * and "STARTTLS is required, never opportunistic" is a security claim that
 * ought to have a test rather than only a comment.
 */
export function transportOptions(config: SmtpConfig): SMTPTransport.Options {
  return {
    host: config.host ?? '',
    port: config.port,
    secure: config.tls === 'implicit',
    // Forced, never opportunistic. Left to nodemailer's default, STARTTLS is
    // attempted when the server offers it and skipped when it does not — so an
    // attacker who can strip the capability from the EHLO response gets a
    // cleartext session and nothing says a word. `requireTLS` turns that into a
    // failed connection, which is the correct outcome.
    requireTLS: config.tls === 'starttls',
    // And "none" means none, not "encrypt if it happens to be offered". A mode
    // whose behaviour depends on the peer is a mode nobody can reason about.
    ignoreTLS: config.tls === 'none',
    auth:
      config.user === undefined || config.password === undefined
        ? undefined
        : { user: config.user, pass: config.password },
    // The library can log the whole SMTP dialogue — message bodies included —
    // to stdout. stdout is the MCP transport, so this is not optional.
    logger: false,
    debug: false,
    // Scoped to this transport: NODE_TLS_REJECT_UNAUTHORIZED would disable
    // certificate checking for the entire process.
    ...(config.insecureTls ? { tls: { rejectUnauthorized: false } } : {}),
    // The EHLO name. Left unset, nodemailer sends the machine's hostname, which
    // then travels in a Received header on every message this server sends —
    // publishing an internal name like `workstation.corp.internal` to every
    // recipient. The sender's own domain says nothing that the From header has
    // not already said.
    name: config.fromAddress?.split('@')[1] ?? 'localhost',
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}

export function createSmtpConnection(config: SmtpConfig): SmtpConnection {
  const transporter: Transporter = createTransport(transportOptions(config));

  return {
    async verify(): Promise<void> {
      await transporter.verify();
    },
    async send(request: SendRequest): Promise<SendOutcome> {
      // `raw` rather than a set of fields: the bytes handed over here are the
      // ones `preview_mail` showed and a human approved. Re-deriving the
      // message from fields would mean the approved thing and the sent thing
      // are assembled by two different code paths.
      const info = await transporter.sendMail({
        envelope: request.envelope,
        raw: request.raw,
      });
      return {
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        response: String(info.response ?? ''),
      };
    },
    close(): void {
      transporter.close();
    },
  };
}

/**
 * Turns a nodemailer failure into one this server can report.
 *
 * Note what is not copied: nodemailer attaches the command it was sending to
 * the error, and for an AUTH exchange that command contains the credentials.
 * Only the code and the server's reply text come across.
 */
export function asSmtpError(error: unknown, action: string): SmtpError {
  if (error instanceof SmtpError) return error;
  const source = error as
    | {
        code?: string;
        responseCode?: number;
        response?: string;
        message?: string;
      }
    | undefined;
  const code = source?.code;
  const response = typeof source?.response === 'string' ? source.response : '';
  const detail = source?.message ?? String(error);
  return new SmtpError(
    `smtp-mcp: ${action} failed: ${detail}`,
    typeof code === 'string' ? code : undefined,
    response
  );
}

/**
 * Holds the transport and refuses to use it when the configuration is
 * incomplete.
 *
 * The connection is created lazily rather than at startup: the server has to
 * complete the MCP handshake and answer `tools/list` without credentials, so
 * registries and sandbox inspectors can introspect it.
 */
export class SmtpClient {
  private connection: SmtpConnection | undefined;

  constructor(
    private readonly config: Config,
    private readonly factory: SmtpClientFactory = createSmtpConnection
  ) {}

  private assertConfigured(): void {
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) {
      throw new ToolInputError(`smtp-mcp: ${missingConfigMessage(missing)}`);
    }
  }

  private open(): SmtpConnection {
    this.connection ??= this.factory(this.config.smtp);
    return this.connection;
  }

  async verify(): Promise<void> {
    this.assertConfigured();
    try {
      await this.open().verify();
    } catch (error) {
      throw asSmtpError(error, 'connecting to the SMTP server');
    }
  }

  async send(request: SendRequest): Promise<SendOutcome> {
    this.assertConfigured();
    let outcome: SendOutcome;
    try {
      outcome = await this.open().send(request);
    } catch (error) {
      throw asSmtpError(error, 'sending the message');
    }
    // A server can accept the envelope and refuse individual recipients. That
    // is a partial delivery, and reporting it as success would tell the user
    // their message reached people it did not.
    if (outcome.accepted.length === 0) {
      throw new SmtpError(
        'smtp-mcp: the server accepted no recipients — the message was not delivered.',
        'EENVELOPE',
        outcome.response
      );
    }
    return outcome;
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }
}
