import type { SendOutcome, SendRequest, SmtpConnection } from '../src/smtp.js';

/** A message as the fake postmaster received it. */
export interface DeliveredMessage {
  envelope: { from: string; to: string[] };
  raw: string;
  headers: Map<string, string>;
  /** Everything after the header block, still MIME-encoded. */
  body: string;
}

/**
 * Parses the header block of an RFC 5322 message, unfolding continuation lines.
 *
 * Only good enough for assertions — it lowercases names, keeps the first
 * occurrence of a repeated header and does not decode encoded-words. That is
 * deliberate: a fake that reimplemented a mail parser would start agreeing with
 * bugs in the code it is testing.
 */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = block.replace(/\r\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/**
 * An in-memory SMTP server.
 *
 * It implements only what `SmtpConnection` declares, which is the point: the
 * narrow interface is what keeps this fake from drifting into fiction. Anything
 * a real server does that is not one of these three calls is something the code
 * under test has no way to depend on.
 */
export class FakeSmtp implements SmtpConnection {
  /** Every call made against this connection, for order assertions. */
  readonly calls: Array<{ name: string; args?: unknown }> = [];
  /** Everything that was actually accepted for delivery. */
  readonly delivered: DeliveredMessage[] = [];

  /** Thrown by the next call of any kind, then cleared. */
  failNext: Error | undefined;
  /** `verify()` fails while this is set. */
  verifyError: Error | undefined;
  /** Recipients the server refuses, lower-cased. */
  readonly rejects = new Set<string>();
  closed = false;

  private takeFailure(): void {
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      throw failure;
    }
  }

  verify(): Promise<void> {
    this.calls.push({ name: 'verify' });
    this.takeFailure();
    if (this.verifyError !== undefined) return Promise.reject(this.verifyError);
    return Promise.resolve();
  }

  send(request: SendRequest): Promise<SendOutcome> {
    this.calls.push({ name: 'send', args: request.envelope });
    this.takeFailure();

    const accepted = request.envelope.to.filter(
      (address) => !this.rejects.has(address.toLowerCase())
    );
    const rejected = request.envelope.to.filter((address) =>
      this.rejects.has(address.toLowerCase())
    );

    if (accepted.length > 0) {
      const raw = request.raw.toString('utf8');
      const end = raw.indexOf('\r\n\r\n');
      this.delivered.push({
        envelope: request.envelope,
        raw,
        headers: parseHeaders(end === -1 ? raw : raw.slice(0, end)),
        body: end === -1 ? '' : raw.slice(end + 4),
      });
    }

    return Promise.resolve({
      accepted,
      rejected,
      response: '250 2.0.0 Ok: queued as FAKE0001',
    });
  }

  close(): void {
    this.closed = true;
    this.calls.push({ name: 'close' });
  }

  /** The single message delivered so far, failing loudly if that is not true. */
  only(): DeliveredMessage {
    if (this.delivered.length !== 1) {
      throw new Error(
        `expected exactly one delivered message, got ${this.delivered.length}`
      );
    }
    // Checked immediately above; the index access is what needs the assertion.
    return this.delivered[0] as DeliveredMessage;
  }
}
