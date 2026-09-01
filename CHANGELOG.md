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
- The sender is fixed by `SMTP_FROM`. There is no `from` parameter.
- Hourly send cap (`SMTP_MAX_SENDS_PER_HOUR`) and a per-message recipient cap
  (`SMTP_MAX_RECIPIENTS`).
- Attachments are read only from `SMTP_ATTACHMENT_DIR`, behind an extension allowlist, an
  executable-extension refusal, a symlink refusal and a magic-byte check.
- Outgoing HTML is sanitised: scripts, event handlers, remotely loaded images and unsafe URL
  schemes are removed, and every removal is reported rather than applied silently.
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
