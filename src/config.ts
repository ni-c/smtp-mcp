import { internalHostKind } from 'mcp-internal-hosts';
import { parseAllowlist, type RecipientRule } from './recipients.js';

/** How the connection to the SMTP server is encrypted. */
export type TlsMode = 'implicit' | 'starttls' | 'none';

export interface SmtpConfig {
  host: string | undefined;
  port: number;
  user: string | undefined;
  password: string | undefined;
  tls: TlsMode;
  insecureTls: boolean;
  /**
   * The From header, in whatever display form the operator configured:
   * `willi@example.net` or `Willi Thiel <willi@example.net>`.
   *
   * There is no `from` tool parameter anywhere in this server. A model that can
   * choose its own sender can write in a colleague's name, and the resulting
   * message is indistinguishable from one they wrote — so the sender is
   * operator configuration, full stop.
   */
  from: string | undefined;
  /** The bare address out of {@link from}, used as the envelope sender. */
  fromAddress: string | undefined;
}

export interface Config {
  smtp: SmtpConfig;
  /**
   * When false — the default — the sending tools are not registered at all.
   *
   * Note the default, which is the opposite of the read/write variables in the
   * rest of this family. Those guard changes to a system the operator already
   * owns; this one guards a channel out of it. A freshly installed smtp-mcp
   * that pointed at a real mailbox and sent on the first tool call would be a
   * server whose worst day happens before anybody has read its README.
   */
  allowSend: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   *
   * This is the server where a globally set `ELICITATION=false` costs the most:
   * every send asks, and the fallback token is something a model can satisfy
   * on its own. The startup line and the fallback wording exist for that.
   */
  elicitation: boolean;

  /**
   * Who may receive mail. Empty means nothing was configured, which is only
   * reachable while {@link allowSend} is false — see `loadConfig`.
   */
  allowedRecipients: RecipientRule[];
  /** Raw value of SMTP_ALLOWED_RECIPIENTS, for the configuration summary. */
  allowedRecipientsRaw: string | undefined;
  maxRecipients: number;
  maxSendsPerHour: number;
  maxMessageBytes: number;
  maxAttachmentBytes: number;
  /**
   * Where attachments may be read from. Unset means this server never touches
   * the filesystem — setting it is the opt-in, and it is the only source of the
   * directory. A caller cannot choose which part of the disk gets mailed out.
   */
  attachmentDir: string | undefined;
  allowedAttachmentTypes: string[];
  /** Appended to the plain-text body of every message, if set. */
  signature: string | undefined;
  /** Extra file sink for the audit lines that always go to stderr. */
  auditLog: string | undefined;
  /**
   * Raw value of `SMTP_ALLOW_TOOLS` — comma-separated tool names, `send_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror
   * of the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `SMTP_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

export const DEFAULT_ATTACHMENT_TYPES = [
  'application/pdf',
  'application/json',
  'application/xml',
  'application/zip',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'text/html',
  'text/calendar',
];

const DEFAULT_MAX_RECIPIENTS = 10;
const DEFAULT_MAX_SENDS_PER_HOUR = 20;
/** Composed message, after base64 expands attachments by roughly a third. */
const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_SIGNATURE_MAX = 2000;

/** Shown when the configuration is incomplete — at startup and on every call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: SMTP_HOST (e.g. smtp.example.net), SMTP_USER, SMTP_PASSWORD, ' +
    'SMTP_FROM (the only sender this server will use)\n' +
    'Optional: SMTP_PORT, SMTP_TLS (starttls|implicit|none), ' +
    'SMTP_ALLOW_SEND=true to expose the sending tools (it defaults to false), ' +
    'SMTP_ALLOWED_RECIPIENTS (required with SMTP_ALLOW_SEND=true), ' +
    'SMTP_MAX_RECIPIENTS, SMTP_MAX_SENDS_PER_HOUR, SMTP_ATTACHMENT_DIR to ' +
    'allow attachments, SMTP_SIGNATURE, SMTP_AUDIT_LOG, SMTP_ALLOW_TOOLS / ' +
    'SMTP_DENY_TOOLS to narrow the tool list, SMTP_INSECURE_TLS=true to accept ' +
    'self-signed certificates'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [
    !config.smtp.host && 'SMTP_HOST',
    !config.smtp.user && 'SMTP_USER',
    !config.smtp.password && 'SMTP_PASSWORD',
    !config.smtp.from && 'SMTP_FROM',
  ].filter((v): v is string => Boolean(v));
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. Malformed values still
 * exit — a host with a newline in it could smuggle a second command into the
 * SMTP session, and a bad port would connect somewhere unintended.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.SMTP_HOST;
  const user = env.SMTP_USER;
  const password = env.SMTP_PASSWORD;

  // Removed here, before any branch below can return or exit: the password must
  // not stay in the environment for the process lifetime, where it is visible
  // to child processes and in /proc/<pid>/environ. Doing this after the
  // validation below would leave it in place on exactly the paths where
  // somebody attaches an inspector to work out why the server will not start.
  delete env.SMTP_PASSWORD;

  const tls = parseTlsMode(env.SMTP_TLS);
  // After the password delete, deliberately: this one can exit the process, and
  // an exit above the delete would leave the password in the environment for
  // whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  if (host !== undefined) assertSafeHost(host, 'SMTP_HOST');

  const from = env.SMTP_FROM?.trim() || undefined;
  if (from !== undefined) assertSingleLine(from, 'SMTP_FROM');
  const fromAddress = from === undefined ? undefined : parseFromAddress(from);

  const signature = env.SMTP_SIGNATURE || undefined;
  if (signature !== undefined && signature.length > DEFAULT_SIGNATURE_MAX) {
    console.error(
      `smtp-mcp: SMTP_SIGNATURE must be at most ${DEFAULT_SIGNATURE_MAX} characters`
    );
    process.exit(1);
  }

  const auditLog = env.SMTP_AUDIT_LOG || undefined;
  if (auditLog !== undefined) assertSingleLine(auditLog, 'SMTP_AUDIT_LOG');

  const attachmentDir = env.SMTP_ATTACHMENT_DIR || undefined;
  if (attachmentDir !== undefined) {
    assertSingleLine(attachmentDir, 'SMTP_ATTACHMENT_DIR');
  }

  const allowedRecipientsRaw = env.SMTP_ALLOWED_RECIPIENTS;
  let allowedRecipients: RecipientRule[];
  try {
    allowedRecipients = parseAllowlist(allowedRecipientsRaw);
  } catch (error) {
    console.error(
      `smtp-mcp: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  const config: Config = {
    smtp: {
      host,
      port: parsePort(env.SMTP_PORT, defaultPort(tls), 'SMTP_PORT'),
      user,
      password,
      tls,
      insecureTls: env.SMTP_INSECURE_TLS === 'true',
      from,
      fromAddress,
    },
    // Defaults to false — see the field comment.
    allowSend: env.SMTP_ALLOW_SEND === 'true',
    elicitation,
    allowedRecipients,
    allowedRecipientsRaw,
    maxRecipients: parseCount(
      env.SMTP_MAX_RECIPIENTS,
      DEFAULT_MAX_RECIPIENTS,
      'SMTP_MAX_RECIPIENTS'
    ),
    maxSendsPerHour: parseCount(
      env.SMTP_MAX_SENDS_PER_HOUR,
      DEFAULT_MAX_SENDS_PER_HOUR,
      'SMTP_MAX_SENDS_PER_HOUR'
    ),
    maxMessageBytes: parseCount(
      env.SMTP_MAX_MESSAGE_BYTES,
      DEFAULT_MAX_MESSAGE_BYTES,
      'SMTP_MAX_MESSAGE_BYTES'
    ),
    maxAttachmentBytes: parseCount(
      env.SMTP_MAX_ATTACHMENT_BYTES,
      DEFAULT_MAX_ATTACHMENT_BYTES,
      'SMTP_MAX_ATTACHMENT_BYTES'
    ),
    attachmentDir,
    allowedAttachmentTypes: parseTypes(env.SMTP_ATTACHMENT_TYPES),
    signature,
    auditLog,
    allowTools: env.SMTP_ALLOW_TOOLS,
    denyTools: env.SMTP_DENY_TOOLS,
  };

  // Turning sending on without saying who may receive is the one combination
  // that must not start. The alternative — treating an unset allowlist as
  // "anyone" — is the accident: it is what a hurried compose file produces, it
  // reads as a missing line rather than as a decision, and the failure it
  // causes is a message already delivered. Whoever genuinely wants no
  // restriction writes SMTP_ALLOWED_RECIPIENTS=* and owns that choice.
  if (config.allowSend && config.allowedRecipients.length === 0) {
    console.error(
      'smtp-mcp: SMTP_ALLOW_SEND=true requires SMTP_ALLOWED_RECIPIENTS. List ' +
        'the addresses or domains this server may write to, for example ' +
        '"@example.net,partner@example.org". Use "*" to allow any recipient — ' +
        'that is a deliberate choice and has to be written down as one.'
    );
    process.exit(1);
  }

  const missing = missingConfigKeys(config);
  if (missing.length > 0) {
    console.error(`smtp-mcp: ${missingConfigMessage(missing)}`);
  }
  if (config.smtp.tls === 'none' && !isLoopbackHost(host)) {
    console.error(
      'smtp-mcp: WARNING: SMTP_TLS=none against a non-local host — the ' +
        'password and every message will cross the network unencrypted.'
    );
  }

  return config;
}

function defaultPort(tls: TlsMode): number {
  if (tls === 'implicit') return 465;
  if (tls === 'starttls') return 587;
  return 25;
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, and nowhere more
 * than here — this is the server that asks before every single message it
 * sends — which is why a server started with it off says so on its startup line.
 *
 * Fatal, like `parseTlsMode` below and unlike `SMTP_ALLOW_SEND`: this is the
 * first variable of the family that defaults to *on*, so a typo that fell back
 * to the default would leave the dialog running while the operator believes it
 * is off — and an operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  console.error(
    `smtp-mcp: ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

function parseTlsMode(raw: string | undefined): TlsMode {
  // STARTTLS on 587 rather than implicit TLS on 465: submission is what an
  // authenticated client is supposed to use, and it is what every provider in
  // this family's reach offers. The mode is still explicit in every case —
  // opportunistic upgrading is never a behaviour of this server, because a
  // downgrade attack against it succeeds silently.
  if (raw === undefined || raw === '') return 'starttls';
  if (raw === 'implicit' || raw === 'starttls' || raw === 'none') return raw;
  console.error('smtp-mcp: SMTP_TLS must be one of starttls, implicit or none');
  process.exit(1);
}

function parsePort(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    // The value itself is not echoed: config errors end up in logs, and this
    // branch is where a token pasted into the wrong variable arrives.
    console.error(`smtp-mcp: ${name} must be an integer between 1 and 65535`);
    process.exit(1);
  }
  return value;
}

function parseCount(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`smtp-mcp: ${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

function parseTypes(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ATTACHMENT_TYPES;
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '');
}

/**
 * Pulls the bare address out of a From header value.
 *
 * The envelope sender has to be an address and nothing else; the display name
 * only belongs in the header. Getting this wrong produces a MAIL FROM the
 * server rejects with a message about syntax, three layers away from the
 * variable that caused it.
 */
function parseFromAddress(value: string): string {
  const angled = /<([^<>]+)>\s*$/.exec(value);
  const address = (angled?.[1] ?? value).trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(address)) {
    console.error(
      'smtp-mcp: SMTP_FROM must be an email address, either bare ' +
        '(person@example.net) or with a display name ' +
        '(Person Name <person@example.net>)'
    );
    process.exit(1);
  }
  return address;
}

/**
 * Rejects anything that could break out of the line it is written on. SMTP is a
 * line protocol; a CR or LF in a hostname is a command-smuggling primitive, not
 * a typo.
 */
function assertSafeHost(value: string, name: string): void {
  // A hostname or IPv4 address — or an IPv6 address, which is the only place a
  // colon is legal. Allowing ":" everywhere would silently accept
  // "smtp.example.net:587", which the error message promises to reject.
  const hostname = /^[A-Za-z0-9._-]+$/.test(value);
  const ipv6 = /^\[?[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\]?$/.test(value);
  if (!hostname && !ipv6) {
    console.error(
      `smtp-mcp: ${name} must be a plain hostname or IP address without ` +
        'scheme, port, credentials or whitespace'
    );
    process.exit(1);
  }
}

function assertSingleLine(value: string, name: string): void {
  if (/[\r\n\0]/.test(value)) {
    console.error(`smtp-mcp: ${name} must not contain line breaks`);
    process.exit(1);
  }
}

/**
 * Whether the plain-text warning applies. Uses the shared host classifier so
 * `127.0.0.1`, `::1`, `::ffff:127.0.0.1` and `localhost` all count — an
 * IPv4-mapped loopback address is still loopback, and a hand-rolled
 * `startsWith('127.')` misses it.
 */
function isLoopbackHost(hostname: string | undefined): boolean {
  if (hostname === undefined) return false;
  return internalHostKind(hostname) === 'loopback';
}
