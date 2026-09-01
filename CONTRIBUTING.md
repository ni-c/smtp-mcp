# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/smtp-mcp.git
cd smtp-mcp
npm install
npm test
npm run build
```

## Running the integration suite

Everything in `test/` runs against an in-memory fake, which is the right trade for a unit suite
and proves nothing about MIME encoding, the SMTP dialogue or the envelope. The integration suite
spawns the built server over stdio against a throwaway [Mailpit](https://mailpit.axllent.org/)
and calls **every tool in the catalogue**, then reads each message back out of Mailpit — so the
assertions are about what _arrived_, not about what the tool said it did.

```sh
docker compose -f test/integration/compose.yml up -d --wait
npm run build && npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

- SMTP on `127.0.0.1:1025`, no TLS, any credentials accepted
- Web UI and API on <http://127.0.0.1:8025>

Both ports are bound to loopback. **Do not change that:** Mailpit accepts mail from anyone
without authentication, so a port published on `0.0.0.0` is an open relay on your local network
for as long as the container runs. If something already listens on one of them — 8025 is a
popular port — override both, and pass the same values to the suite, which reads the identical
variables:

```sh
export MAILPIT_SMTP_PORT=1125 MAILPIT_UI_PORT=8125
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
```

**Develop against it, not against a real mailbox.** This server's whole job is to put messages
on the wire, and a test run that goes wrong sends real mail to real people — which is the one
mistake here that cannot be undone by reverting a commit. The suite sets `SMTP_ALLOW_SEND=true`
and `SMTP_ALLOWED_RECIPIENTS=@example.net`, and the harness refuses any backend that is not on
this machine.

One thing about reading messages back that cost an afternoon: Mailpit's `/raw` is **not** the
wire message. It prepends a `Bcc:` line reconstructed from the envelope — recipients minus To
and Cc — above even its own `Received` header, so `/raw` always says the Bcc travelled in the
headers. It cannot answer that question. The wire bytes are asserted in `test/compose.test.ts`;
the suite checks the observable consequence instead.

To drive the server by hand:

```sh
SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_TLS=none \
SMTP_USER=sandbox SMTP_PASSWORD=sandbox \
SMTP_FROM='Sandbox <sandbox@example.net>' \
SMTP_ALLOW_SEND=true SMTP_ALLOWED_RECIPIENTS='@example.net' \
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change. The suite runs
  against an in-memory fake (`test/fake-smtp.ts`) and boots the real server over an in-memory
  transport, so a test can assert on exactly what a human was shown in the confirmation dialog.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (the recipient allowlist, the confirmation gate, header
  composition, the attachment path guard): please describe the attack you are defending against,
  or the one your change might open, in the PR text. `test/injection.test.ts` is where those
  attacks are written down as tests; add yours there.
- **Four properties are not up for negotiation**, because they are why this server is safe to
  point at a real mailbox:
  1. sending is off until `SMTP_ALLOW_SEND=true`, and the tools are not registered before then;
  2. every send asks a human;
  3. every recipient is checked against `SMTP_ALLOWED_RECIPIENTS`;
  4. there is no way for a caller to choose the sender.

  A patch that adds a bypass for any of them — a `force` flag, a "trusted caller" mode, a
  `from` parameter — will be declined regardless of how it is written.

- **The quoted original is passed on unchanged.** Warn about it, never rewrite it.
- **No new runtime dependencies** without a very good reason; the small tree is a feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier also
  validates the YAML, JSON and Markdown files.

## Questions and bugs

Questions belong in [Discussions](https://github.com/ni-c/smtp-mcp/discussions), reproducible
problems in [Issues](https://github.com/ni-c/smtp-mcp/issues), and vulnerabilities in
[private reporting](https://github.com/ni-c/smtp-mcp/security/advisories/new) — see
[SECURITY.md](SECURITY.md).
