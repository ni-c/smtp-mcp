# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->
<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Added

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result.

  `preview_mail` carries the untrusted marker as `untrusted: true` and
  `source: "smtp"` fields — a quoted original was written by whoever sent it,
  and anyone in the world can send mail. Its text block keeps the nonce fence;
  the structured half states the same fields rather than making a client parse
  it. No other tool carries the marker, because no other tool reports anything
  this server did not write itself.

### Security

- **The HTML sanitiser modelled a space, not the tokenizer.** Every attribute
  pattern looked for whitespace in front of the attribute name and read the
  value literally, and an HTML tokenizer does neither. Eleven shapes went out
  untouched with an empty removal list — `<img/src=…>`, `<img alt="x"src=…>`,
  `src="&#104;ttps://…"`, `https&colon;//…`, `\\host/…`, `u\72l(…)` in a style,
  and `<link>`, `<base>` and `<meta>` behind an unquoted `<`, which the final
  refusal check did not name. Attribute patterns now start after whitespace,
  `/` or a quote; scheme and remote checks run on the decoded value with
  backslashes read as slashes; inline styles are decoded as CSS and dropped
  when anything in them fetches; and the refusal check is built from the same
  element list as the removal passes. Found by an internal audit.

- **An attachment was checked on its path and read from whatever was there a
  moment later.** A writer in `SMTP_ATTACHMENT_DIR` could swap in a FIFO — the
  blocking open then waited forever — or grow the file past the ceiling, which
  `readFile` then allocated in full. The open is non-blocking, type and size
  are checked again on the opened handle, and the read is capped at the size
  the handle reported.

- **A message that could not fit was composed anyway, then refused.** Ten
  attachments at the default ceiling are 67 MB once base64 has run over them,
  all of it built and then refused by the exact check — through `preview_mail`,
  which has no gate, no confirmation and no rate limit. A lower bound is taken
  before composing and what cannot fit is refused without being built.

- **The confirmation dialog's consequence carried caller-derived text without a
  cap.** The list of HTML removals names the scheme of a stripped URL, and a
  scheme is whatever the caller wrote before the colon — up to the whole HTML
  ceiling. `mcp-approval` flattens and caps every _detail_ and leaves the
  consequence alone, so the list moved to a detail line and the scheme is cut
  at 24 characters.

- `text/html` and `application/zip` are no longer in the default attachment
  types. An HTML file opens in a browser with none of a mail client's
  restrictions and none of the sanitising the HTML _part_ of a message gets;
  an archive passes the magic-byte check on its own bytes and can carry the
  executable the check never sees. Both remain available through
  `SMTP_ATTACHMENT_TYPES`.

- A Message-ID, `in_reply_to` or `references` entry is printable ASCII without
  whitespace or angle brackets. nodemailer writes these three headers byte for
  byte, so a non-ASCII character was an 8-bit header on the wire and U+2028
  quietly split one identifier into two.

### Added

- **Refused sends are in the audit log.** A refusal by the allowlist or the
  attachment checks, a declined dialog and a rejected token each write a line
  marked `outcome=refused`, `declined` or `token_rejected`, with the recipients
  and subject that were asked for and never the body. A log of what went out
  cannot show that a session was being steered; the refusals can.

- The confirmation dialog shows the HTML part **as the recipient reads it**,
  derived from the sanitised markup, beside the raw markup. The first 200
  characters of markup are mostly tags, and on a message with an empty body the
  HTML is the message. It also says when the plain-text body and the HTML part
  say different things — most recipients see only the latter — and
  `preview_mail` reports the same as `text_html_diverge`.

- The injection detector's findings are kept per field, and the dialog says
  whose words matched: a quote that gives orders is a forwarded message trying
  to, a body that gives orders is the model writing them. `preview_mail` reports
  the fields as `suspicious_in`.

### Fixed

- **The three send tools reported `accepted` as two different types.** A first
  send answered with the list of addresses the SMTP server took; a repeat of a
  message already accepted answered with a count of them, under the same key.
  Both now answer with the addresses, and the at-most-once path also states
  `already_sent`, `rejected` and the same `note` field — one shape a client can
  read, rather than two it has to tell apart. Found by having to declare what
  these tools return.

### Changed

- The advertised schemas avoid a spelling that is legal JSON Schema and still
  gets a tool refused, or its constraint silently dropped, by some MCP clients:
  a nullable field is written as `anyOf` branches rather than `"type":
["string", "null"]`, which several clients read as a single type and then
  drop. What the tools accept and return is unchanged; only the way the schema
  says so is.

- A result too large to shrink is now an error rather than an envelope carrying
  the oversized document as a string. The envelope was valid JSON and is no
  longer a valid _answer_: the SDK validates each result against the schema the
  tool declares, and there is no true answer of that size.

- The two-call `confirm_token` prompt is an error result. The message was not
  sent, which is what `isError` says — and a tool that declares an output schema
  may not answer without `structuredContent` unless the result is an error. The
  text is unchanged and still carries the token.

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Added

- Initial implementation: an MCP server that sends mail over SMTP, as the counterpart to
  [imap-mcp](https://github.com/ni-c/imap-mcp), which deliberately cannot.
- Seven tools. Four are always available and cannot put a message on the wire —
  `get_server_info`, `validate_recipients`, `preview_mail` and `test_connection`. Three send:
  `send_mail`, `reply_mail` and `forward_mail`.
- **`SMTP_ALLOW_SEND` defaults to `false`.** Note the direction: the read/write variables
  elsewhere in this family guard changes to a system the operator already owns, while this one
  guards a channel out of it. Until it is set the sending tools are not registered at all.
- **`SMTP_ALLOWED_RECIPIENTS` is required to enable sending.** An unset allowlist is refused at
  startup rather than treated as "anyone"; allowing everyone is spelled `*`.
- Every send asks a human through MCP elicitation, falling back to a two-call token bound to a
  fingerprint of the recipients _and_ the content.
  `ELICITATION=false` takes that fallback deliberately, for a deployment where a dialog is the
  wrong shape rather than an unwanted one — it never removes the guard, the fallback text then
  names this server rather than blaming the client, and a server started with it off says so on
  one startup line. The variable carries no prefix on purpose, so one export reaches every MCP
  server in the environment; this is the one where that costs the most. A value that is neither
  `true` nor `false` stops the server, like `SMTP_TLS` and unlike `SMTP_ALLOW_SEND`, because it
  is the only variable here that defaults to on.
- The sender is fixed by `SMTP_FROM`. There is no `from` parameter.
- Hourly send cap (`SMTP_MAX_SENDS_PER_HOUR`) and a per-message recipient cap
  (`SMTP_MAX_RECIPIENTS`).
- Attachments are read only from `SMTP_ATTACHMENT_DIR`, behind an extension allowlist, an
  executable-extension refusal, a symlink refusal and a magic-byte check.
- Outgoing HTML is sanitised: scripts, event handlers, remotely loaded images and unsafe URL
  schemes are removed, and every removal is reported rather than applied silently. Markup that is
  still dangerous after every pass has run — the case a regex cannot resolve and the recipient's
  parser can — **refuses** the message instead of repairing it, which is also what keeps the
  reported removals honest. "Remotely loaded" covers `src`, `srcset`, `imagesrcset`, `poster` and
  `background`, each `srcset` candidate on its own.
- **At most once.** A message the SMTP server accepted is remembered, by the same fingerprint the
  approval is bound to, for as long as an approval for it could still be redeemed; an identical
  send inside that window is answered with the earlier Message-ID instead of going out again. An
  approval proves that somebody agreed to a message, not that they agreed to it a second time —
  and a tool call is at-least-once by nature, so a client that times out and retries, a host that
  reconnects or a model that repeats itself would otherwise send a second copy. `send_mail` is
  the one operation in this family that is not idempotent. SECURITY.md records which protocol
  revision exposes a replayable approval, which one this server actually negotiates, and what to
  check the day that changes. The residual case — a connection lost after the end of `DATA`,
  where the outcome is genuinely unknown — keeps the rate-limit slot and writes an audit line
  saying so, rather than being covered over.
- The confirmation dialog shows the **body**, and the quoted original and HTML part when set,
  each labelled with its length in characters. Every other layer binds the envelope; nothing
  looked at what the message said.
- A subject may not contain an RFC 2047 encoded-word (`=?utf-8?B?…?=`). It travels as ASCII and
  decodes to something else at the recipient, so the human would approve a subject other than the
  one that arrives.
- `get_server_info` reports `elicitation_enabled` and a `confirmation` field that follows the
  configuration, replacing a constant that claimed a human was always asked even with
  `ELICITATION=false`.
- Audit lines quote every string value and every array element, always. A subject without a space
  in it used to be written bare, so `Invoice_bcc=[quiet@evil.example]_accepted=1` handed any
  parser a `bcc` field that never existed.
- A quoted original is passed on unchanged; matches against known prompt-injection shapes are
  surfaced in the confirmation dialog instead.
- Every accepted message is recorded on stderr, and optionally in `SMTP_AUDIT_LOG`. Never the
  body.
- `SMTP_ALLOW_TOOLS` / `SMTP_DENY_TOOLS` narrow the tool list; `essential` selects a curated
  five.
- A throwaway Mailpit sandbox in `scripts/sandbox/`, with an end-to-end smoke script that sends
  through a real SMTP server and reads the message back to check what actually arrived.

### Notes

This version has not been released, so the entries above describe the server as it stands rather
than as a set of changes. Two things about how it is built are worth recording here anyway,
because they are visible in the dependency tree:

- The tool filter, the confirmation store, the approval flow, the host classifier and the
  documentation-asset generator come from **`mcp-tool-allowlist`**, **`mcp-approval`**,
  **`mcp-internal-hosts`** and **`svg-asset-set`** rather than from copies kept here. The
  approval flow in particular was written here and in imap-mcp, and became a library once the
  two had grown near-identical copies of it. None of the packages has a runtime dependency of
  its own, so this makes the tree smaller rather than larger.

- The server runs on **MCP SDK 2.0** and is built with **oxlint** and **TypeScript 7**.

One behaviour follows from the first of those and is worth stating plainly, because it concerns
the gate in front of sending: a `confirm_token` that does not match the exact message is refused
with the reason rather than answered with a fresh prompt. The binding is unchanged — a token
issued for one recipient list or one body cannot spend itself on another — and nothing is sent
either way.

<!-- #endregion changelog -->
