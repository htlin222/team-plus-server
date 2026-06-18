# TeamPlus Cloud Worker

Cloudflare Worker + Durable Object session layer for TeamPlus message capture.

## Shape

- `src/index.ts`: signed HTTP API for cookie upload, status, start, stop, nudge.
- `src/session.ts`: one Durable Object per TeamPlus account; owns cookie state and the TeamPlus WebSocket.
- `src/turso.ts`: inserts normalized `IM_CHAT:NEW_MESSAGE` events into Turso.
- `schema.sql`: Turso tables for message history and session events.

## Setup

```sh
cd worker
pnpm install
turso auth login
./scripts/setup_turso.sh teamplus-messages
./scripts/push_secrets.sh
wrangler deploy
```

After deploy, edit `../.cf-worker.env` and set `CF_TEAMPLUS_WORKER_URL` to the deployed `workers.dev` URL.

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

`GET /health` is unsigned and returns a basic liveness response.

From repo root, use the helper for signed calls:

```sh
./scripts/cf_worker_request.mjs
./scripts/cf_worker_request.mjs POST /v1/sessions/default/nudge '{}'
```
