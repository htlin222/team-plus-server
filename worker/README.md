# TeamPlus Cloud Worker

Cloudflare Worker + Durable Object session layer for TeamPlus message capture.

## Shape

- `src/index.ts`: signed HTTP API for cookie upload, status, start, stop, nudge, backfill.
- `src/session.ts`: one Durable Object per TeamPlus account; owns cookie state and the TeamPlus WebSocket.
- `src/turso.ts`: inserts normalized `IM_CHAT:NEW_MESSAGE` events into Turso.
- `src/contacts.ts`: resolves sender/chat names via the TeamPlus REST API.
- `src/attachments.ts`: downloads image/file messages and archives them to R2.
- `schema.sql`: Turso tables for message history and session events.

## Setup

```sh
cd worker
pnpm install
turso auth login
./scripts/setup_turso.sh teamplus-messages   # Turso DB + secrets + .dev.vars
wrangler r2 bucket create teamplus-attachments
#   → edit worker/.dev.vars and set TEAMPLUS_BASE
./scripts/push_secrets.sh
wrangler deploy
```

After deploy, edit `../.cf-worker.env` and set `CF_TEAMPLUS_WORKER_URL` to the deployed `workers.dev` URL.

## Attachments

Image (`msg_type` 205) and file (206) messages carry no bytes — only a
`FileName` reference in `Content2`. The Durable Object downloads the file from
`DownloadFileHandler.ashx` with the session cookie, stores it in the
`teamplus-attachments` R2 bucket under `attachments/<batchID>/<fileName>`, and
records that key in the `attachment_key` column. Failures are non-fatal (the
text row is still saved) and can be repaired later:

```sh
# archive any messages whose attachment isn't stored yet
./scripts/cf_worker_request.mjs POST /v1/sessions/default/backfill-attachments '{"limit":50}'
```

## Read API (`GET /v1/logs`)

A read-only log endpoint gated by `TEAMPLUS_DB_KEY` (a secret separate from the
admin `COOKIE_UPLOAD_SECRET`, so you can share read access without granting
control). Returns recent messages as JSON, newest first, with a signed viewer
link for any attachment.

```sh
# key via header (preferred) or ?key=
curl -H "X-API-Key: $TEAMPLUS_DB_KEY" "https://<worker>/v1/logs"           # default: last 24h
curl -H "X-API-Key: $TEAMPLUS_DB_KEY" "https://<worker>/v1/logs?hours=6"
curl -H "X-API-Key: $TEAMPLUS_DB_KEY" "https://<worker>/v1/logs?days=7"    # max window
curl "https://<worker>/v1/logs?key=$TEAMPLUS_DB_KEY&days=3"
```

- Window: `?hours=N` or `?days=N`. Default **24h**, hard-capped at **7 days**.
- `?limit=N` caps the row count (default/max 2000).
- Missing/invalid key → `401`.

```jsonc
{
  "since": "2026-06-18T...Z",
  "window_hours": 24,
  "count": 41,
  "messages": [
    {
      "ts": "2026-06-19T...Z",
      "direction": "in",
      "channel_type": 0,
      "chat_id": "40_1049",
      "chat_name": "...",
      "sender_id": 40,
      "sender_name": "...",
      "msg_type": 1,
      "content": "...",
      "attachment": { "name": "IMG_2087.jpg", "url": "https://<worker>/a?key=...&exp=...&sig=..." }
    }
  ]
}
```

The `attachment.url` is a signed viewer link valid for one week (see below).

### Viewing an attachment

`GET /a?key=...&exp=...&sig=...` streams an R2 object in the browser. The link
is HMAC-signed with `COOKIE_UPLOAD_SECRET` and **expires within one week** — the
worker rejects any link minted to live longer (400) or already past `exp` (410),
regardless of the secret. Mint one from the repo root:

```sh
./scripts/attachment_url.mjs <attachment_key | event_key | batch_id>
# → https://<worker>/a?key=...&exp=...&sig=...   (valid 1 week)
```

## Local Cookie Refresh Upload

From repo root:

```sh
./scripts/refresh_and_upload_cf.sh
```

For launchd or cron, run the same command every 3 days. The script refreshes `cookies.json` locally via the existing Patchright/Tesseract flow, then uploads the cookie jar to:

```text
POST /v1/sessions/default/cookies
```

The upload is HMAC-signed with `CF_TEAMPLUS_UPLOAD_SECRET`; the Worker stores only the resulting cookie header inside the Durable Object.

## Useful Worker Endpoints

All session endpoints require the same HMAC signature headers:

- `GET /v1/sessions/default/status`
- `POST /v1/sessions/default/start`
- `POST /v1/sessions/default/stop`
- `POST /v1/sessions/default/nudge`
- `POST /v1/sessions/default/backfill-attachments` (`{"limit":50}`)

`GET /health` is unsigned and returns a basic liveness response.

From repo root, use the helper for signed calls:

```sh
./scripts/cf_worker_request.mjs
./scripts/cf_worker_request.mjs POST /v1/sessions/default/nudge '{}'
```
