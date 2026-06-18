#!/bin/bash
# Refresh TeamPlus cookies via patchright auto-login.
#
# Bootstraps .venv (creates if missing, installs patchright + Chromium),
# then invokes scripts/refresh_cookies.py with the credentials in .env.
#
# Usage:
#   ./scripts/refresh.sh                # headless
#   ./scripts/refresh.sh --headful      # show browser window
#   ./scripts/refresh.sh --attempts 5   # captcha retry count

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VENV="$ROOT_DIR/.venv"
PY="$VENV/bin/python"

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "Missing .env. Run: ./scripts/setup_creds.sh" >&2
  exit 1
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "tesseract not found. Install via: brew install tesseract" >&2
  exit 4
fi

if [ ! -x "$PY" ]; then
  echo "→ Creating .venv at $VENV"
  python3 -m venv "$VENV"
fi

# Marker file lets us skip re-install on every run.
INSTALL_MARKER="$VENV/.patchright_installed"
if [ ! -f "$INSTALL_MARKER" ]; then
  echo "→ Installing patchright + websockets into .venv"
  "$VENV/bin/pip" install --upgrade pip --quiet
  "$VENV/bin/pip" install --quiet patchright websockets
  echo "→ Installing Chromium for patchright (one-time)"
  "$VENV/bin/patchright" install chromium
  : > "$INSTALL_MARKER"
fi

exec "$PY" "$SCRIPT_DIR/refresh_cookies.py" "$@"
