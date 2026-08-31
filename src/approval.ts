import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  confirmationPrompt,
  renderDetails,
  type ConfirmationDetail,
  type ConfirmationStore,
} from './confirm.js';
import { ToolInputError } from './errors.js';
import { textResult } from './result.js';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** How long the server waits for the human to answer the dialog. */
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

export interface ApprovalRequest {
  /** What is about to happen, in server-side facts only. */
  what: string;
  /** Why it cannot be undone. */
  consequence: string;
  /** Stable key binding the fallback token to this exact message. */
  resourceKey: string;
  /** Token the caller supplied, if any. Only used on the fallback path. */
  token: string | undefined;
  /**
   * Values the caller chose — recipients and the subject above all. Rendered on
   * their own labelled lines rather than inside {@link what}, so a subject
   * written to read like an instruction cannot become part of the server's
   * sentence.
   */
  details?: readonly ConfirmationDetail[];
}

/**
 * Either a result to return to the caller instead of acting, or permission to
 * proceed.
 */
export type ApprovalOutcome =
  { approved: true } | { approved: false; result: CallToolResult };

/**
 * Asks a human before a message is sent.
 *
 * Why this exists next to {@link ConfirmationStore}: the confirmation token is
 * not a human-in-the-loop gate and never was. It is returned inside a tool
 * result, which means the model reads it and can call again in the same turn
 * without anyone seeing the dialog. That still catches a model that widens the
 * recipient list by accident, but a model which has been talked into mailing
 * the customer list to a stranger will happily call twice.
 *
 * MCP elicitation closes that hole: the request goes to the client, which shows
 * it to the person sitting there, and the model cannot answer on their behalf.
 * Clients that do not support it fall back to the token, because refusing to
 * work at all would push people towards turning the guard off entirely — and on
 * this server the guard is one of the four things standing between a prompt
 * injection and an outbound message.
 */
export async function requestApproval(
  server: McpServer,
  confirmations: ConfirmationStore,
  request: ApprovalRequest
): Promise<ApprovalOutcome> {
  if (server.server.getClientCapabilities()?.elicitation !== undefined) {
    return elicit(server, request);
  }

  if (confirmations.consume(request.resourceKey, request.token)) {
    return { approved: true };
  }
  return {
    approved: false,
    result: textResult(
      `${confirmationPrompt(
        request.what,
        confirmations.issue(request.resourceKey),
        confirmations.ttlMinutes,
        request.consequence,
        request.details ?? []
      )}\n\nNote: this client cannot ask the user directly, so this check only ` +
        'proves the call was made twice with the same arguments. A human should ' +
        'read the lines above before you continue.'
    ),
  };
}

async function elicit(
  server: McpServer,
  request: ApprovalRequest
): Promise<ApprovalOutcome> {
  let response;
  try {
    response = await server.server.elicitInput(
      {
        // Server-side facts only: no message body reaches this string. It is
        // rendered to a human, but it is composed by us — and the caller-chosen
        // values go through renderDetails rather than into the sentence, so
        // none of it is a place to hide an instruction.
        message:
          `${request.what}\n\n${request.consequence}` +
          renderDetails(request.details ?? []),
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Send this message?',
              description: 'Tick to send it, leave it to cancel.',
            },
          },
          required: ['confirm'],
        },
      },
      { timeout: ELICITATION_TIMEOUT_MS }
    );
  } catch (error) {
    // A timeout, a client that advertised the capability but cannot deliver, a
    // dropped connection: all of them mean nobody said yes.
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(
      `smtp-mcp: could not obtain confirmation from the user (${reason}). Nothing was sent.`
    );
  }

  if (response.action !== 'accept' || response.content?.confirm !== true) {
    throw new ToolInputError('smtp-mcp: the user declined. Nothing was sent.');
  }
  return { approved: true };
}
