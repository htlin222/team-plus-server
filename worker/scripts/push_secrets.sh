#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$(dirname "$SCRIPT_DIR")"
cd "$WORKER_DIR"

if [ ! -f .dev.vars ]; then
  echo "Missing worker/.dev.vars. Run ./scripts/setup_turso.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.dev.vars
set +a

printf '%s' "$TURSO_URL" | wrangler secret put TURSO_URL
printf '%s' "$TURSO_AUTH_TOKEN" | wrangler secret put TURSO_AUTH_TOKEN
printf '%s' "$COOKIE_UPLOAD_SECRET" | wrangler secret put COOKIE_UPLOAD_SECRET
printf '%s' "$TEAMPLUS_BASE" | wrangler secret put TEAMPLUS_BASE
printf '%s' "$TEAMPLUS_DB_KEY" | wrangler secret put TEAMPLUS_DB_KEY
