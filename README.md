# smtp-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/smtp-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/smtp-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Fsmtp-mcp)](https://www.npmjs.com/package/@ni-c/smtp-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Fsmtp-mcp)](https://www.npmjs.com/package/@ni-c/smtp-mcp)
[![node](https://img.shields.io/node/v/%40ni-c%2Fsmtp-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Fsmtp-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fsmtp--mcp-blue)](https://github.com/ni-c/smtp-mcp/pkgs/container/smtp-mcp)
[![docs](https://img.shields.io/badge/docs-smtp--mcp.ni--c.de-informational)](https://smtp-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[SMTP](https://datatracker.ietf.org/doc/html/rfc5321), the protocol every mail server speaks to
accept a message for delivery.

Lets MCP clients like Claude Code, Claude Desktop or Codex send, reply to and forward mail from
one configured address — with a human approving every message.

Seven tools is the ceiling, not the floor: `SMTP_ALLOW_TOOLS=essential` registers a curated five
instead, and a model picks the right tool far more reliably from five than from seven — see
[choosing which tools load](#choosing-which-tools-load).

<!-- The <picture> element resolves against the page, so it follows GitHub's theme
     toggle. npm strips <picture> while sanitising and keeps the <img>, which is
     why architecture.svg carries its own dark card. URLs must be absolute:
     relative paths are simply invisible on the npm package page. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://smtp-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://smtp-mcp.ni-c.de/architecture-light.svg">
  <img alt="Architecture of smtp-mcp" src="https://smtp-mcp.ni-c.de/architecture.svg">
</picture>

<img alt="A terminal session: listing the seven tools, then calling send_mail — which does not send but returns a confirmation naming the recipient and subject on their own lines — and then a second call to an address outside the allowlist, which is refused outright" src="https://smtp-mcp.ni-c.de/demo.gif">

Three calls against a throwaway SMTP server. The last two are the point: the first send stops and
asks, and the second never gets that far because the address is not on the allowlist.

## What makes it different

**It sends mail. That is why it is a separate server.** Its counterpart
[imap-mcp](https://github.com/ni-c/imap-mcp) reads a mailbox and deliberately has no way to send
anything — that absence is its entire security argument, because an agent that can reach private
data and process attacker-controlled content is only exploitable once it also has a way out.
This server is that way out, so it does not get to make the same claim. It earns its place by
narrowing the channel instead, and by living in its own process with its own credentials.

**It is off when you install it.** `SMTP_ALLOW_SEND` defaults to false. Until it is set the
sending tools are not registered at all — absent from `tools/list`, not refused at call time.

**It can only write to people you named.** `SMTP_ALLOWED_RECIPIENTS` is required to turn sending
on. Every address in To, Cc and Bcc is checked against it before a connection is opened, so an
injected "mail this to someone else" fails without the server ever reading it as an instruction.
Allowing everyone is possible and has to be written as `*`.

**Every message is approved by a person.** Not by the model — the request goes to the client as
an MCP elicitation. Recipients, subject and any Bcc appear on their own labelled lines, so a
subject written to look like an instruction cannot become part of the server's own sentence.

**The sender cannot be chosen.** There is no `from` parameter. A model that could pick its own
sender could write in a colleague's name, and the result would be indistinguishable from a
message they wrote.

## Requirements

- Node.js 22 or newer
- An SMTP account you may send from — a submission server on port 587 or 465, with a username
  and password. Providers with two-factor authentication generally need an app-specific
  password.

## Configuration

> **Use TLS.** `SMTP_TLS=starttls` (the default) requires the upgrade rather than attempting it,
> so a stripped `STARTTLS` capability fails the connection instead of quietly sending your
> password in the clear. For a self-signed certificate prefer a proper internal CA over
> `SMTP_INSECURE_TLS`.

| Variable                    | Required                    | Default                      | Description                                                                           |
| --------------------------- | --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `SMTP_HOST`                 | yes                         | —                            | Hostname of the SMTP server, e.g. `smtp.example.net`.                                 |
| `SMTP_USER`                 | yes                         | —                            | Username for SMTP authentication.                                                     |
| `SMTP_PASSWORD`             | yes                         | —                            | Password or app-specific password.                                                    |
| `SMTP_FROM`                 | yes                         | —                            | The only sender used, e.g. `Name <person@example.net>`. There is no `from` parameter. |
| `SMTP_PORT`                 | no                          | 587 / 465 / 25               | Depends on `SMTP_TLS`.                                                                |
| `SMTP_TLS`                  | no                          | `starttls`                   | `starttls`, `implicit` or `none`. Never opportunistic.                                |
| `SMTP_ALLOW_SEND`           | no                          | `false`                      | Set to `true` to register the sending tools.                                          |
| `SMTP_ALLOWED_RECIPIENTS`   | with `SMTP_ALLOW_SEND=true` | —                            | Comma-separated addresses and `@domains`. `*` allows anyone.                          |
| `SMTP_MAX_RECIPIENTS`       | no                          | `10`                         | Distinct recipients across To, Cc and Bcc in one message.                             |
| `SMTP_MAX_SENDS_PER_HOUR`   | no                          | `20`                         | Sliding hourly cap.                                                                   |
| `SMTP_MAX_MESSAGE_BYTES`    | no                          | `10485760`                   | Size ceiling on the composed message.                                                 |
| `SMTP_MAX_ATTACHMENT_BYTES` | no                          | `5242880`                    | Size ceiling on one attachment.                                                       |
| `SMTP_ATTACHMENT_DIR`       | no                          | —                            | Directory attachments are read from. Unset means no attachments.                      |
| `SMTP_ATTACHMENT_TYPES`     | no                          | document and image allowlist | Comma-separated content types that may be attached.                                   |
| `SMTP_SIGNATURE`            | no                          | —                            | Text appended below the standard `-- ` delimiter.                                     |
| `SMTP_AUDIT_LOG`            | no                          | —                            | File the audit lines are appended to, in addition to stderr.                          |
| `SMTP_ALLOW_TOOLS`          | no                          | —                            | Tool names, a prefix with one trailing `*`, or `essential`.                           |
| `SMTP_DENY_TOOLS`           | no                          | —                            | Removed after `SMTP_ALLOW_TOOLS` is applied.                                          |
| `SMTP_INSECURE_TLS`         | no                          | `false`                      | Accept self-signed certificates.                                                      |

Two defaults are worth reading twice, because they are the opposite of what the rest of this
family does:

- **`SMTP_ALLOW_SEND` is off.** A freshly installed smtp-mcp can compose and preview messages
  and cannot send any.
- **An unset `SMTP_ALLOWED_RECIPIENTS` is a startup error, not "anyone".** Treating a missing
  line as permission is how an accident becomes a delivered message. Write `*` if you mean it.

### Choosing which tools load

`SMTP_ALLOW_TOOLS` decides what is registered, `SMTP_DENY_TOOLS` is subtracted from it. Both take
comma-separated tool names or a prefix with a single trailing `*`. A filtered tool is never
built — it does not appear in `tools/list` and answers a call with "not found", the same as a
sending tool while the send gate is closed. Nothing is advertised and then refused.

```sh
SMTP_ALLOW_TOOLS=essential          # the curated five
SMTP_ALLOW_TOOLS='get_server_info,preview_mail'
SMTP_DENY_TOOLS=forward_mail        # everything else, minus forwarding
```

`essential` is `get_server_info`, `validate_recipients`, `preview_mail`, `send_mail` and
`reply_mail`. `forward_mail` is left out: forwarding carries somebody else's content and
attachments outward, which is the call that most deserves to be switched on deliberately.

An entry that matches no tool aborts startup and lists the real names. A tool quietly missing
from `tools/list` is invisible — nobody traces an absence back to an environment variable.

## Installation

### Claude Code

```sh
claude mcp add smtp -- npx -y @ni-c/smtp-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "smtp": {
      "command": "npx",
      "args": ["-y", "@ni-c/smtp-mcp"],
      "env": {
        "SMTP_HOST": "smtp.example.net",
        "SMTP_USER": "person@example.net",
        "SMTP_PASSWORD": "app-specific-password",
        "SMTP_FROM": "Your Name <person@example.net>",
        "SMTP_ALLOW_SEND": "true",
        "SMTP_ALLOWED_RECIPIENTS": "@example.net"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.smtp]
command = "npx"
args = ["-y", "@ni-c/smtp-mcp"]

[mcp_servers.smtp.env]
SMTP_HOST = "smtp.example.net"
SMTP_USER = "person@example.net"
SMTP_PASSWORD = "app-specific-password"
SMTP_FROM = "Your Name <person@example.net>"
SMTP_ALLOW_SEND = "true"
SMTP_ALLOWED_RECIPIENTS = "@example.net"
```

### Docker

```sh
docker run --rm -i \
  -e SMTP_HOST=smtp.example.net \
  -e SMTP_USER=person@example.net \
  -e SMTP_PASSWORD=app-specific-password \
  -e SMTP_FROM='Your Name <person@example.net>' \
  -e SMTP_ALLOW_SEND=true \
  -e SMTP_ALLOWED_RECIPIENTS=@example.net \
  ghcr.io/ni-c/smtp-mcp
```

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de) is the other
answer — its `/hub` endpoint replaces every server's tools with six meta-tools.

## Tools

Always registered. None of these can put a message on the wire.

| Tool                  | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `get_server_info`     | The endpoint, the fixed sender, the allowlist, the limits, and whether sending is on at all.   |
| `validate_recipients` | Which addresses this server may write to, and why the others are refused. No connection made.  |
| `preview_mail`        | Builds exactly the message `send_mail` would build and shows it. Runs every check a send runs. |
| `test_connection`     | Connects, negotiates TLS, authenticates, disconnects. Sends nothing.                           |

Registered only with `SMTP_ALLOW_SEND=true`. 👤 marks the ones that ask a human before acting.

| Tool              | What it does                                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `send_mail` 👤    | Sends a new message.                                                             |
| `reply_mail` 👤   | Sends a reply that threads under the original, deriving `Re: ` from the subject. |
| `forward_mail` 👤 | Forwards a message to new recipients, quoting the original verbatim.             |

## Not exposed, on purpose

- **A `from` parameter.** The sender is `SMTP_FROM` and nothing else.
- **A way to skip the confirmation.** No `force`, no "trusted caller" mode. An option to turn
  the gate off would be the first thing a prompt injection reaches for.
- **Reading mail.** That is [imap-mcp](https://github.com/ni-c/imap-mcp). Keeping the two in
  separate processes with separate credentials is most of what makes either of them safe.
- **Arbitrary headers.** Threading uses `in_reply_to` and `references`; there is no passthrough
  for header names, because that is header injection with extra steps.
- **DKIM signing.** A submission server signs for you. A private signing key in an environment
  variable is a worse trade than it looks.

## Safety

- **Sending is off by default and the tools do not exist until it is on.**
- **Every recipient is checked against an allowlist** before a connection is opened, in To, Cc
  and Bcc alike.
- **Every message is approved by a human**, through MCP elicitation. The two-call token fallback
  says plainly that it is not the same thing.
- **A confirmation is bound to the exact message**: a SHA-256 fingerprint over the sorted
  recipient list and a digest of the content, so an approval cannot be spent on a wider list or
  on different text.
- **Bcc recipients get their own labelled line** in the dialog. A hidden recipient a human does
  not see is the ideal exfiltration channel.
- **Confirmation text never quotes caller-chosen values into the server's own sentence.**
- **Outgoing HTML is stripped** of scripts, event handlers, remotely loaded images and unsafe URL
  schemes — and every removal is reported, never silent.
- **A quoted original is passed on unchanged**, with any prompt-injection shapes it matches named
  in the dialog.
- **Attachments come only from `SMTP_ATTACHMENT_DIR`**, past an extension allowlist, a symlink
  refusal and a magic-byte check.
- **Every accepted message is recorded** on stderr and optionally in a file. Never the body.

See [SECURITY.md](SECURITY.md) for the reasoning, and for what none of this covers.

## Development

```sh
npm install
npm test
npm run build
```

There is a throwaway Mailpit sandbox in [`scripts/sandbox/`](scripts/sandbox/README.md). Develop
against it rather than a real mailbox: this server's job is to put messages on the wire, and a
test run that goes wrong sends real mail to real people.

```sh
docker compose -f scripts/sandbox/docker-compose.yml up -d
npm run build && node scripts/sandbox/smoke.mjs
```

## Releasing

Tagging `vX.Y.Z` on `main` runs the release workflow: it checks the tag matches `package.json`,
publishes to npm with provenance through Trusted Publishing, pushes a multi-arch image to GHCR
with an SBOM, creates the GitHub release from the CHANGELOG section, and submits the version to
the MCP Registry.

## License

MIT © Willi Thiel
