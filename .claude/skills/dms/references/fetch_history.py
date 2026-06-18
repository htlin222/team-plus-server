#!/usr/bin/env python3
"""Fetch recent messages with one DM peer or one group.

Usage:
  # DM
  python3 references/fetch_history.py --mobile 728 [--count 25] [--json]

  # Group
  python3 references/fetch_history.py --chat-id afcf8a37-... [--count 25] [--json]
"""
from __future__ import annotations

import argparse
import json
import sys

import teamplus as tp


def fetch_dm(mobile: str, count: int) -> list[dict]:
    chat_id = f"{mobile}_{tp.my_id()}"
    body = (
        f"action=getInitialMessageList&ChannelType=0&Mobile={mobile}"
        f"&ChatID={chat_id}&LoadCount={count}"
    )
    data = tp.post(body)
    return list(data.get("ChatMessageList") or [])


def fetch_group(chat_id: str, count: int) -> list[dict]:
    body = (
        f"action=getInitialMessageList&ChannelType=1"
        f"&ChatID={chat_id}&LoadCount={count}"
    )
    data = tp.post(body)
    return list(data.get("ChatMessageList") or [])


def main() -> int:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--mobile", help="Peer's UserNo (e.g. 728) for a DM.")
    src.add_argument("--chat-id", dest="chat_id", help="Group ChatID (UUID).")
    ap.add_argument("--count", type=int, default=25)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.mobile:
        msgs = fetch_dm(args.mobile, args.count)
    else:
        msgs = fetch_group(args.chat_id, args.count)
    msgs.sort(key=lambda m: m.get("MessageSN", 0))  # oldest → newest

    if args.json:
        print(json.dumps(msgs, ensure_ascii=False, indent=2))
        return 0

    if not msgs:
        print("(no messages — wrong key? cookies expired?)")
        return 1

    me = tp.my_id()
    is_group = bool(args.chat_id)
    for m in msgs:
        sender = m.get("SenderID")
        arrow = "you →" if sender == me else "→ you"
        when = (m.get("CreateTime") or "")[:19].replace("T", " ")
        text = (m.get("MsgContent") or "").replace("\n", " ⏎ ")[:200]
        read = "✓" if m.get("HasRead") else " "
        if is_group and sender != me:
            who = m.get("SenderUserName") or m.get("UserName") or str(sender)
            print(f"{when}  {arrow}  {read}  [{who}] {text}")
        else:
            print(f"{when}  {arrow}  {read}  {text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
