/**
 * The tool names this server has.
 *
 * Declared here rather than derived from what reached `registerTool`, because
 * the filter has to answer "is this a name you have?" *before* anything is
 * registered — and with `SMTP_ALLOW_SEND` unset the sending tools never reach
 * registration at all. A catalogue built from the registrations would report
 * "unknown tool" for `send_mail`, which is the one answer that is wrong: the
 * tool exists, and the send gate suppresses it.
 *
 * `test/catalogue.test.ts` compares these lists against a real server, which is
 * also why no test file keeps a second copy of the names.
 */

/** Registered always. None of these can put a message on the wire. */
export const INFO_TOOLS = [
  'get_server_info',
  'validate_recipients',
  'preview_mail',
  'test_connection',
] as const;

/** Registered only when `SMTP_ALLOW_SEND=true`. */
export const SEND_TOOLS = ['send_mail', 'reply_mail', 'forward_mail'] as const;

export const ALL_TOOLS = [...INFO_TOOLS, ...SEND_TOOLS] as const;

/**
 * The curated preset selected by `SMTP_ALLOW_TOOLS=essential`.
 *
 * Editorial, not mechanical: the five tools that complete the job end to end —
 * find out how the server is configured, check the recipients, look at the
 * message, send it, answer one. `forward_mail` is left out because forwarding
 * carries somebody else's content and attachments outward, which is the call
 * that most deserves to be switched on deliberately, and `test_connection` is
 * diagnostics rather than work.
 */
export const ESSENTIAL_TOOLS = [
  'get_server_info',
  'validate_recipients',
  'preview_mail',
  'send_mail',
  'reply_mail',
] as const;
