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

For anything touching the send path you want a real SMTP server that delivers nowhere. There is
a throwaway one in the repository:

```sh
docker compose -f scripts/sandbox/docker-compose.yml up -d
npm run build && node scripts/sandbox/smoke.mjs
```

See [`scripts/sandbox/README.md`](scripts/sandbox/README.md). **Develop against it, not against
a real mailbox.** This server's whole job is to put messages on the wire, and a test run that
goes wrong sends real mail to real people — which is the one mistake here that cannot be undone
by reverting a commit.

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
- Run `npm run lint` before pushing — it checks both eslint and prettier, and prettier also
  validates the YAML, JSON and Markdown files.

## Questions and bugs

Questions belong in [Discussions](https://github.com/ni-c/smtp-mcp/discussions), reproducible
problems in [Issues](https://github.com/ni-c/smtp-mcp/issues), and vulnerabilities in
[private reporting](https://github.com/ni-c/smtp-mcp/security/advisories/new) — see
[SECURITY.md](SECURITY.md).
