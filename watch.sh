#!/bin/bash
# TeamPlus real-time message watcher
# Usage:
#   ./scripts/watch.sh              # watch & notify
#   ./scripts/watch.sh --verbose    # show all WS events (useful for debugging)
#   ./scripts/watch.sh --no-notify  # print only, no macOS notification

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Ensure venv exists
if [ ! -d "$ROOT_DIR/.venv" ]; then
  echo "Creating venv..."
  python3 -m venv "$ROOT_DIR/.venv"
  "$ROOT_DIR/.venv/bin/pip" install -q websockets
fi

# Check websockets installed
"$ROOT_DIR/.venv/bin/python" -c "import websockets" 2>/dev/null || \
  "$ROOT_DIR/.venv/bin/pip" install -q websockets

exec "$ROOT_DIR/.venv/bin/python" "$SCRIPT_DIR/watch.py" "$@"
