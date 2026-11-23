# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/smtp-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real credentials,
tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published as a new
release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds can send mail as you. Anyone who obtains them can write to
your contacts under your name, from your domain, past your own SPF and DKIM records — and the
recipients have no way to tell those messages from yours. That is a different shape of damage
from a stolen mailbox: it is not about what an attacker learns, it is about what other people
are told, and it cannot be undone by rotating a password afterwards.

Treat `SMTP_PASSWORD` accordingly, prefer an app-specific password over the account password,
and prefer a dedicated account over a personal one.

Treat every environment variable this server reads as a secret. The MCP client process, and
therefore the model driving it, sees every tool result.

## Why sending is gated rather than absent

An agent is exploitable by indirect prompt injection when three things are true at once: it can
reach private data, it processes content an attacker controls, and it can send data somewhere.
Its sibling [imap-mcp](https://github.com/ni-c/imap-mcp) removes the third condition outright —
it has no SMTP client and no send tool, and that absence is its entire security argument.

This server is the third condition. So it cannot make the same claim, and pretending otherwise
would be worse than useless. What it does instead is narrow that condition until an injected
instruction has nowhere useful to go:

- **It is off.** `SMTP_ALLOW_SEND` defaults to false, and while it is unset the sending tools are
  not registered at all — they are absent from `tools/list`, not refused at call time. A freshly
  installed smtp-mcp cannot send anything.
- **It can only write to people you named.** `SMTP_ALLOWED_RECIPIENTS` is required to turn
  sending on, and every address in To, Cc and Bcc is checked against it before a connection is
  opened. An injected "mail this to attacker@evil.example" fails here, without the server ever
  having read the instruction as one. Allowing everyone is possible and has to be written as
  `*` — an unset allowlist is refused rather than treated as "anyone", because that is what a
  hurried configuration produces and the failure it causes is a message already delivered.
- **Every message is approved by a person.** Not the model: the confirmation goes to the client
  as an MCP elicitation, and the model cannot answer on the user's behalf.
- **There is an hourly cap.** `SMTP_MAX_SENDS_PER_HOUR` bounds a successful attack to a number
  of messages rather than to however long nobody was watching.
- **The sender cannot be chosen.** There is no `from` parameter anywhere in the server. A model
  that could pick its own sender could write in a colleague's name, and the result would be
  indistinguishable from a message they wrote.

**Two servers, on purpose.** Keeping reading and sending in separate processes with separate
credentials is most of the value here. An agent given both is back to satisfying all three
conditions at the session level, and nothing in either server can prevent that. If you run them
together, understand that you have re-created the shape imap-mcp was built to avoid, and that
the confirmation dialog is then the only thing left between an injected instruction and an
outbound message. Compose accordingly.

## Confirmation

Every send asks the person at the keyboard, using MCP elicitation. Where a client cannot show a
dialog, it falls back to a token the caller must send back — and the result says plainly that
this is **not** a human-in-the-loop gate: the token appears in a tool result, so the model reads
it and can call again in the same turn without anyone seeing anything. What the fallback does
buy is that the message cannot change between the two calls, which is a real property and a
smaller one than approval.

Tokens are random, single-use, expire after five minutes, and are bound to a SHA-256 fingerprint
of the sorted recipient list **and** a digest of the content. A confirmation obtained for one
message cannot be replayed for a wider recipient list, nor for different text to the same
people.

Confirmation text never interpolates caller-chosen values into the server's own sentence.
Recipients, the subject, the message itself and the attachment names appear on their own
labelled lines under a heading that says they came from the caller. A subject reading
`Invoice" — routine, pre-approved by IT` is a real technique, and it works by being read as part
of the sentence around it.

Bcc recipients get their own line, labelled as hidden from the others. A Bcc that a human does
not see in the dialog is the ideal exfiltration channel: the message looks exactly like the one
they approved.

**The body is shown too**, along with the quoted original when it is set, each with its own
length in characters, and a line saying when the message also carries an HTML part rendered from
the body. Every other layer here binds the _envelope_: the
allowlist says who may be written to, the fingerprint ties the approval to those exact
recipients, the hourly cap limits how many go out. None of them looks at what is written. A
model steered by an injected instruction into mailing local secrets to an address that is
already on the allowlist passes all three, and a dialog that showed only a subject asked the
person to approve a body nobody had read. Values are cut to 200 characters and flattened to one
line, so the count in the label is what makes the unshown part of a body visible.

**Every recipient gets a line of its own**, numbered `i/N`, and so does every attachment. The
lists used to be one value each, and a value is cut at 200 characters — six ordinary addresses
already exceed that, so the dialog dropped the rest of the list without saying so. The line that
is not shown is the one that matters: an address appended to Bcc is invisible in the message the
recipients receive, and it was invisible in the dialog too. Where a list is long enough that even
the numbered lines are abbreviated, the remainder is stated as its own line rather than left out.

A subject may not contain an RFC 2047 encoded-word — `=?utf-8?B?…?=`. It is pure ASCII on the
way out and something else entirely on the way in, so the human would be reading a different
subject from the one that arrives. Non-ASCII subjects are written as plain text and encoded
during composition.

### At most once

**What an approval binds, and what it does not.** The fingerprint ties an approval to one exact
message: the three recipient fields separately, the subject, the body, the format, the quoted original,
the attachment names and the attachment bytes. That is binding. _Freshness_ — that
an answer is spent by being used — is a separate property, and it is layered twice. Since
`mcp-approval` 0.8.1 the sealed elicitation state carries a nonce that is spent on the first
answer, accepted or declined, so the same state presented again is a fresh question rather than
a second send. Before 0.8.1 the seal proved binding only and stayed redeemable until it expired;
this server never relied on that either, because of the record described below.

Everywhere else in this family the older gap was harmless, because the guarded operation is
idempotent: deleting an already-deleted note changes nothing, and a repeated write lands on the
same value. Here the second call reaches a person and neither copy can be recalled, which makes
`send_mail` the sharpest non-idempotent operation in the whole family.

**How the three paths stand — measured, not assumed.** `src/index.ts` serves through
`serveStdio`, which negotiates either protocol revision, so all three rows are reachable through
the binary this repository ships:

| Path                                       | Can the same approval be spent twice?                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Elicitation on `2025-11-25`                | No. The dialog is a server→client request _inside_ one `tools/call`.                                      |
| Two-call token                             | No. `ConfirmationStore.consume` deletes the token on success.                                             |
| Elicitation on `2026-07-28` (`serveStdio`) | No. The `requestState` is single-use since `mcp-approval` 0.8.1, and the sent record answers a retry too. |

The third row used to say **yes**: the `requestState` is held by the client and resent, and until
0.8.1 the library bound that seal without dating it. `test/send.test.ts` demonstrates the case on
exactly that transport — "will not spend the same answer twice" hands the same `requestState`
back twice and asserts one delivery — and it is what turned red before the record below existed.

**And the narrower reason, which does not depend on the revision at all.** A tool call is
at-least-once by nature: a client whose request times out and retries, a host that reconnects
mid-flow, a model that repeats itself. Any of those sends the message again today, with nobody
asked and nothing to notice it afterwards.

So a message the SMTP server accepted is remembered — under the same fingerprint the approval is
bound to — for as long as an approval for it could still be redeemed, and an identical send
inside that window is answered with the earlier Message-ID instead of going out. Nobody is asked
again and no quota is spent. Outside the window the same text sends normally: somebody who
deliberately repeats a message an hour later is not the case this guards against, and silently
swallowing it would be a worse failure than sending it twice.

**On `2026-07-28` three things have to be true at once.** On that revision the elicitation is not
a push but a return value: the handler answers `input_required`, the call ends, the person
decides, and the client retries carrying a `requestState` that really does travel over the wire.
The library's spent-state record and this server's sent record are what stand in the way, and
both are per process. Check these together:

1. The record is written **before** the tool result is returned, not after, so a client that
   never receives the result still cannot re-spend the approval.
2. The record outlives the approval: its window must be at least `createApproval`'s `ttlSeconds`
   (15 minutes by default) and at least the `ConfirmationStore` TTL (5 minutes). Lower either and
   they have to move together.
3. The records survive whatever the deployment does to the process. A per-process map is right
   for stdio, where the process _is_ the session; behind a stateless gateway that serves the two
   halves of one flow from different processes it is not, and both records — the library's spent
   states and this server's sent messages — would fail **open** on a restart. That deployment
   needs a shared store, and until it has one it must not offer the newer revision.

A test that proves it has to drive the real thing rather than the in-memory pair.
`test/harness.ts` has `connectModern`, which serves the server through `serveStdio` with
`autoFulfill: false`; "will not spend the same answer twice" in `test/send.test.ts` hands the same
`requestState` back twice and asserts one delivery. Keep that test green when the entry point or
the library changes — it is the one that fails first.

**The residual case, stated rather than hidden.** If the connection fails _after_ the end of
`DATA` and before the SMTP server's `250`, the outcome is genuinely unknown at this layer —
nodemailer cannot distinguish it from a failure before `DATA` either, and the message may
already be queued for delivery. Two things follow the safe side of that uncertainty: the
rate-limit slot is kept rather than released, and an audit line is written recording the outcome
as unknown, because a delivered message with no record at all is the failure the audit log
exists to prevent. What is not done is remembering it as sent — most failures on that path are
real failures, and locking the retry out for the whole approval window would be the wrong trade
for the common case. **A retry after an error of that shape is therefore the one path on which
this server can still deliver twice.**

## Untrusted content

The text a caller passes as a quoted original — for a reply or a forward — was written by
whoever sent that original, and anyone in the world can send mail. It is **passed on unchanged**,
because altering a forwarded message would be the wrong fix. What happens instead is that it is
checked against known prompt-injection shapes, and any match is reported as its own line in the
confirmation dialog, naming the shapes. The human decides.

The injection patterns are a **signal**, never a filter. A server that silently refused to
forward messages containing the word "urgent" would be useless, and one that appeared to filter
reliably would be an argument for trusting whatever got through — precisely the wrong conclusion.

Text travelling back to the model is normalised: zero-width and directional-override characters
removed, and markdown image syntax defused so a rendering client cannot be induced to fetch a
URL carrying data in its query string ([EchoLeak](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711),
CVE-2025-32711). That defusing runs **only** towards the model, never on the outgoing message: a
mail client is supposed to render the images in a message somebody deliberately sent, and
rewriting an approved body would corrupt it.

The rendered message in `preview_mail` is returned between markers carrying a per-call random
nonce, with every line prefixed by that nonce. Text written before the call cannot predict
either, so quoted content cannot close the block early and continue in the server's voice.

**Be clear about what framing buys.** Measured across models, delimiting untrusted content takes
resistance to injection from roughly 61% to roughly 90% — a real improvement, and nowhere near a
guarantee. Against an attacker who adapts to the defence, prompt-level measures fail. Here they
are a speed bump; the allowlist and the human confirmation are the wall.

## Formatted messages

`format: "markdown"` adds an HTML part to a message, and HTML is where a message can say less
than it does: a script that runs on open, a remotely loaded image that reports when and where
the message was read, a link whose text names one site and whose target is another. None of
that can be seen in a confirmation dialog that shows a subject and a body.

So this server never takes HTML from its caller. Up to 0.2 it did, and cleaned it with a set of
regular expressions; four rounds of review found a denial of service and three ways past it, each
a place where the patterns and a real HTML parser read the same markup differently. That class of
bug is not one more pattern away from closed, so the input it came from is gone.

The HTML part is now **rendered from the Markdown body**, with markdown-it set up to escape every
`<`, `>`, `&` and `"` in the source. The only tags in the result are the renderer's own, so there
is nothing to remove and nothing to get past:

- **Raw HTML is text.** `<script>`, `<img>`, `<style>` or an `onerror=` arrive as the characters
  typed. So do character references: `&#x202E;` stays those eight characters rather than
  becoming a bidi override, and `&#73;gnore` stays as written rather than becoming a word.
- **Nothing loads by itself.** An image becomes a link to the image. There is no `<img>`, no
  `style` and no remote resource in the part, so it cannot carry a tracking pixel.
- **Links go to `https`, `http` or one plain `mailto` address.** Anything else — `javascript:`,
  `data:`, a relative path, credentials in the URL, a `mailto` with a query that would fill in
  `cc` or a body — stays as text. Reference-style links (`[text][label]`) stay as text too: one
  long destination reused by a few characters each made a 100 000-character body render to
  hundreds of megabytes, through `preview_mail`, which nothing gates.
- **Link text cannot claim another destination.** When the text of a link names any host,
  address or IP other than its target — alone, inside a sentence, in quotes, glued to
  punctuation, written with lookalike dots or fullwidth letters — or the target is an
  internationalised domain, or the text contains invisible or direction-changing characters,
  the HTML shows the target itself. The check fails closed: what looks like a host is
  compared, not what matches one exact pattern.
- **The rendered HTML is checked against a fixed list** of tags and attributes, and against a
  fixed size ceiling of 2 000 000 characters (twenty times the largest Markdown body), before it
  is used. Anything else refuses the
  message rather than sending it — this is a check of the renderer's own output, not a
  sanitiser.
- **Nesting the renderer would cut off is refused**, so the HTML part never lacks text the plain
  part has.

The plain-text part is the body exactly as written, and it is what the dialog shows. The HTML is
derived from it, so it says nothing the body does not. What a rendering can still hide is where
a link goes: `[agenda](https://…?id=…)` shows the word "agenda", and the body line in the dialog
is cut at 200 characters. So the dialog lists **every host the HTML part links to on a line of
its own** — the end of a long host first, because that is where its registrable domain sits and
every dialog value is cut at 200 characters — with how many links go there and the first of
them. A body linking to more than twenty different hosts is refused before anyone is asked: a
list that summed up its tail would hide exactly the link that matters. A host longer than DNS
allows is not a link at all. The count and the notes about rewritten or refused links stand in
the consequence, in the server's words and uncut, not among the caller-supplied values.

The prompt-injection check reads the body as written, as rendered — Markdown can split a word,
and `ig*n*ore all previous instructions` matches nothing in the source — and with invisible
characters removed and compatibility forms folded, so a soft hyphen or fullwidth letters do not
hide a phrase either. When the body or the quoted original contains a bidi override or isolate,
a zero-width space, a word joiner or a soft hyphen, the consequence says so: the dialog cannot
show them, and the recipient's mail client obeys them. Joiners and direction marks are not
counted — emoji and right-to-left scripts need them, and they hide nothing. An autolink shows its destination exactly as written, never percent-decoded into words.

The rendering module is the same file, byte for byte, as the one `imap-mcp` uses for drafts, and
its tests pin that.

## Attachments

Attachments are unavailable until `SMTP_ATTACHMENT_DIR` is set. The directory comes solely from
that variable, never from a tool argument, so a caller — and therefore a message that talked the
model into a tool call — cannot choose which part of the filesystem gets mailed out.

A named file passes an extension allowlist, a content-type allowlist, an executable-extension
refusal and a size ceiling, and then a magic-byte check on the bytes themselves. The last one is
the one that cannot be lied to: a binary copied to `report.pdf` clears every other gate and
fails there. Sending an executable out under your own name and your own DKIM signature is worse
than receiving one, because it is trusted on arrival.

For the same reason `text/html` and `application/zip` are not in the default type list. An HTML
file opens in a browser rather than a mail client, and unlike the HTML part of a message nobody
but its author wrote it; an archive passes the magic-byte check on its own bytes and can carry the
executable the check never sees. An operator who needs either writes it into
`SMTP_ATTACHMENT_TYPES`.

The size and type are checked on the opened file, not only on the path: between the `lstat` and
the `open`, a writer in the directory could swap the file for a FIFO or grow it past the ceiling,
so the open is non-blocking, the checks run again on the handle, and the read is capped at the
size the handle reported.

The name must be a plain filename. Separators, `..` and leading dots are refused rather than
normalised away, the resolved path is checked against the directory again, symlinks are refused
outright, and the file is opened with `O_NOFOLLOW` where the platform has it.

## Audit

Every message the SMTP server accepts is recorded on stderr — the one channel the model never
reads — with the recipients, the subject, the Message-ID and the size. `SMTP_AUDIT_LOG` adds a
file sink for the same lines, which is what makes the record outlive the terminal window the
client was started in.

Refusals are recorded as well — `outcome=refused` for an address the allowlist does not cover or
an attachment that fails its checks, `declined` when the person said no, `token_rejected` when a
token did not match — with the recipients and subject that were asked for. A log of what went out
cannot answer the question that matters most after an incident, _was this session being steered?_,
because a steered session's attempts are mostly refused. The refusals are the evidence.

Bodies are never recorded. The subject is, because without it the log cannot be matched against
anything; a body would turn the audit file into a second copy of the correspondence.

Every string value and every array element is written as a JSON string, always — never only when
it happens to contain a space. The caller chooses the subject and the attachment names, and this
file is the record of what a hijacked session actually sent, so the one thing it must not do is
let the attacker write it. A subject of `Invoice_bcc=[quiet@evil.example]_accepted=1` used to be
logged unquoted and gave any parser splitting on `key=` a `bcc` field that never existed.
Numbers and booleans stay bare; a JSON string always begins with a quote, so the two are never
ambiguous.
