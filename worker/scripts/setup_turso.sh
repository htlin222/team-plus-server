#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$(dirname "$SCRIPT_DIR")"
DB_NAME="${1:-teamplus-messages}"

if ! turso auth whoami >/dev/null 2>&1; then
  echo "Turso CLI is not logged in. Run: turso auth login" >&2
  exit 1
fi

if ! turso db show "$DB_NAME" >/dev/null 2>&1; then
  turso db create "$DB_NAME"
fi

SQL="$(cat "$WORKER_DIR/schema.sql")"
turso db shell "$DB_NAME" "$SQL"

TURSO_URL="$(turso db show "$DB_NAME" --url)"
TURSO_AUTH_TOKEN="$(turso db tokens create "$DB_NAME")"
COOKIE_UPLOAD_SECRET="$(openssl rand -hex 32)"

umask 077
cat > "$WORKER_DIR/.dev.vars" <<EOF
TURSO_URL="$TURSO_URL"
TURSO_AUTH_TOKEN="$TURSO_AUTH_TOKEN"
COOKIE_UPLOAD_SECRET="$COOKIE_UPLOAD_SECRET"
# TeamPlus instance base URL (origin, no trailing slash). REQUIRED — edit this.
TEAMPLUS_BASE="${TEAMPLUS_BASE:-https://team.your-org.example}"
EOF

cat > "$WORKER_DIR/../.cf-worker.env" <<EOF
CF_TEAMPLUS_WORKER_URL="https://teamplus-cloud-worker.<your-workers-subdomain>.workers.dev"
CF_TEAMPLUS_ACCOUNT_ID="default"
CF_TEAMPLUS_UPLOAD_SECRET="$COOKIE_UPLOAD_SECRET"
EOF

echo "Wrote worker/.dev.vars and .cf-worker.env."
echo "Next:"
echo "  cd worker && ./scripts/push_secrets.sh && wrangler deploy"
echo "  edit .cf-worker.env CF_TEAMPLUS_WORKER_URL after deploy prints your workers.dev URL"
