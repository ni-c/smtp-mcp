import type { Approver } from 'mcp-approval';

import type { Config } from '../config.js';
import type { RateLimiter } from '../ratelimit.js';
import type { SentRegistry } from '../sent.js';
import type { SmtpClient } from '../smtp.js';

/** Everything the tool modules need, passed in rather than reached for. */
export interface ToolContext {
  client: SmtpClient;
  config: Config;
  limiter: RateLimiter;
  /** Asks the user, or falls back to the two-call token. */
  approval: Approver;
  /** What already went out, so a retried call does not send it twice. */
  sent: SentRegistry;
  /** This package's version, stamped into X-Mailer. */
  version: string;
}
