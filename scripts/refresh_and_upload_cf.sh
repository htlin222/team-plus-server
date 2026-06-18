#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

"$SCRIPT_DIR/refresh.sh" "$@"
exec node "$ROOT_DIR/scripts/upload_cf_cookies.mjs"
