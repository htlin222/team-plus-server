#!/bin/bash
# Interactively configure the Telegram bot side and write .telegram.json.
#
# Bot is locked to a single user: only that chat_id is allowed to issue
# commands or receive forwarded TeamPlus messages. Default = 1212454889;
# override with: ./scripts/setup_telegram.sh <chat_id>.
#
# Steps:
#   1. Prompt for the bot token (hidden) and validate it via Telegram getMe.
#   2. Write .telegram.json with the locked chat_id (chmod 600).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TG_FILE="$ROOT_DIR/.telegram.json"

DEFAULT_CHAT_ID="1212454889"
CHAT_ID="${1:-$DEFAULT_CHAT_ID}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 required (used to parse Telegram JSON responses)" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl required" >&2
  exit 1
fi
if ! { [ -t 0 ] && [ -t 1 ]; }; then
  echo "setup_telegram.sh must be run interactively in a TTY." >&2
  exit 1
fi

echo "Telegram bot setup (writes $TG_FILE, mode 0600)"
echo "  Locked chat_id: $CHAT_ID"
if [ -f "$TG_FILE" ]; then
  echo "  ⚠ $TG_FILE already exists — value will be overwritten."
fi

read -r -s -p "  Bot token (from @BotFather): " TOKEN
echo
if [ -z "$TOKEN" ]; then
  echo "  ✗ token cannot be empty" >&2
  exit 1
fi

echo "  → Validating token via getMe..."
INFO=$(curl -fsS -m 10 "https://api.telegram.org/bot${TOKEN}/getMe" || true)
USERNAME=$(printf '%s' "$INFO" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get('ok') and 'result' in d:
    print(d['result'].get('username') or '')
")
if [ -z "$USERNAME" ]; then
  echo "  ✗ Telegram rejected the token. Response:" >&2
  echo "    $INFO" >&2
  exit 1
fi
echo "  ✓ Bot: @$USERNAME"

umask 077
python3 - "$TOKEN" "$CHAT_ID" "$TG_FILE" <<'PY'
import json, sys
token, chat_id, path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'w') as f:
    json.dump({"token": token, "chat_id": str(chat_id)}, f, indent=2)
    f.write('\n')
PY
chmod 600 "$TG_FILE"

echo
echo "✓ Wrote $TG_FILE  (bot: @$USERNAME, chat_id: $CHAT_ID)"
echo "  → Open Telegram and send /start to @$USERNAME so it can DM you."
echo "  Next: ./run.sh"
