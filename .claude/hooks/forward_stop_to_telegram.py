#!/usr/bin/env python3
"""Stop hook: relay the assistant's last text reply back to the Telegram DM
that started this session, when the most recent user turn carries a
`<channel source="bridge"` or `source="teamplus-action"` wrapper.

The daemon (channel/server.ts) only knows how to forward TeamPlus messages.
Plain assistant chatter has no path back to Telegram unless something
reads the transcript and posts it. This hook is that something.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

# Resolve repo root from the env var Claude Code sets for hooks, falling back to
# this file's location (.claude/hooks/<file> → three levels up).
ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
TG_CONFIG = os.path.join(ROOT, ".telegram.json")
STATE_DIR = os.path.join(ROOT, "state")
SENT_MARK_DIR = os.path.join(STATE_DIR, "tg_sent")


def extract_text(content):
    if isinstance(content, list):
        parts = []
        for p in content:
            if not isinstance(p, dict):
                continue
            if p.get("type") == "text" and p.get("text"):
                parts.append(p["text"])
        return "\n".join(parts).strip()
    return str(content or "").strip()


def is_tool_turn(content):
    """True when this user/assistant entry is a tool_use or tool_result rather
    than a real text message. Tool results are stored with role=user, which
    would otherwise clobber the original prompt when we scan for source tags.
    """
    if not isinstance(content, list):
        return False
    for p in content:
        if isinstance(p, dict) and p.get("type") in ("tool_result", "tool_use"):
            return True
    return False


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    transcript = payload.get("transcript_path")
    if not transcript or not os.path.exists(transcript):
        return 0

    session_is_bridge = False
    last_assistant_text = ""
    last_assistant_uuid = ""
    try:
        with open(transcript, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                role = entry.get("type") or entry.get("role")
                msg = entry.get("message") or {}
                content = msg.get("content") if isinstance(msg, dict) else None
                if content is None and "content" in entry:
                    content = entry["content"]
                if role == "user":
                    if is_tool_turn(content):
                        continue
                    text = extract_text(content)
                    if text and (
                        'source="bridge"' in text
                        or 'source="teamplus-action"' in text
                    ):
                        session_is_bridge = True
                elif role == "assistant":
                    if is_tool_turn(content):
                        continue
                    text = extract_text(content)
                    if text:
                        last_assistant_text = text
                        last_assistant_uuid = entry.get("uuid") or entry.get("id") or ""
    except Exception:
        return 0

    if not session_is_bridge or not last_assistant_text:
        return 0

    if last_assistant_uuid:
        os.makedirs(SENT_MARK_DIR, exist_ok=True)
        mark = os.path.join(SENT_MARK_DIR, f"{last_assistant_uuid}.sent")
        if os.path.exists(mark):
            return 0

    try:
        with open(TG_CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
        token = cfg["token"]
        chat = cfg["chat_id"]
    except Exception as e:
        sys.stderr.write(f"forward_stop: cannot load .telegram.json: {e}\n")
        return 0

    body = last_assistant_text
    if len(body) > 4000:
        body = body[:3990] + "…"
    data = urllib.parse.urlencode({"chat_id": chat, "text": body}).encode()
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        urllib.request.urlopen(url, data=data, timeout=10).read()
    except Exception as e:
        sys.stderr.write(f"forward_stop: telegram send failed: {e}\n")
        return 0

    if last_assistant_uuid:
        try:
            with open(mark, "w") as f:
                f.write("")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
