/**
 * The annotation block every non-sending tool of this server carries, and the
 * rule the sending ones follow.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * Sending is the case the four hints were not designed for, and this server is
 * the one where it matters most. A message that has been accepted for delivery
 * destroys nothing — and it is in somebody else's inbox and cannot be recalled.
 * `destructiveHint: true` is the closest the vocabulary comes to that, and it
 * is what the three sending tools say, but it is an approximation: the risk
 * here is outbound, not destructive. The dialog is the real gate, and unlike an
 * annotation it is enforced rather than advisory.
 *
 * `openWorldHint: false`: this server talks to the one SMTP relay it is
 * configured for, and `SMTP_ALLOWED_RECIPIENTS` decides who may be written to.
 * That the relay then carries the message across the internet is what a mail
 * server is for, not a property of the tool call.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
