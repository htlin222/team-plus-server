#!/bin/bash
# TeamPlus → Telegram bridge daemon launcher.
#
# Long-running: connects to TeamPlus WebSocket, forwards every inbound
# message to the Telegram bot DM defined in .telegram.json, and serves a
# command menu (/unread, /chats, /ping, /help) for on-demand catch-up.
#
# Required files (alongside this script):
#   .env             — TEAMPLUS_ACCOUNT / TEAMPLUS_PASSWORD
#                      (created by ./scripts/setup_creds.sh)
#   .telegram.json   — { "token": "...", "chat_id": "..." }
#   cookies.json     — generated automatically by scripts/refresh.sh
#                      using credentials from .env
#   .config.json     — { "my_id": <int> }; auto-populated from TSSID JWT
#                      after first successful refresh
#
# Usage:
#   ./run.sh                       # foreground
#   nohup ./run.sh >> server.log & # background

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNEL_DIR="$SCRIPT_DIR/channel"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found. Install via: brew install oven-sh/bun/bun" >&2
  exit 1
fi

if [ ! -d "$CHANNEL_DIR/node_modules" ]; then
  echo "Installing channel/ dependencies..."
  (cd "$CHANNEL_DIR" && bun install)
fi

# Telegram config is required and must be set up by hand.
if [ ! -f "$SCRIPT_DIR/.telegram.json" ]; then
  echo "Missing .telegram.json — create it with:" >&2
  echo "  { \"token\": \"<bot-token>\", \"chat_id\": \"<your-tg-chat-id>\" }" >&2
  exit 1
fi

# Credentials live in .env — set them up via the interactive prompt.
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "Missing .env — run: ./scripts/setup_creds.sh" >&2
  exit 1
fi

# cookies.json is regenerated on demand from .env via patchright.
if [ ! -f "$SCRIPT_DIR/cookies.json" ]; then
  echo "→ cookies.json missing; running ./scripts/refresh.sh"
  "$SCRIPT_DIR/scripts/refresh.sh"
fi

# .config.json is populated by refresh_cookies.py from the TSSID JWT, so it
# should exist by the time we get here. Bail with a clear message otherwise.
if [ ! -f "$SCRIPT_DIR/.config.json" ]; then
  echo "Missing .config.json — re-run: ./scripts/refresh.sh" >&2
  exit 1
fi

exec bun "$CHANNEL_DIR/server.ts"
