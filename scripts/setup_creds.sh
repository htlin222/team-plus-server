#!/bin/bash
# Interactively collect TeamPlus credentials and store them in .env.
#
# After running, .env will contain:
#   TEAMPLUS_ACCOUNT=<your login id>
#   TEAMPLUS_PASSWORD=<your password>
#
# .env is chmod 600 and listed in .gitignore.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"

if [ -t 0 ] && [ -t 1 ]; then
  :
else
  echo "setup_creds.sh must be run interactively in a TTY." >&2
  exit 1
fi

echo "TeamPlus credentials (will be stored in $ENV_FILE, mode 0600)"
if [ -f "$ENV_FILE" ]; then
  echo "  ⚠ $ENV_FILE already exists — values will be overwritten."
fi

read -r -p "  TeamPlus account (login id): " ACCOUNT
if [ -z "$ACCOUNT" ]; then
  echo "  ✗ account cannot be empty" >&2
  exit 1
fi

# -s = silent (no echo)
read -r -s -p "  TeamPlus password: " PASSWORD
echo
if [ -z "$PASSWORD" ]; then
  echo "  ✗ password cannot be empty" >&2
  exit 1
fi

read -r -s -p "  Confirm password: " PASSWORD_CONFIRM
echo
if [ "$PASSWORD" != "$PASSWORD_CONFIRM" ]; then
  echo "  ✗ passwords do not match" >&2
  exit 1
fi

umask 077
cat > "$ENV_FILE" <<EOF
# TeamPlus login credentials, used by scripts/refresh_cookies.py.
# Do not commit. .env is in .gitignore.
TEAMPLUS_ACCOUNT=$ACCOUNT
TEAMPLUS_PASSWORD=$PASSWORD
EOF
chmod 600 "$ENV_FILE"

echo
echo "✓ Wrote $ENV_FILE"
echo "  Next: ./scripts/refresh.sh   (or ./run.sh, which calls refresh.sh on demand)"
