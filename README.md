# team-plus-server

> Own your TeamPlus history — capture every message (and image, and file) into your own cloud database, and bridge it to Telegram. No laptop required.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Turso](https://img.shields.io/badge/Turso-libSQL-4FF8D2?logo=turso&logoColor=black)](https://turso.tech/)
[![Bun](https://img.shields.io/badge/Bun-000?logo=bun&logoColor=white)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![last commit](https://img.shields.io/github/last-commit/htlin222/team-plus-server)](https://github.com/htlin222/team-plus-server/commits/main)

Self-hosted tooling around a [TeamPlus](https://www.teamplus.tech/) account:

1. **Telegram bridge** — a long-lived daemon that mirrors your incoming
   TeamPlus messages to a Telegram bot DM and lets you reply (or have an
   assistant draft replies) from your phone.
2. **Cloud archive** — an always-on Cloudflare Worker that captures every
   message into your own [Turso](https://turso.tech/) (SQLite) database, so you
   have a private, queryable log of *who said what, when, where* — DMs, groups,
   and bots — without keeping a laptop running.

Both talk to TeamPlus over the same authenticated WebSocket + REST endpoints.
The TeamPlus instance URL is configured via `TEAMPLUS_BASE`; nothing about a
specific organisation is baked into the source.

> **Heads-up:** TeamPlus has no public API. This drives the same endpoints the
> web client uses, authenticated with session cookies you refresh yourself.
> Use it only with your own account and within your organisation's policies.

## Features

- 🗄️ **Cloud message archive** — a Durable Object holds the TeamPlus WebSocket and writes every message to Turso: who, when, which chat, direction, content. DMs, groups, and bots.
- 🏷️ **Name resolution** — numeric sender/chat IDs are resolved to real names via the TeamPlus REST API (cached per session).
- 🖼️ **Attachment archive** — images and files are downloaded and stored in R2; rich flex cards are kept as JSON.
- 🔗 **Time-limited viewer links** — signed, browser-openable URLs for any attachment that the worker hard-caps to expire within a week.
- 🔑 **Read API** — `GET /v1/logs` returns recent messages as JSON (default 24h, up to 7 days), gated by a shareable read-only key. Browse from the CLI with `./scripts/logs.mjs` (see the [Playbook](docs/PLAYBOOK.md)).
- 📲 **Telegram bridge** — incoming messages mirror to a Telegram bot DM; reply, or have an assistant draft replies, from your phone.
- ♻️ **Self-healing** — the Durable Object reconnects on drops, with a cron keepalive as backstop.
- ☁️ **No laptop required** — cookie refresh runs as a GitHub Actions cron.
- 🤖 **MCP server** — exposes the bridge to Claude Code.

## Architecture

```
                          ┌─────────────────────────────┐
   your TeamPlus account  │  TeamPlus (TEAMPLUS_BASE)    │
                          └───────────┬─────────────────┘
              WebSocket + REST (session cookies)
                          ┌───────────┴───────────┐
            ┌─────────────▼──────────┐   ┌─────────▼───────────────────┐
            │ channel/  (Bun daemon) │   │ worker/  (Cloudflare Worker)│
            │ • TeamPlus WS listener │   │ • Durable Object holds the  │
            │ • Telegram bridge      │   │   cookie + WS, self-heals   │
            │ • MCP server for       │   │ • normalises every message  │
            │   Claude Code          │   │ • resolves sender/chat names│
            └───────────┬────────────┘   │ • Turso + R2 attachments    │
                        │                 └─────────────┬───────────────┘
                 Telegram bot DM                        │
                        │                          Turso (SQLite)
                     your phone                  who / when / where / what
```

The two halves are independent — run either or both. The cloud archive needs no
local process once deployed; the only recurring task is re-uploading fresh
cookies (~daily), which a GitHub Actions cron handles for you.

## Repo layout

| Path | What |
| --- | --- |
| `channel/` | Bun daemon: TeamPlus WebSocket ↔ Telegram bridge + MCP server |
| `worker/`  | Cloudflare Worker + Durable Object → Turso archive (see `worker/README.md`) |
| `scripts/` | Cookie refresh (Patchright + Tesseract OCR), signed upload, `logs.mjs`/`attachment_url.mjs`/`healthcheck.mjs` helpers |
| `docs/`    | [Operations playbook](docs/PLAYBOOK.md) — querying logs, monitoring, key rotation, troubleshooting |
| `.claude/` | `dms` skill + a Stop-hook that relays assistant replies to Telegram |
| `Makefile` | Daemon lifecycle (`make start` / `stop` / `logs`, launchd-managed) |

## Prerequisites

- [Bun](https://bun.sh/) — runs the `channel/` daemon
- Node.js + [pnpm](https://pnpm.io/) — runs the worker tooling
- Python 3 — cookie refresh (a venv is bootstrapped automatically)
- [Tesseract](https://github.com/tesseract-ocr/tesseract) — captcha OCR (`brew install tesseract`)
- For the cloud archive: [`wrangler`](https://developers.cloudflare.com/workers/wrangler/),
  the [`turso`](https://docs.turso.tech/cli/installation) CLI, and a Cloudflare + Turso account

## Setup

```sh
# 1. Configuration
cp .env.example .env          # set TEAMPLUS_BASE + your TeamPlus login
./scripts/setup_telegram.sh   # writes .telegram.json (bot token + chat_id)

# 2. First cookie capture (also fills my_id in .config.json)
./scripts/refresh.sh          # headless login + OCR; --headful to watch

# 3a. Run the Telegram bridge daemon
make start                    # launchd-managed; `make logs` to tail

# 3b. (optional) Deploy the cloud archive
cd worker
pnpm install
turso auth login
./scripts/setup_turso.sh teamplus-messages   # creates DB + schema + secrets
#   → edit worker/.dev.vars and set TEAMPLUS_BASE
./scripts/push_secrets.sh && wrangler deploy
#   → set CF_TEAMPLUS_WORKER_URL in ../.cf-worker.env to the deployed URL
cd ..
./scripts/refresh_and_upload_cf.sh           # refresh cookies + push to worker
```

The TeamPlus session token (TSSID) lives ~1 day, so schedule
`./scripts/refresh_and_upload_cf.sh` to keep the cloud session alive. Locally
that's launchd/cron; to drop the laptop entirely, run it from CI.

## Keeping cookies fresh in the cloud (GitHub Actions)

`.github/workflows/refresh-cookies.yml.example` runs the cookie refresh on a
GitHub-hosted runner (Chromium + Tesseract) and uploads to your worker — no
machine of your own needed. Recommended split for open-sourcing:

- **Public repo** — the code, with the workflow as a `.example` template only.
- **Private repo** — your actual deployment: copy the template to
  `.github/workflows/refresh-cookies.yml` and add the five Secrets it lists
  (`TEAMPLUS_ACCOUNT`, `TEAMPLUS_PASSWORD`, `TEAMPLUS_BASE`,
  `CF_TEAMPLUS_WORKER_URL`, `CF_TEAMPLUS_UPLOAD_SECRET`).

GitHub Actions Secrets are encrypted, never stored in the repo, and masked in
logs — open-sourcing the code does not expose them. Keep the running workflow in
the private repo and use only `schedule` / `workflow_dispatch` triggers (never
`pull_request`) so fork PRs can never reach the secrets.

## Configuration & secrets

All secrets live in gitignored files; templates are committed:

| File | Holds | Template |
| --- | --- | --- |
| `.env` | `TEAMPLUS_BASE`, TeamPlus login | `.env.example` |
| `.telegram.json` | Telegram bot token + chat_id | `scripts/setup_telegram.sh` |
| `.config.json` | your TeamPlus `my_id` + mute lists | auto-filled |
| `cookies.json` | captured session cookies | `scripts/refresh.sh` |
| `worker/.dev.vars` | Turso creds, upload secret, `TEAMPLUS_BASE`, `TEAMPLUS_DB_KEY` | `worker/.dev.vars.example` |
| `.cf-worker.env` | deployed worker URL + upload secret | `worker/scripts/setup_turso.sh` |

Nothing in version control contains a real credential or organisation URL.

## License

[MIT](LICENSE).
