# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->
<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [0.1.0] - 2026-09-03

### Added

- Initial release: an MCP server that sends mail over SMTP, as the counterpart to
  [imap-mcp](https://github.com/ni-c/imap-mcp), which deliberately cannot.
- A multi-architecture container image at `ghcr.io/ni-c/smtp-mcp` (amd64 and arm64),
  published with an SBOM and build provenance. It runs as an unprivileged user and speaks
  stdio only, so it needs `-i` and exposes no port.
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
  looked at what the message said. The HTML part appears twice — as markup, and **as the
  recipient reads it**, derived from the sanitised source, because the first 200 characters of
  markup are mostly tags and on a message with an empty body the HTML _is_ the message. The
  dialog also says when the plain-text body and the HTML part say different things, since most
  recipients see only the latter; `preview_mail` reports the same as `text_html_diverge`.
- The injection detector's findings are kept per field, and the dialog says whose words matched:
  a quote that gives orders is a forwarded message trying to, a body that gives orders is the
  model writing them. `preview_mail` reports the fields as `suspicious_in`.
- A quoted original is passed on unchanged; matches against known prompt-injection shapes are
  surfaced in the confirmation dialog instead.
- A subject may not contain an RFC 2047 encoded-word (`=?utf-8?B?…?=`). It travels as ASCII and
  decodes to something else at the recipient, so the human would approve a subject other than the
  one that arrives.
- `get_server_info` reports `elicitation_enabled` and a `confirmation` field that follows the
  configuration, so it never claims a human is asked when `ELICITATION=false` says otherwise.
- Every accepted message is recorded on stderr, and optionally in `SMTP_AUDIT_LOG`. Never the
  body. **Refusals are logged too** — a refusal by the allowlist or the attachment checks, a
  declined dialog and a rejected token each write a line marked `outcome=refused`, `declined` or
  `token_rejected`, with the recipients and subject that were asked for. A log of what went out
  cannot show that a session was being steered; the refusals can. Audit lines quote every string
  value and every array element, always, so a subject like `Invoice_bcc=[quiet@evil.example]`
  cannot hand a parser a `bcc` field that never existed.
- Every tool declares an `outputSchema` and answers with `structuredContent` beside the text
  block, so a client does not have to parse prose to use a result. `preview_mail` carries the
  untrusted marker as `untrusted: true` and `source: "smtp"` fields — a quoted original was
  written by whoever sent it, and anyone in the world can send mail. Its text block keeps the
  nonce fence; the structured half states the same fields rather than making a client parse it.
  No other tool carries the marker, because no other tool reports anything this server did not
  write itself.
- `SMTP_ALLOW_TOOLS` / `SMTP_DENY_TOOLS` narrow the tool list; `essential` selects a curated
  five.
- An integration suite in `test/integration/` that drives the built server over real stdio
  against a throwaway Mailpit container, sends through it and reads the message back to check
  what actually arrived.
- stdio is served through `serveStdio`, so the connection's protocol era is negotiated on the
  opening exchange rather than assumed, and a client that pins either revision is served the one
  it asked for.
- The tool filter, the approval flow, the host classifier and the documentation-asset generator
  come from **`mcp-tool-allowlist`**, **`mcp-approval`**, **`mcp-internal-hosts`** and
  **`svg-asset-set`** rather than from copies kept here. The approval flow in particular was
  written here and in imap-mcp, and became a library once the two had grown near-identical copies
  of it. None of the packages has a runtime dependency of its own, so this makes the tree smaller
  rather than larger. The server runs on **MCP SDK 2.0** and is built with **oxlint** and
  **TypeScript 7**.

### Security

- **Every recipient is checked twice, and the envelope comes from the checked lists.** A local
  part is an RFC 5322 dot-atom and a domain is ASCII, because `ceo,anna@work.example` has one
  allowlisted domain to a naive parser and becomes _two_ RCPT commands at the SMTP server — the
  first a bare `ceo` that a submission relay qualifies with its own domain. The message is
  composed once and sent as raw bytes with an envelope built from the address lists that passed
  the allowlist, never from the headers, so delivery follows what was approved.
- **The HTML sanitiser models the tokenizer, not a space.** Attribute patterns start after
  whitespace, `/` or a quote rather than requiring whitespace; scheme and remote checks run on the
  **decoded** value, with character references and CSS escapes resolved and backslashes read as
  slashes; and the final refusal check is built from the same element list as the removal passes.
  A check that runs on the raw string is checking something no recipient's parser will ever see.
  The passes are linear rather than merely bounded, and the HTML input is capped, so
  `preview_mail` — which is reachable with no send gate, no confirmation and no rate limit —
  cannot hold the event loop.
- **Every recipient and every attachment gets a line of its own in the dialog**, numbered
  `i/N`. A detail value is cut at 200 characters and six ordinary addresses already exceed
  that, so a single line per field showed the first few and dropped the rest without saying
  so — and the one that goes missing is the one that matters, because an address appended to
  Bcc is invisible in the delivered message too.
- **A declined dialog costs a slot of `SMTP_MAX_SENDS_PER_HOUR`.** The quota is not only a
  cap on messages sent; it is the only bound on how many times a person can be asked, and a
  free decline is an unlimited supply of dialogs — the same message reworded until somebody
  agrees out of tiredness. A token that does not match gives the slot back, because nobody
  decided anything and the alternative would let a caller burn the hour with invented tokens.
- **`preview_mail` answers inside the same result budget as every other tool.** It is the one
  tool that returns a whole message and the one reachable with no send gate, no confirmation
  and no rate limit, and it had no budget at all: a 64 kB HTML part with a distinct unsafe
  URL scheme per link produced 366 kB across the two channels. The list of removals is capped
  and says how many are not named, and it is reported as data rather than in the server's own
  voice — a scheme is whatever the caller wrote before a colon, and that text used to sit
  outside the untrusted fence.
- **The confirmation dialog cannot be forged from its own contents.** Recipients, subject, Bcc
  and body each stand on their own labelled line rather than inside a sentence the server wrote,
  and the line-breaking codepoints that would fake such a line under `white-space: pre-wrap`
  (U+2028, U+2029, U+000B, U+000C, U+0085) are rejected — refusing CR and LF is not enough.
  Caller-derived text stays out of the dialog's `what` and `consequence`, which are not capped by
  the approval library, and appears only in details, which are.
- **An attachment is checked on the handle it is read from.** The file is opened non-blocking, so
  a FIFO substituted between `lstat` and `open` cannot hang the handler; type and size are
  checked again on the open handle; and the read is capped at the size that handle reported.
- **A message that cannot fit is refused before it is built.** Ten attachments at the default
  ceiling are 67 MB once base64 has run over them; a lower bound is taken before composing, so
  the oversize case is refused rather than assembled and then rejected. A result too large to
  shrink is an error rather than an envelope carrying an oversized document.
- **Defaults leave out the attachment types that carry their own execution.** `text/html` opens
  in a browser with none of a mail client's restrictions and none of the sanitising the HTML
  _part_ of a message gets; `application/zip` passes the magic-byte check on its own bytes and
  can carry the executable that check never sees. Both remain available through
  `SMTP_ATTACHMENT_TYPES`.
- **The rate limit reserves rather than checks.** MCP clients call in parallel, and checking
  first and counting after leaves the whole SMTP round trip open as a window.
- **The approval fingerprint binds what was actually approved**: the arguments rather than the
  composed bytes, which carry a `Date` and a random Message-ID; the To/Cc/Bcc _split_ rather than
  the multiset of addresses, so an approved visible recipient cannot be moved into Bcc afterwards;
  and the attachment bytes, so the file cannot be swapped between the two token calls.
- Both credentials are removed from `process.env` once the configuration is read, not just
  the password: a user name is half a credential and, for most providers, the mailbox address.
  An upstream error that is an HTML page is dropped however it is prefixed — nodemailer
  appends the server's response to its own message, so a captive portal on the submission port
  arrives as `Invalid login: <html>…` rather than as markup at position zero. `test_connection`
  closes the session it opens instead of leaving an authenticated connection pooled for the
  lifetime of the process.
- A Message-ID, `in_reply_to` or `references` entry is printable ASCII without whitespace or
  angle brackets. nodemailer writes these three headers byte for byte, so a non-ASCII character
  was an 8-bit header on the wire and U+2028 quietly split one identifier into two.
- The advertised schemas avoid a spelling that is legal JSON Schema and still gets a tool refused,
  or its constraint silently dropped, by some MCP clients: a nullable field is written as `anyOf`
  branches rather than a two-entry type array. The two-call `confirm_token` prompt is an error
  result, which is what "the message was not sent" means and what lets a tool that declares an
  output schema answer without `structuredContent`.

<!-- #endregion changelog -->
