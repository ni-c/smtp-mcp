# Getting started

## Requirements

- Node.js 22 or newer
- An SMTP account you may send from — a submission server on port 587 or 465, with a username and
  password. Providers with two-factor authentication generally need an app-specific password
  rather than the account password.

## Try it without sending anything

The server starts perfectly well with sending switched off, which is the default. That state is
useful on its own: you can compose messages, see exactly what would go out, and check who the
server would be allowed to write to — without any possibility of a message escaping while you are
still working out the configuration.

```sh
SMTP_HOST=smtp.example.net \
SMTP_USER=person@example.net \
SMTP_PASSWORD=app-specific-password \
SMTP_FROM='Your Name <person@example.net>' \
npx -y @ni-c/smtp-mcp
```

The server writes a line to stderr telling you which state it is in:

```
smtp-mcp: SMTP_ALLOW_SEND is not "true" — this server can compose and preview
messages but cannot send any. Set SMTP_ALLOW_SEND=true and SMTP_ALLOWED_RECIPIENTS
to enable sending.
```

Ask your client to call `get_server_info`. It answers `can_send: false` and names the variable
that would change that.

## Turn sending on

Two variables, and the second one is not optional:

```sh
SMTP_ALLOW_SEND=true
SMTP_ALLOWED_RECIPIENTS='@example.net,partner@example.org'
```

`SMTP_ALLOWED_RECIPIENTS` accepts:

| Entry                  | Matches                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `@example.net`         | any address **at** that domain — not at `mail.example.net`      |
| `person@example.net`   | exactly that address                                            |
| `*`                    | anyone                                                          |

Setting `SMTP_ALLOW_SEND=true` without an allowlist is a startup error, not a silent "anyone".
That is deliberate: an unset allowlist reads as a line somebody forgot, and the failure it causes
is a message already delivered. If you genuinely want no restriction, write `*` and own the
choice.

## Send the first message

Ask your client to send something, and watch what happens: the server does **not** send on the
first call. It asks.

With a client that supports MCP elicitation — Claude Desktop and Claude Code do — a dialog
appears with the recipients, the subject and any Bcc on their own lines. Nothing goes out until
you tick it.

With a client that cannot show a dialog, the first call returns a confirmation token instead, and
the tool has to be called a second time carrying it. The result says plainly that this only
proves the call was made twice with the same arguments — it is not the same thing as a human
saying yes, and it does not pretend to be.

Either way, a confirmation is bound to that exact message. Adding a recipient or changing the
body invalidates it, and the server asks again.

## See it first

`preview_mail` builds exactly the message `send_mail` would build — same code path, same headers
— and returns it without connecting to anything. Every check a send runs happens here too: the
allowlist, the recipient limit, the attachment policy, the size limit. It is the fastest way to
find out whether a message is acceptable before putting a question in front of a person.

## Develop against a sandbox

If you are changing the server rather than using it, do not point it at a real mailbox. The
repository ships a throwaway [Mailpit](https://mailpit.axllent.org/) instance that speaks real
SMTP and delivers nowhere:

```sh
docker compose -f test/integration/compose.yml up -d --wait
npm run build && npm run test:integration
```
