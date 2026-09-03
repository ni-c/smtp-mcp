# Connecting clients

Every example below sets the four required variables plus the two that turn sending on. Leave
`SMTP_ALLOW_SEND` and `SMTP_ALLOWED_RECIPIENTS` out while you are still setting things up: the
server starts fine without them and simply cannot send.

## Claude Code

```sh
claude mcp add smtp -- npx -y @ni-c/smtp-mcp
```

Then put the variables in the entry it created, or export them in the shell that starts Claude
Code.

## Claude Desktop

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

Claude Desktop supports MCP elicitation, so every send shows you a dialog. That is the mode this
server is designed for.

## Codex

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

## MCP Inspector

Useful for reading the tool schemas and calling tools by hand:

```sh
SMTP_HOST=smtp.example.net SMTP_USER=person@example.net SMTP_PASSWORD=… \
  SMTP_FROM='Your Name <person@example.net>' \
  npx @modelcontextprotocol/inspector npx -y @ni-c/smtp-mcp
```

## Docker

```json
{
  "mcpServers": {
    "smtp": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "SMTP_HOST",
        "-e",
        "SMTP_USER",
        "-e",
        "SMTP_PASSWORD",
        "-e",
        "SMTP_FROM",
        "-e",
        "SMTP_ALLOW_SEND",
        "-e",
        "SMTP_ALLOWED_RECIPIENTS",
        "ghcr.io/ni-c/smtp-mcp"
      ],
      "env": {
        "SMTP_HOST": "smtp.example.net",
        "SMTP_USER": "person@example.net",
        "SMTP_PASSWORD": "…",
        "SMTP_FROM": "Your Name <person@example.net>",
        "SMTP_ALLOW_SEND": "true",
        "SMTP_ALLOWED_RECIPIENTS": "@example.net"
      }
    }
  }
}
```

Passing `-e NAME` without a value forwards the variable from the client's environment instead of
baking the password into the argument list, where every `ps` on the machine can read it.

The container runs as uid 1000 and never touches the filesystem unless `SMTP_ATTACHMENT_DIR` is
set. If you do set it, the bind-mounted directory has to be readable by uid 1000 **on the host** —
a `chown` inside the Dockerfile only affects the image layer, not your mount:

```sh
mkdir outbox && sudo chown 1000:1000 outbox
docker run --rm -i \
  -e SMTP_HOST=smtp.example.net -e SMTP_USER=person@example.net -e SMTP_PASSWORD=… \
  -e SMTP_FROM='Your Name <person@example.net>' \
  -e SMTP_ALLOW_SEND=true -e SMTP_ALLOWED_RECIPIENTS=@example.net \
  -e SMTP_ATTACHMENT_DIR=/data -v "$PWD/outbox:/data:ro" \
  ghcr.io/ni-c/smtp-mcp
```

Note the `:ro`. This server only ever reads from that directory, so mounting it read-only costs
nothing and removes a class of accident.

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container behind a
single HTTPS endpoint, so smtp-mcp can be reached from clients that cannot spawn a local process
— ChatGPT connectors, Claude on the web, Cursor — without a container, a hostname and an OAuth
stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you already have:

```json
{
  "mcpServers": {
    "smtp-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/smtp-mcp"],
      "env": {
        "SMTP_HOST": "smtp.example.net",
        "SMTP_USER": "person@example.net",
        "SMTP_PASSWORD": "…",
        "SMTP_FROM": "Your Name <person@example.net>"
      }
    }
  }
}
```

There are two different filters in play here and they are easy to confuse. This server's own
`SMTP_ALLOW_TOOLS` and `SMTP_DENY_TOOLS` are **environment variables**, and they decide which
tools the server registers at all. The hub's `allowTools` and `denyTools` are **mcp.json keys**
alongside `command` and `args`, and they decide which of the registered tools the hub re-exposes.
Writing `"allowTools": ["essential"]` in `mcp.json` does nothing — `essential` is a preset this
server understands, not a tool name the hub knows — so the preset belongs in the `env` block:

```json
"env": { "SMTP_ALLOW_TOOLS": "essential" }
```

The two compose, and it is worth knowing which does what: the server registers what its
environment variables allow, and the hub exposes what its arrays allow. Filtering in the server
is the tighter of the two — the tool is never built.

Register `https://your-host/smtp-mcp/mcp` as a connector and you get this server alone. Register
the hub's `/hub` endpoint instead and you reach _every_ server behind it through six meta-tools,
which is the answer worth having once you run several of these at once.

**A warning specific to this server.** Reaching smtp-mcp through the hub usually means reaching
it from a client that cannot show an elicitation dialog, which drops every send back to the
two-call token — and the token is not a human-in-the-loop gate. If you run it that way, the
allowlist is doing most of the work, so keep it narrow.
