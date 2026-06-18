#!/usr/bin/env python3
"""List the most recent TeamPlus conversations (DMs + groups by default).

Usage:
  python3 references/list_dms.py [--count N] [--scope dm|group|all]
                                 [--include-ignored] [--json]

Output (default): aligned table with #, type, unread, name, key, direction,
time, snippet. The "key" column is the canonical handle for the next step:
  * DM   → mobile (UserNo). Pass to fetch_history.py --mobile / enqueue_draft.
  * group→ ChatID (UUID).   Pass to fetch_history.py --chat-id.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

import teamplus as tp


def fetch_inbox(target: int, scope: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    compare_sn = 0
    pages = 0
    while pages < 8 and len(out) < target:
        body = (
            f"action=loadPersonalLogListForMessenger"
            f"&loadCount=50&compareSN={compare_sn}&searchKey="
        )
        data = tp.post(body)
        page = data.get("AppMessageLogList") or []
        if not page:
            break
        for r in page:
            ct = r.get("ChannelType")
            if scope == "dm" and ct != 0:
                continue
            if scope == "group" and ct == 0:
                continue
            out.append(r)
        if not data.get("HasMore"):
            break
        compare_sn = data.get("LastSN") or page[-1].get("SN", 0)
        pages += 1
        time.sleep(0.15)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=15)
    ap.add_argument(
        "--scope",
        choices=("dm", "group", "all"),
        default="all",
        help="What to include (default: all = DMs + groups).",
    )
    ap.add_argument("--include-ignored", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    ignore = tp.load_ignore()
    raw = fetch_inbox(target=args.count + len(ignore) + 5, scope=args.scope)

    rows: list[dict[str, Any]] = []
    for r in raw:
        ct = r.get("ChannelType")
        is_dm = ct == 0
        mobile = str(r.get("Mobile", ""))
        chat_id = r.get("ChatID", "") or ""
        # Ignore list applies to DMs (keyed by UserNo == mobile) only —
        # groups have no per-group ignore support yet.
        if is_dm and not args.include_ignored and tp.is_ignored(mobile, ignore):
            continue
        rows.append(
            {
                "type": "dm" if is_dm else "group",
                "name": r.get("AllUserName") or r.get("UserName") or "?",
                "mobile": mobile if is_dm else "",
                "chatId": chat_id,
                "key": mobile if is_dm else chat_id,
                "direction": "in" if r.get("InOut") == 0 else "out",
                "unread": int(r.get("UnreadCount") or 0),
                "time": r.get("TimeDesc") or r.get("CreateTime", ""),
                "snippet": (r.get("MsgContent") or "").replace("\n", " ")[:80],
                "messageSN": r.get("MessageSN"),
            }
        )
        if len(rows) >= args.count:
            break

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    if not rows:
        print("(no conversations — daemon down? cookies expired? everyone ignored?)")
        return 0

    print(
        f"{'#':>2}  {'t':<2}  {'unread':<6}  {'name':<14}  {'key':<10}  "
        f"dir   when        message"
    )
    print("-" * 110)
    for i, r in enumerate(rows, 1):
        badge = f"[{r['unread']}]" if r["unread"] else "   "
        arrow = "→ you" if r["direction"] == "in" else "you →"
        kind = "DM" if r["type"] == "dm" else "G"
        # group ChatIDs are UUIDs — show only the leading 8 chars
        key_disp = r["key"] if r["type"] == "dm" else r["key"][:8]
        print(
            f"{i:>2}  {kind:<2}  {badge:<6}  {r['name']:<14}  {key_disp:<10}  "
            f"{arrow}  {r['time']:<10}  «{r['snippet']}»"
        )
    if ignore and not args.include_ignored:
        print(
            f"\n(filtered out {len(ignore)} ignored DMs — pass --include-ignored "
            "to see them; groups have no ignore yet)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
