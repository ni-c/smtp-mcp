# What is smtp-mcp?

smtp-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server that sends mail
over [SMTP](https://datatracker.ietf.org/doc/html/rfc5321). It gives an MCP client — Claude Code,
Claude Desktop, Codex — the ability to compose, reply to and forward messages from one configured
address, with a person approving each one.

## Why it is a separate server

Its counterpart, [imap-mcp](https://github.com/ni-c/imap-mcp), reads a mailbox and deliberately
cannot send anything. That absence is not a missing feature; it is that server's entire security
argument. An agent is exploitable by indirect prompt injection when three things are true at
once: it can reach private data, it processes content an attacker controls, and it can send data
somewhere. A mailbox supplies the first two by definition — anyone who knows the address can put
text in it — so the third is the one worth removing.

This server is the third one. It cannot make the same claim, and pretending otherwise would be
worse than useless. What it does instead is narrow that channel until an injected instruction has
nowhere useful to go, and keep it in a separate process with separate credentials, so that
turning on the ability to send does not also hand it a mailbox to read.

## What constrains it

Four things, and none of them is the model:

1. **It is off.** `SMTP_ALLOW_SEND` defaults to false. Until it is set, `send_mail`, `reply_mail`
   and `forward_mail` are not registered at all — absent from `tools/list`, not refused when
   called.
2. **A recipient allowlist.** `SMTP_ALLOWED_RECIPIENTS` is required to turn sending on. Every
   address in To, Cc and Bcc is checked before a connection is opened.
3. **A human confirmation on every message**, through MCP elicitation. The model cannot answer
   it.
4. **An hourly cap.** A successful attack is bounded to a number of messages rather than to
   however long nobody was watching.

And one thing that is simply absent: there is no `from` parameter. The sender is `SMTP_FROM` and
nothing else, because a model that could choose its own sender could write in a colleague's name.

## What it does not do

- **It does not read mail.** That is [imap-mcp](https://github.com/ni-c/imap-mcp).
- **It does not sign with DKIM.** A submission server signs for you; a private signing key in an
  environment variable is a worse trade than it looks.
- **It does not let you set arbitrary headers.** Threading uses `in_reply_to` and `references`.
  A generic header passthrough is header injection with extra steps.

## Next

- [Getting started](/guide/getting-started) — install it and send your first message
- [Connecting clients](/guide/clients) — Claude Code, Claude Desktop, Codex, Docker, mcp-hub
- [Configuration](/guide/configuration) — every variable, and which tools load
- [Security](/guide/security) — the trust model and what it does not cover
