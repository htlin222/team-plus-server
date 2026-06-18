#!/usr/bin/env python3
"""Bypass the approval flow and send a 1:1 message directly.

Reserved for explicit user instructions like "just send: ...". Prefer
enqueue_draft.py in normal flow.

Usage:
  python3 references/send_now.py --mobile 28 --text "OK 收到"
"""
from __future__ import annotations

import argparse
import sys

import teamplus as tp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mobile", required=True)
    ap.add_argument("--text", required=True)
    args = ap.parse_args()

    if tp.is_ignored(args.mobile):
        print(f"✗ {args.mobile} is on the ignore list — refusing to send.", file=sys.stderr)
        return 2

    chat_id = f"{args.mobile}_{tp.my_id()}"
    tp.append_command({
        "type": "send_teamplus",
        "chatId": chat_id,
        "channelType": 0,
        "recipientMobile": args.mobile,
        "text": args.text,
    })
    print(f"✓ direct-send queued → {chat_id} (daemon will deliver)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
