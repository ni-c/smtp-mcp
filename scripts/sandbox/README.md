# Sandbox

A throwaway [Mailpit](https://mailpit.axllent.org/) instance for developing and
verifying smtp-mcp. It speaks real SMTP, keeps every message it receives, and
delivers nothing to the outside world.

That last part is the reason it exists. This server's job is to send mail, so
every test of the real path either goes to a sink you control or goes to a
stranger. Mailpit is the sink.

## Run it

```sh
docker compose -f scripts/sandbox/docker-compose.yml up -d
```

- SMTP on `127.0.0.1:1025`, no TLS, any credentials accepted
- Web UI and API on <http://127.0.0.1:8025>

Both ports are bound to loopback. Do not change that: Mailpit accepts mail from
anyone without authentication, so a port published on `0.0.0.0` is an open relay
on your local network for as long as the container runs.

If something already listens on one of those ports, override them — and pass
the same values to the smoke script, which reads the identical variables:

```sh
export MAILPIT_SMTP_PORT=1025 MAILPIT_UI_PORT=18025
docker compose -f scripts/sandbox/docker-compose.yml up -d
```

## Point the server at it

```sh
export SMTP_HOST=127.0.0.1
export SMTP_PORT=1025
export SMTP_TLS=none
export SMTP_USER=sandbox
export SMTP_PASSWORD=sandbox
export SMTP_FROM='Sandbox <sandbox@example.net>'
export SMTP_ALLOW_SEND=true
export SMTP_ALLOWED_RECIPIENTS='@example.net'
```

`SMTP_TLS=none` prints a warning unless the host is loopback, which it is here,
so the run stays quiet.

## Drive it

```sh
npm run build
node scripts/sandbox/smoke.mjs
```

The smoke script starts the built server over stdio, walks it through a send,
and then reads the message back out of Mailpit's API to check that what arrived
is what was composed. It is the only test that exercises real MIME encoding
against a real SMTP server; everything in `test/` uses the in-memory fake.

## Tear it down

```sh
docker compose -f scripts/sandbox/docker-compose.yml down -v
```
