# Operations Playbook

Day-to-day running and troubleshooting for a deployed `team-plus-server`. For
setup, see the root [README](../README.md) and [worker/README](../worker/README.md).

## What runs automatically

| Piece | Where | Cadence | Does |
| --- | --- | --- | --- |
| Durable Object | Cloudflare Worker | always-on | holds the TeamPlus WS, captures messages → Turso, files → R2, self-heals |
| Keepalive cron | Worker `scheduled` | every 5 min | nudges the DO to reconnect if its alarm chain dropped |
| `refresh-cookies` | GitHub Actions (private repo) | every 12 h | re-logs in, uploads fresh cookies to the worker |
| `worker-healthcheck` | GitHub Actions (private repo) | daily 09:00 Taipei | probes the worker, posts a report to Telegram, fails (emails) if unhealthy |

You should receive **one Telegram health report each morning**. That is the
primary signal that everything is alive.

## Reading the message log

### CLI — `scripts/logs.mjs`

```sh
./scripts/logs.mjs                 # last 24h (default)
./scripts/logs.mjs --hours 6
./scripts/logs.mjs --days 7        # 7 = server-enforced maximum
./scripts/logs.mjs --from 邱子玲    # filter by sender (substring)
./scripts/logs.mjs --in            # only inbound (others → you)
./scripts/logs.mjs --out           # only outbound (you → others)
./scripts/logs.mjs --files --url   # only attachments, print viewer URLs
./scripts/logs.mjs --limit 50
./scripts/logs.mjs --days 3 --json # raw JSON (after filters)
```

Key + worker URL are read from `worker/.dev.vars` and `.cf-worker.env`
automatically (or from `TEAMPLUS_DB_KEY` / `CF_TEAMPLUS_WORKER_URL` env vars).

### Raw API — `GET /v1/logs`

```sh
KEY=$(grep '^TEAMPLUS_DB_KEY=' worker/.dev.vars | cut -d= -f2- | tr -d '"')
W=$(grep CF_TEAMPLUS_WORKER_URL .cf-worker.env | cut -d'"' -f2)

curl -s -H "X-API-Key: $KEY" "$W/v1/logs?days=2" | jq '.count'
curl -s -H "X-API-Key: $KEY" "$W/v1/logs"       | jq '.messages[] | select(.direction=="in") | {ts,sender_name,content}'
curl -s -H "X-API-Key: $KEY" "$W/v1/logs?days=7" | jq -r '.messages[] | select(.attachment) | .attachment.url'
```

Window: `?hours=N` / `?days=N`, default **24h**, hard-capped at **7 days**.
`?limit=N` caps rows (max 2000). Missing/invalid key → `401`.

## Sending a message

```sh
./scripts/send.mjs --to 1344 --text "晚點回你"          # DM by peer userNo (= sender_id in the log)
./scripts/send.mjs --chat-id 1049_1344 --text "…"      # explicit DM chat id
./scripts/send.mjs --chat-id <group-guid> --text "…"   # group (chat_id from the log)
```

Goes through the worker (cloud), so it works with the laptop off. Admin-signed
with `CF_TEAMPLUS_UPLOAD_SECRET`. Both DMs and groups work — a `n_n` chat id is a
DM, a GUID is a group (existing groups resolve from the chat id, no member list
needed). The sent message — and any reply — is captured back into the log.

Quote-reply a specific message with `--reply <id>` (get the id from
`logs.mjs --ids`, which prints each message's id and a ready-to-paste command):

```sh
./scripts/logs.mjs --days 1 --ids
./scripts/send.mjs --to 1344 --reply 7071b7aa-… --text "收到"
```

## Viewing an attachment

The API and `logs.mjs --url` already give a signed viewer URL per attachment.
To mint one by hand:

```sh
./scripts/attachment_url.mjs <attachment_key | event_key | batch_id>
```

Links are signed and **expire within one week** (the worker rejects anything
longer, even with the secret).

## Health checks (manual)

```sh
# live status (signed admin request)
./scripts/cf_worker_request.mjs GET /v1/sessions/default/status

# force the cloud healthcheck now (also sends Telegram)
gh workflow run healthcheck.yml --repo htlin222/team-plus-server-live

# force a cookie refresh now
gh workflow run refresh-cookies.yml --repo htlin222/team-plus-server-live
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Telegram report shows `🔴` / `connected:false` | WS dropped and didn't recover | `cf_worker_request.mjs POST /v1/sessions/default/nudge '{}'`; if still down, check cookie age |
| `cookie stale (>36h)` in report | the refresh cron stopped working | check `gh run list --repo …/team-plus-server-live`; re-run `refresh-cookies.yml`; if it keeps failing, see next row |
| `refresh-cookies` Action red | TeamPlus password changed, or captcha OCR kept missing | update `TEAMPLUS_PASSWORD` secret if changed; re-run (OCR is retried up to 8×); check the run log |
| `lastError` mentions websocket/getToken | cookie expired/invalid | run a refresh; the DO reconnects on the next cookie upload |
| Quiet — no new messages | normal during off-hours | confirm `connected:true`; nothing to do |
| API returns Cloudflare `1101` | worker threw at runtime | `cd worker && pnpm exec wrangler tail` while reproducing |
| No daily Telegram report | bot token/chat_id changed, or Action disabled | verify `TELEGRAM_*` secrets; check the Action is enabled in the private repo |

## Secrets & key rotation

Where each secret lives:

| Secret | Worker (wrangler) | `worker/.dev.vars` | `.cf-worker.env` | `.env` | GH Actions (private) |
| --- | :-: | :-: | :-: | :-: | :-: |
| `TURSO_URL` / `TURSO_AUTH_TOKEN` | ✓ | ✓ | | | ✓ (healthcheck) |
| `COOKIE_UPLOAD_SECRET` (admin) | ✓ | ✓ | as `CF_TEAMPLUS_UPLOAD_SECRET` | | ✓ |
| `TEAMPLUS_BASE` | ✓ | ✓ | | ✓ | ✓ |
| `TEAMPLUS_DB_KEY` (read API) | ✓ | ✓ | | | |
| `TEAMPLUS_ACCOUNT` / `TEAMPLUS_PASSWORD` | | | | ✓ | ✓ |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | | | (`.telegram.json`) | ✓ |

Rotate the **read API key** (`TEAMPLUS_DB_KEY`) — e.g. after sharing it:

```sh
NEW=$(openssl rand -hex 32)
sed -i '' "s/^TEAMPLUS_DB_KEY=.*/TEAMPLUS_DB_KEY=$NEW/" worker/.dev.vars
cd worker && ./scripts/push_secrets.sh && cd ..   # re-pushes all secrets
```

Rotate the **admin upload secret** (`COOKIE_UPLOAD_SECRET`): regenerate it in
`worker/.dev.vars`, mirror the same value into `.cf-worker.env`
(`CF_TEAMPLUS_UPLOAD_SECRET`) and the private repo's `CF_TEAMPLUS_UPLOAD_SECRET`
Action secret, then `push_secrets.sh` + `wrangler deploy`.

TeamPlus **password change**: update `TEAMPLUS_PASSWORD` in `.env` (local) and as
the `TEAMPLUS_PASSWORD` Action secret in the private repo.

## Deploying changes

```sh
# worker code
cd worker && pnpm exec tsc --noEmit && pnpm exec wrangler deploy

# workflow changes (keep the active workflow OUT of the public repo)
git checkout live && git merge main
#   edit .github/workflows/*.yml
git commit -am "…" && git push private live:main && git checkout main
```

## Repos

- **Public** — `htlin222/team-plus-server`: all code, workflows as `.example` only.
- **Private** — `htlin222/team-plus-server-live`: active workflows + the 9 Action
  Secrets. Its default branch `main` is what the cron runs from. Locally this is
  the `private` remote / `live` branch.
