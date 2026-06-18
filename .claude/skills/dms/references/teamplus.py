"""Shared helpers for the dms skill — cookies, REST POSTs, my_id, ignore list."""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3].parent  # → repo root
COOKIES_FILE = ROOT / "cookies.json"
CONFIG_FILE = ROOT / ".config.json"
STATE_DIR = ROOT / "state"
COMMANDS_FILE = STATE_DIR / "commands.jsonl"
IGNORE_FILE = STATE_DIR / "dm_ignore.json"


def _teamplus_base() -> str:
    """TeamPlus base URL (origin, no trailing slash) from env or .env."""
    base = os.environ.get("TEAMPLUS_BASE", "")
    if not base:
        env_file = ROOT / ".env"
        if env_file.exists():
            for raw in env_file.read_text().splitlines():
                line = raw.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == "TEAMPLUS_BASE":
                    base = val.strip()
    return base.rstrip("/")


BASE = _teamplus_base()
TEAMPLUS_HOST = BASE.split("://", 1)[-1].split("/", 1)[0]
ENDPOINT = f"{BASE}/EIM/Chat/ChatMainHandler.ashx"


def cookie_header() -> str:
    cookies = json.loads(COOKIES_FILE.read_text())
    return "; ".join(
        f"{c['name']}={c['value']}"
        for c in cookies
        if c.get("domain", "").endswith(TEAMPLUS_HOST)
    )


def my_id() -> int:
    return int(json.loads(CONFIG_FILE.read_text())["my_id"])


def post(body: str | bytes) -> dict[str, Any]:
    if isinstance(body, str):
        body = body.encode()
    req = urllib.request.Request(
        ENDPOINT,
        method="POST",
        data=body,
        headers={
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            "cookie": cookie_header(),
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


# ----- ignore list ------------------------------------------------------

def load_ignore() -> dict[str, dict]:
    """Return {userNo(str): {"name":..., "reason":..., "addedAt":...}}."""
    if not IGNORE_FILE.exists():
        return {}
    raw = json.loads(IGNORE_FILE.read_text())
    # {"ignored": [...]} or already-keyed map; normalize either way.
    if isinstance(raw, dict) and "ignored" in raw:
        return {str(e["userNo"]): e for e in raw["ignored"]}
    return {str(k): v for k, v in raw.items()} if isinstance(raw, dict) else {}


def save_ignore(table: dict[str, dict]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"ignored": list(table.values())}
    IGNORE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2))


def is_ignored(user_no: str | int, table: dict[str, dict] | None = None) -> bool:
    table = table if table is not None else load_ignore()
    return str(user_no) in table


# ----- command queue (consumed by the daemon) ---------------------------

def append_command(line: dict[str, Any]) -> None:
    """Daemon tails state/commands.jsonl and acts on each line."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with COMMANDS_FILE.open("a") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")
