#!/usr/bin/env python3
"""TeamPlus WebSocket monitor — real-time message notifications.

Usage:
    .venv/bin/python scripts/watch.py              # watch & notify
    .venv/bin/python scripts/watch.py --verbose     # show all WS events
    .venv/bin/python scripts/watch.py --no-notify   # print only, no macOS notification
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import signal
import time

import websockets

# ── Config ──────────────────────────────────────────────────────────

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
COOKIES_JSON = os.path.join(ROOT_DIR, "cookies.json")
PROFILE_MD = os.path.join(ROOT_DIR, "memory", "relationship_profile.md")

def _teamplus_base() -> str:
    """TeamPlus base URL (origin, no trailing slash) from env or .env."""
    base = os.environ.get("TEAMPLUS_BASE", "")
    if not base:
        env_file = os.path.join(ROOT_DIR, ".env")
        if os.path.exists(env_file):
            for raw in open(env_file):
                line = raw.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == "TEAMPLUS_BASE":
                    base = val.strip()
    base = base.rstrip("/")
    if not base:
        raise SystemExit("TEAMPLUS_BASE not set — set it in .env (copy .env.example)")
    return base


TEAMPLUS_BASE = _teamplus_base()
TEAMPLUS_HOST = TEAMPLUS_BASE.split("://", 1)[-1].split("/", 1)[0]
WS_URL = TEAMPLUS_BASE.replace("http://", "ws://").replace("https://", "wss://") + "/AppService/WSService.ashx"
TOKEN_URL = TEAMPLUS_BASE + "/AppService/WSService.ashx"

PING_INTERVAL = 30  # seconds
RECONNECT_DELAY = 5  # seconds
SNAPSHOT_COOLDOWN = 60  # seconds — don't snapshot more than once per minute
ANALYZE_SCRIPT = os.path.join(SCRIPT_DIR, "analyze_snapshot.py")
VENV_PYTHON = os.path.join(ROOT_DIR, ".venv", "bin", "python")

# ── Parse config ────────────────────────────────────────────────────

def load_cookies():
    with open(COOKIES_JSON) as f:
        cookies = json.load(f)
    jar = {}
    for c in cookies:
        if c.get("domain") == TEAMPLUS_HOST:
            jar[c["name"]] = c["value"]
    return jar


def load_profile():
    with open(PROFILE_MD) as f:
        text = f.read()

    def extract(section_name, pattern):
        section = re.search(
            rf"## {section_name}(.*?)(?=^## )", text, re.S | re.M
        )
        if not section:
            return ""
        m = re.search(pattern, section.group(1))
        return m.group(1).strip() if m else ""

    return {
        "my_id": int(extract("我的設定", r"\*\*UserID\*\*\s*[:：]\s*(\d+)")),
        "target_name": extract("她的設定", r"\*\*姓名\*\*\s*[:：]\s*(\S+)"),
        "chat_id": extract("她的設定", r"\*\*ChatID\*\*\s*[:：]\s*(\S+)"),
    }


# ── Token ───────────────────────────────────────────────────────────

def get_token(cookies):
    """Get WebSocket auth token via HTTP POST."""
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
    result = subprocess.run(
        [
            "curl", "-s", "-X", "POST", TOKEN_URL,
            "-H", "content-type: application/x-www-form-urlencoded; charset=UTF-8",
            "-H", "x-requested-with: XMLHttpRequest",
            "-b", cookie_str,
            "-d", "Ask=getToken",
        ],
        capture_output=True, text=True,
    )
    data = json.loads(result.stdout)
    if not data.get("IsSuccess", False) and not data.get("Data"):
        raise RuntimeError(f"Failed to get token: {data}")
    return data["Data"]


# ── macOS notification ──────────────────────────────────────────────

def notify(title, body):
    """Send macOS notification."""
    script = (
        f'display notification "{body}" '
        f'with title "{title}" '
        f'sound name "Glass"'
    )
    subprocess.run(["osascript", "-e", script], capture_output=True)


# ── Message handler ─────────────────────────────────────────────────

def handle_message(event_data, profile, *, verbose=False, do_notify=True):
    """Process incoming WebSocket event. Returns True if it was a chat message."""
    try:
        msg = json.loads(event_data)
    except json.JSONDecodeError:
        if verbose:
            print(f"  [raw] {event_data}", flush=True)
        return False

    event = msg.get("Event", msg.get("Ask", ""))

    if event == "PONG":
        return False

    if verbose:
        ts = time.strftime("%H:%M:%S")
        preview = json.dumps(msg, ensure_ascii=False)
        if len(preview) > 300:
            preview = preview[:300] + "…"
        print(f"  [{ts}] {preview}", flush=True)

    # IM_CHAT:NEW_MESSAGE is the chat message event
    if event != "IM_CHAT:NEW_MESSAGE":
        return False

    data = msg.get("Data", {})
    if not isinstance(data, dict):
        return False

    sender_id = data.get("SenderID")
    chat_id = data.get("ChatID", "")
    content = data.get("Content", "")
    msg_type = data.get("MsgType", 0)

    try:
        sender_id = int(sender_id)
    except (ValueError, TypeError):
        return False

    # Skip own messages
    if sender_id == profile["my_id"]:
        return False

    # Determine display content
    if msg_type == 1:
        display = content
    elif msg_type == 202:
        display = "[貼圖]"
    else:
        display = f"[type={msg_type}] {content}" if content else f"[type={msg_type}]"

    if len(display) > 80:
        display = display[:80] + "…"

    # Check if this is from the target chat
    is_target = chat_id == profile["chat_id"]
    sender_name = profile["target_name"] if is_target else f"[{chat_id}]"

    ts = time.strftime("%H:%M:%S")
    marker = "💬" if is_target else "📩"
    print(f"\n  {marker} [{ts}] {sender_name}: {display}", flush=True)

    if do_notify:
        if is_target:
            notify(f"💬 {sender_name}", display or "[新訊息]")
        else:
            notify("📩 TeamPlus", display or "[新訊息]")

    # Auto-snapshot for target messages
    if is_target:
        _maybe_snapshot()

    return is_target


_last_snapshot_time = 0


def _maybe_snapshot():
    """Run analyze_snapshot.py with cooldown to avoid spamming."""
    global _last_snapshot_time
    now = time.time()
    if now - _last_snapshot_time < SNAPSHOT_COOLDOWN:
        return
    _last_snapshot_time = now

    try:
        print(f"  📸 Generating snapshot…", flush=True)
        result = subprocess.run(
            [VENV_PYTHON, ANALYZE_SCRIPT, "30"],
            capture_output=True, text=True, timeout=30,
        )
        if result.stdout:
            for line in result.stdout.strip().split("\n"):
                print(line, flush=True)
        if result.returncode != 0 and result.stderr:
            print(f"  ✗ Snapshot error: {result.stderr.strip()}", flush=True)
    except Exception as e:
        print(f"  ✗ Snapshot failed: {e}", flush=True)


# ── WebSocket loop ──────────────────────────────────────────────────

async def ws_loop(cookies, profile, *, verbose=False, do_notify=True):
    token = get_token(cookies)
    print(f"  ✓ Token acquired", flush=True)

    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
    extra_headers = {"Cookie": cookie_str}

    async with websockets.connect(
        WS_URL,
        additional_headers=extra_headers,
        ping_interval=None,  # we handle pings ourselves
    ) as ws:
        # Authenticate
        auth_msg = json.dumps({"Ask": "CORE:AUTH", "Data": token})
        await ws.send(auth_msg)
        print(f"  ✓ Auth sent", flush=True)

        # Wait for auth response
        resp = await asyncio.wait_for(ws.recv(), timeout=10)
        resp_data = json.loads(resp)
        if verbose:
            print(f"  Auth response: {json.dumps(resp_data, ensure_ascii=False)}", flush=True)

        # Auth success is indicated by receiving any event (e.g. WIDGET:UPDATE)
        # rather than an explicit CORE:AUTH_RESPONSE
        event_type = resp_data.get("Event", "")
        auth_ok = bool(event_type)  # any event = connection alive & authenticated

        if not auth_ok:
            print(f"  ✗ Auth failed: {resp_data}", flush=True)
            return False

        # Process this first message too
        handle_message(resp, profile, verbose=verbose, do_notify=do_notify)

        print(f"  ✓ Authenticated — listening for messages…", flush=True)
        print(f"  (Ctrl+C to stop)\n", flush=True)

        if do_notify:
            notify("TeamPlus Watch", "已連線，監控中…")

        # Ping task
        async def pinger():
            while True:
                await asyncio.sleep(PING_INTERVAL)
                try:
                    await ws.send(json.dumps({"Ask": "PING"}))
                except Exception:
                    break

        ping_task = asyncio.create_task(pinger())

        try:
            async for message in ws:
                handle_message(
                    message, profile,
                    verbose=verbose, do_notify=do_notify,
                )
        finally:
            ping_task.cancel()

    return True


# ── Main ────────────────────────────────────────────────────────────

async def main():
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    do_notify = "--no-notify" not in sys.argv

    cookies = load_cookies()
    profile = load_profile()

    print(f"\n  ♥ TeamPlus Watch", flush=True)
    print(f"  Target: {profile['target_name']}", flush=True)
    print(f"  Chat: {profile['chat_id']}", flush=True)
    print(f"  Mode: {'verbose' if verbose else 'normal'}, "
          f"notify={'on' if do_notify else 'off'}\n", flush=True)

    while True:
        try:
            await ws_loop(cookies, profile, verbose=verbose, do_notify=do_notify)
        except websockets.exceptions.ConnectionClosed as e:
            print(f"\n  ⚠ Connection closed: {e}. Reconnecting in {RECONNECT_DELAY}s…",
                  flush=True)
        except asyncio.TimeoutError:
            print(f"\n  ⚠ Timeout. Reconnecting in {RECONNECT_DELAY}s…", flush=True)
        except Exception as e:
            print(f"\n  ✗ Error: {e}. Reconnecting in {RECONNECT_DELAY}s…", flush=True)

        await asyncio.sleep(RECONNECT_DELAY)
        # Reload cookies in case they were updated
        try:
            cookies = load_cookies()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  Stopped.", flush=True)
