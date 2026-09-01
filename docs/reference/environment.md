# Environment variables

Every one of these is read once at startup. `SMTP_PASSWORD` is deleted from the process
environment as soon as it has been read, before any other branch runs, so it is not visible to
child processes or in `/proc/<pid>/environ`.

The server starts without credentials on purpose: it completes the MCP handshake and answers
`tools/list` so that registries and sandbox inspectors can introspect it. Every call then fails
with setup instructions instead of reaching a server.

| Variable | Required | Type | Description |
| --- | --- | --- | --- |
| `SMTP_HOST` | yes | `string` | Hostname of the SMTP server, e.g. smtp.example.net. |
| `SMTP_PORT` | no | `number` | Port. Defaults to 587 for starttls, 465 for implicit, 25 for none. |
| `SMTP_TLS` | no | `string` | starttls (default), implicit or none. STARTTLS is required, never opportunistic. |
| `SMTP_USER` | yes | `string` | Username for SMTP authentication. |
| `SMTP_PASSWORD` | yes | `string` | Password or app-specific password for SMTP authentication. |
| `SMTP_FROM` | yes | `string` | The only sender this server will use, e.g. "Name &lt;person@example.net&gt;". There is no from parameter. |
| `SMTP_ALLOW_SEND` | no | `boolean` | Set to "true" to register the sending tools. Defaults to false: the server cannot send until it is set. |
| `SMTP_ALLOWED_RECIPIENTS` | no | `string` | Comma-separated addresses and @domains this server may write to. Required with SMTP_ALLOW_SEND=true; "*" allows any. |
| `SMTP_MAX_RECIPIENTS` | no | `number` | Maximum distinct recipients across To, Cc and Bcc in one message. Default 10. |
| `SMTP_MAX_SENDS_PER_HOUR` | no | `number` | Sliding hourly cap on messages sent. Default 20. |
| `SMTP_MAX_MESSAGE_BYTES` | no | `number` | Maximum size of the composed message. Default 10485760. |
| `SMTP_MAX_ATTACHMENT_BYTES` | no | `number` | Maximum size of a single attachment. Default 5242880. |
| `SMTP_ATTACHMENT_DIR` | no | `string` | Directory attachments are read from. Unset means attachments are unavailable. |
| `SMTP_ATTACHMENT_TYPES` | no | `string` | Comma-separated content types that may be attached. Defaults to a document and image allowlist. |
| `SMTP_SIGNATURE` | no | `string` | Text appended below the standard signature delimiter of every message. |
| `SMTP_AUDIT_LOG` | no | `string` | File the audit lines are appended to, in addition to stderr. |
| `SMTP_ALLOW_TOOLS` | no | `string` | Comma-separated tool names, a prefix with one trailing *, or "essential" for the curated preset. |
| `SMTP_DENY_TOOLS` | no | `string` | Comma-separated tool names or prefixes to remove, applied after SMTP_ALLOW_TOOLS. |
| `SMTP_INSECURE_TLS` | no | `boolean` | Set to "true" to accept self-signed certificates. Prefer a proper internal CA. |
| `ELICITATION` | no | `boolean` | `false` replaces the approval dialog with the two-call token. Default `true`. **Not prefixed.** |

## The two that differ from the rest of the family

**`SMTP_ALLOW_SEND` defaults to false.** The read/write variables in the sibling servers guard
changes to a system the operator already owns; this one guards a channel out of it. A freshly
installed smtp-mcp that could send on the first tool call would be a server whose worst day
happens before anybody has read its README. It accepts exactly the string `true`.

**An unset `SMTP_ALLOWED_RECIPIENTS` is a startup error, not "anyone".** Treating a missing line
as permission is how an oversight becomes a delivered message. Write `*` if you mean it.

## Values that stop the server

Malformed configuration exits rather than being ignored, because the alternative is a server that
looks like it is running and is not doing what its operator believes:

- a host carrying a scheme, a port, credentials or a line break
- a port outside 1–65535, or a non-positive limit
- an `SMTP_TLS` value other than `starttls`, `implicit` or `none`
- an `SMTP_FROM` that is not an email address
- an entry in `SMTP_ALLOWED_RECIPIENTS` that is neither an address nor an `@domain`
- `SMTP_ALLOW_SEND=true` with no allowlist
- a tool name in `SMTP_ALLOW_TOOLS` or `SMTP_DENY_TOOLS` that matches nothing

Error messages never echo the offending value. Configuration errors end up in logs, and the
"not a valid port" branch is precisely where a token pasted into the wrong variable arrives.

## `ELICITATION`

Whether a client that *can* show a dialog is asked before `send_mail`, `reply_mail` or
`forward_mail` acts. Default `true`. `false` takes the two-call-token path instead — it does
not remove the guard, and a server started with it off prints one line saying so.

Two ways it differs from every other variable here:

- **No prefix.** One `export ELICITATION=false` reaches every MCP server in the same
  environment, not just this one. That is the point of it and also its risk, and this is the
  server where it costs the most: every send asks. See [Asking a person](/guide/approval).
- **Fatal on anything else.** Like `SMTP_TLS`, and unlike `SMTP_ALLOW_SEND`: `1`, `off` or a
  typo stop the server with exit code 1. It is the only variable here that defaults to *on*,
  and a typo that fell back would leave the dialog running while you believed it was off.

Values are trimmed and matched case-insensitively. It is read *after* `SMTP_PASSWORD` is
deleted from `process.env`, so the fatal path cannot leave the password sitting there for a
crash reporter.
