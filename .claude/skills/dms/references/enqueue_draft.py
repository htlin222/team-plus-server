#!/usr/bin/env python3
"""Queue a draft 1:1 reply for the user to approve in Telegram.

Writes one JSON line to state/commands.jsonl; the daemon tails it,
DMs the user via Telegram with Approve / Edit / Cancel buttons.

Usage:
  python3 references/enqueue_draft.py --mobile 729 --text "明天下午 2-3 點我有空"
  python3 references/enqueue_draft.py --mobile 729 --name "吳美緻" --text "..."
"""
from __future__ import annotations

import argparse
import sys

import teamplus as tp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mobile", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--name", default="", help="Sender display name (optional).")
    ap.add_argument("--source-msg-id", default=None)
    args = ap.parse_args()

    if tp.is_ignored(args.mobile):
        print(f"✗ {args.mobile} is on the ignore list. "
              f"Run: python3 references/ignore.py remove {args.mobile}", file=sys.stderr)
        return 2

    chat_id = f"{args.mobile}_{tp.my_id()}"
    line = {
        "type": "enqueue_draft",
        "chatId": chat_id,
        "channelType": 0,
        "recipientMobile": args.mobile,
        "senderName": args.name or args.mobile,
        "sourceMsgId": args.source_msg_id,
        "text": args.text,
    }
    tp.append_command(line)
    print(f"✓ queued draft → {args.name or args.mobile} ({chat_id})")
    print("  daemon will DM you in Telegram for approval.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
