# Tools

Seven tools. Four are always registered and none of them can put a message on the wire; three
send, and those are registered only when `SMTP_ALLOW_SEND=true`.

`SMTP_ALLOW_TOOLS` and `SMTP_DENY_TOOLS` narrow the list further — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load). A tool that is
filtered out is not built: it is absent from `tools/list` and a call answers "not found".

## Always available

### `get_server_info`

No parameters. Reports the SMTP endpoint, the fixed sender, the allowlist, the limits, how many
sends remain in the current hour, whether attachments are available, and — first in the payload —
whether this server can send at all.

Call it before anything else. It answers "can I send, and to whom" without touching the network.

### `validate_recipients`

| Parameter   | Type       | Required | Description                          |
| ----------- | ---------- | -------- | ------------------------------------ |
| `addresses` | `string[]` | yes      | Up to 100 addresses to check.        |

Says which addresses this server may write to and which it will refuse. No connection is made and
nothing is sent. Use it before composing rather than discovering a refusal afterwards.

### `preview_mail`

Same parameters as [`send_mail`](#send-mail), minus `confirm_token`.

Builds exactly the message `send_mail` would build — the same code path, the same headers — and
returns its headers and bodies without connecting to anything. Every check a send performs runs
here too: the allowlist, the recipient limit, the attachment policy and the size limit.

Attachment payloads are summarised by name, size and digest rather than printed. The rendered
message comes back fenced as untrusted content, because it contains text this server did not
write.

### `test_connection`

No parameters. Connects, negotiates TLS, authenticates and disconnects. No message is sent.

Use it to tell a configuration problem apart from a delivery problem.

## Sending

All three ask a person to confirm before acting, using MCP elicitation, and fall back to a
two-call token where the client cannot show a dialog. All three are annotated `destructiveHint`,
because a message cannot be recalled.

### `send_mail`

| Parameter       | Type       | Required | Description                                                        |
| --------------- | ---------- | -------- | ------------------------------------------------------------------ |
| `to`            | `string[]` | yes      | Primary recipients.                                                 |
| `cc`            | `string[]` | no       | Visible to everyone who receives the message.                       |
| `bcc`           | `string[]` | no       | Hidden from the others. Shown separately in the confirmation.       |
| `subject`       | `string`   | yes      | One line, up to 255 characters.                                     |
| `body`          | `string`   | yes      | Plain-text body.                                                    |
| `html`          | `string`   | no       | HTML alternative. Sanitised; removals are reported.                 |
| `attachments`   | `string[]` | no       | File names inside `SMTP_ATTACHMENT_DIR`.                            |
| `confirm_token` | `string`   | no       | From a previous call with the same arguments. Omit on the first.    |

There is no `from` parameter. The sender is `SMTP_FROM`.

### `reply_mail`

Everything `send_mail` takes, plus:

| Parameter          | Type       | Required | Description                                                              |
| ------------------ | ---------- | -------- | ------------------------------------------------------------------------ |
| `original_subject` | `string`   | yes      | Subject of the message being answered. `Re: ` is added if not present.    |
| `subject`          | `string`   | no       | Overrides the derived subject.                                            |
| `in_reply_to`      | `string`   | yes      | Message-ID of the original, verbatim.                                     |
| `references`       | `string[]` | no       | The original's References chain, oldest first.                            |
| `quote`            | `string`   | no       | Original text to quote below the reply.                                   |

Pass `in_reply_to` and `references` through unchanged so mail clients thread the reply correctly.
imap-mcp's `get_message` returns both.

### `forward_mail`

Everything `send_mail` takes, plus:

| Parameter          | Type       | Required | Description                                                             |
| ------------------ | ---------- | -------- | ----------------------------------------------------------------------- |
| `original_subject` | `string`   | yes      | Subject of the message being forwarded. `Fwd: ` is added if not present. |
| `subject`          | `string`   | no       | Overrides the derived subject.                                           |
| `quote`            | `string`   | no       | The original text, included verbatim below your own.                     |
| `references`       | `string[]` | no       | The original's References chain.                                         |

The quoted original is passed on unchanged. If it matches known prompt-injection shapes, the
confirmation dialog says so rather than altering it.

Attachments of the original are not carried over automatically — save them into
`SMTP_ATTACHMENT_DIR` and name them in `attachments`.

## The `essential` preset

`SMTP_ALLOW_TOOLS=essential` registers five: `get_server_info`, `validate_recipients`,
`preview_mail`, `send_mail` and `reply_mail`.

`forward_mail` is left out because forwarding carries somebody else's content and attachments
outward, and `test_connection` is diagnostics rather than work.
