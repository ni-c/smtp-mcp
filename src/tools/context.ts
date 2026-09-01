import type { Approver } from 'mcp-approval';

import type { Config } from '../config.js';
import type { RateLimiter } from '../ratelimit.js';
import type { SmtpClient } from '../smtp.js';

/** Everything the tool modules need, passed in rather than reached for. */
export interface ToolContext {
  client: SmtpClient;
  config: Config;
  limiter: RateLimiter;
  /** Asks the user, or falls back to the two-call token. */
  approval: Approver;
  /** This package's version, stamped into X-Mailer. */
  version: string;
}
