# FAQ & troubleshooting

## One tool I expected is missing

Three possibilities, in the order they are worth checking.

**Sending is off.** `send_mail`, `reply_mail` and `forward_mail` are registered only when
`SMTP_ALLOW_SEND=true`. That is the default state, so this is the common answer. `get_server_info`
reports `sending_enabled` and names the variable.

**A tool filter is narrowing the list.** `SMTP_ALLOW_TOOLS` and `SMTP_DENY_TOOLS` remove tools
outright — see [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).
`SMTP_ALLOW_TOOLS=essential` in particular leaves out `forward_mail` and `test_connection`.

**It is not a bug.** A filtered tool is not built at all, so it is absent from `tools/list` and a
call answers "not found". That is the same answer a sending tool gives while the gate is closed,
and it is deliberate: advertising a tool and then refusing it is worse than not having it.

If a filter names something that does not exist, the server refuses to start and lists the real
names — so a typo is loud rather than silent.

## It says my recipient is not allowed

The address is not covered by `SMTP_ALLOWED_RECIPIENTS`. `validate_recipients` will tell you which
of a list are allowed and which are not, without sending anything.

Two rules catch people out:

- **A domain entry does not cover subdomains.** `@example.net` does not match
  `person@mail.example.net`.
- **The comparison is on the bytes as written.** An address that looks identical but contains a
  Cyrillic character is a different address and will not match. That is intentional.

The model cannot widen the allowlist. Only the operator can, by changing the variable and
restarting.

## It refuses to start with "SMTP_ALLOW_SEND=true requires SMTP_ALLOWED_RECIPIENTS"

That is the intended behaviour, not a missing default. An unset allowlist reads as a line
somebody forgot, and treating it as "anyone" turns that oversight into a delivered message. Write
`SMTP_ALLOWED_RECIPIENTS='*'` if you genuinely want no restriction.

## Nothing was sent and I got a token instead

Your client cannot show an elicitation dialog, so the server fell back to a two-call
confirmation. Call the tool again with `confirm_token` set to the value in the message.

Be aware of what that fallback is and is not: it proves the same call was made twice with the
same arguments, which stops a recipient list or a body changing in between. It does not prove a
human saw anything. Where it matters, use a client that supports elicitation — Claude Desktop and
Claude Code do.

## The token does not work the second time

Tokens are single-use, expire after five minutes, and are bound to the exact message. If you
changed anything at all — added a recipient, edited the subject, edited the body, attached a file
— the approval no longer applies and the server issues a new one. That is the feature: an
approval for one message must not execute a different one.

## Authentication fails

`EAUTH` usually means the account needs an app-specific password rather than the account
password. Every provider with two-factor authentication works this way. `test_connection` is the
quickest check — it authenticates and disconnects without sending anything.

## The connection times out or is refused

Check `SMTP_HOST`, `SMTP_PORT` and `SMTP_TLS` together, because the port has to match the mode:
587 for `starttls`, 465 for `implicit`, 25 for `none`.

If the server reports a TLS failure on port 587, it is doing its job: `starttls` **requires** the
upgrade, so a server that does not offer it produces a failed connection rather than a cleartext
session.

## My HTML arrived changed

Scripts, event handlers, remotely loaded images and `javascript:`/`data:` URLs are removed before
sending. `preview_mail` lists exactly what would be removed, and the confirmation dialog says so
too — the alteration is never silent.

Links are not touched. If a legitimate image disappeared, it was loaded from a remote URL, which
is indistinguishable from a tracking pixel; attach it instead.

## The quoted text in my forward triggered a warning

The confirmation said the quoted original matches known prompt-injection shapes. That is a
signal, not a refusal — the text is forwarded unchanged, and the warning is there so the person
approving knows that what they are passing on tries to give orders. It is worth asking who
prompted the forward.

## Does it read my mail?

No. It has no IMAP client and no mailbox access of any kind. Reading is
[imap-mcp](https://github.com/ni-c/imap-mcp), which is a separate server with separate
credentials — and keeping them apart is a large part of why either of them is safe. See
[Security](/guide/security).

## Can it sign with DKIM?

No, and that is deliberate. A submission server signs outgoing mail for you. Supporting it here
would mean a private signing key sitting in an environment variable, which is a worse trade than
it looks.

## Where do I see what was actually sent?

Every accepted message is written to stderr as an audit line with the recipients, the subject, the
Message-ID and the size. Set `SMTP_AUDIT_LOG` to keep a copy in a file, which is what makes the
record outlive the terminal window your client was started in.

Bodies are never recorded — that would turn the log into a second copy of your correspondence.
