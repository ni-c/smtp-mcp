# Configuration

Everything is an environment variable. The full table with types and defaults is in the
[environment reference](/reference/environment); this page explains the ones with consequences.

## Connecting

`SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are the account. `SMTP_PORT` follows `SMTP_TLS`
unless you set it.

| `SMTP_TLS`  | Default port | Behaviour                                                          |
| ----------- | ------------ | ------------------------------------------------------------------ |
| `starttls`  | 587          | Connects in the clear and **requires** the upgrade. The default.    |
| `implicit`  | 465          | TLS from the first byte.                                            |
| `none`      | 25           | No encryption, ever.                                                |

`starttls` requires the upgrade rather than attempting it. That distinction is the whole point:
left to a library default, STARTTLS is used when the server offers it and skipped when it does
not — so an attacker who can strip the capability from the server's greeting gets a cleartext
session carrying your password, and nothing says a word. Here that is a failed connection.

`none` means none, not "encrypt if it happens to be offered". A mode whose behaviour depends on
what the peer advertises is a mode nobody can reason about. Against a non-loopback host it prints
a warning.

`SMTP_INSECURE_TLS=true` accepts self-signed certificates. It is scoped to this server's own
connection and never touches process-wide TLS verification — but prefer a proper internal CA.

## The sender

`SMTP_FROM` is the only sender this server will use, in either form:

```sh
SMTP_FROM='person@example.net'
SMTP_FROM='Your Name <person@example.net>'
```

There is no `from` tool parameter, and adding one is out of scope. A model that can choose its
own sender can write in a colleague's name, and the message that results is indistinguishable
from one they wrote. The envelope sender is the bare address out of this value, so SPF and DKIM
line up with what the recipient sees.

## Turning sending on

```sh
SMTP_ALLOW_SEND=true
SMTP_ALLOWED_RECIPIENTS='@example.net,partner@example.org'
```

`SMTP_ALLOW_SEND` accepts exactly the string `true`. Anything else — `TRUE`, `1`, `yes` — leaves
sending off, because a variable that guards an outbound channel should not be permissive about
what counts as consent.

`SMTP_ALLOWED_RECIPIENTS` is **required** when sending is on. Entries are:

| Entry                | Matches                                                    |
| -------------------- | ---------------------------------------------------------- |
| `@example.net`       | any address at that domain, and **not** at a subdomain      |
| `person@example.net` | exactly that address                                        |
| `*`                  | anyone — must be the only entry                             |

A domain rule does not cover its subdomains. Subdomain matching is the kind of convenience that
turns one allowlisted domain into whatever anyone can register underneath it; if you want
`@mail.example.net`, name it.

`*` cannot be combined with other entries. Together they read as "these, plus a wildcard somebody
forgot to remove", and the person deleting the real entries later believes they are tightening
the list. They are not — `*` already allowed everything.

Malformed entries stop the server rather than matching nothing, and comparison is done on the
bytes as written: a homoglyph domain simply fails to match, which is the direction this has to
fail in.

## Limits

| Variable                    | Default    | What it bounds                                             |
| --------------------------- | ---------- | ---------------------------------------------------------- |
| `SMTP_MAX_RECIPIENTS`       | `10`       | distinct addresses across To, Cc and Bcc in one message     |
| `SMTP_MAX_SENDS_PER_HOUR`   | `20`       | messages in a sliding hour                                  |
| `SMTP_MAX_MESSAGE_BYTES`    | `10485760` | the composed message, after encoding                        |
| `SMTP_MAX_ATTACHMENT_BYTES` | `5242880`  | one attachment, before encoding                             |

The hourly cap is held in memory and resets when the server restarts. That is a deliberate
trade: a counter in a file would need locking, would drift when two clients run the server at
once, and would turn a corrupt state file into a server that refuses to send at all. Read it as a
blast-radius limit, not as a quota.

## Attachments

Attachments are unavailable until `SMTP_ATTACHMENT_DIR` names a directory. Callers then name a
file **inside** it — a plain filename, no path — and everything else is refused: separators,
`..`, leading dots, symlinks, extensions outside `SMTP_ATTACHMENT_TYPES`, executable extensions,
and anything whose leading bytes say it is a binary regardless of what it is called.

The default type list is documents and images. Two things are deliberately not on it and have to
be written into `SMTP_ATTACHMENT_TYPES` by hand: `text/html`, because an HTML *file* opens in a
browser with none of a mail client's restrictions and none of the sanitising the HTML *part* of a
message gets — the phishing shape called HTML smuggling — and `application/zip`, because an archive
passes the magic-byte check on its own bytes and can carry an executable the check never sees.

The directory is the only source of the path. A caller cannot choose which part of your disk gets
mailed out.

## Signature and audit

`SMTP_SIGNATURE` is appended below the standard `-- ` delimiter, which is what makes mail clients
hide it when quoting a reply.

`SMTP_AUDIT_LOG` names a file that receives a copy of every audit line. Those lines always go to
stderr; the file is what makes the record outlive the terminal the client was started in. It
holds the recipients, the subject, the Message-ID and the size — never the body.

Refused sends are written down too, marked `outcome=refused`, `declined` or `token_rejected`,
with the recipients and the subject that were asked for. A session that is being steered mostly
produces refusals — an address off the allowlist, a token that did not match — and those lines
are what shows it was being steered.

## Turning the approval dialog off

Every send asks a person through MCP elicitation before the message leaves.
`ELICITATION=false` takes it to the two-call token instead. It does not remove the guard;
there is no setting in which a message goes out unannounced.

The variable deliberately carries no `SMTP_` prefix, which means it reaches every MCP server
in the same environment — and this is the server where that costs the most. Unlike
`SMTP_ALLOW_SEND`, a value it does not recognise **stops the server** rather than failing off.
See [Asking a person](/guide/approval).

## Choosing the tools that load

`SMTP_ALLOW_TOOLS` decides what is registered; `SMTP_DENY_TOOLS` is subtracted from it. Both take
comma-separated tool names, or a prefix with a single trailing `*`.

```sh
SMTP_ALLOW_TOOLS=essential
SMTP_ALLOW_TOOLS='get_server_info,preview_mail'
SMTP_ALLOW_TOOLS='send_*'
SMTP_DENY_TOOLS=forward_mail
```

`essential` selects a curated five: `get_server_info`, `validate_recipients`, `preview_mail`,
`send_mail` and `reply_mail`. `forward_mail` is left out on purpose — forwarding carries somebody
else's content and attachments outward, which is the call that most deserves to be switched on
deliberately.

A filtered tool is not built. It does not appear in `tools/list` and a call answers "not found",
exactly like a sending tool while `SMTP_ALLOW_SEND` is unset. Nothing is advertised and then
refused.

An entry matching no tool aborts startup and lists the real names. That is louder than it sounds
and it is the point: a tool quietly missing from `tools/list` is invisible, and nobody traces an
absence back to an environment variable. A pattern that matches only sending tools while sending
is off is a warning rather than an error — a pattern is a template, not a claim about one tool —
but an exact name in that position is fatal, because somebody typed it believing it was exposed.
