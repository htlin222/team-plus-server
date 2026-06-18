#!/usr/bin/env python3
"""Manage the DM ignore list — people whose messages list_dms.py hides
and which enqueue_draft / send_now refuse to target.

Stored at state/dm_ignore.json.

Usage:
  python3 references/ignore.py list
  python3 references/ignore.py add 1812 "system bot — irrelevant pages"
  python3 references/ignore.py add 1812 --name "住院病人資訊" "system bot"
  python3 references/ignore.py remove 1812
"""
from __future__ import annotations

import argparse
import sys
import time

import teamplus as tp


def cmd_list(_args) -> int:
    table = tp.load_ignore()
    if not table:
        print("(ignore list is empty)")
        return 0
    print(f"{'mobile':<8}  {'name':<14}  reason")
    print("-" * 60)
    for entry in sorted(table.values(), key=lambda e: str(e.get("userNo"))):
        print(f"{str(entry.get('userNo','')):<8}  "
              f"{(entry.get('name') or '?'):<14}  "
              f"{entry.get('reason') or ''}")
    return 0


def cmd_add(args) -> int:
    table = tp.load_ignore()
    table[str(args.mobile)] = {
        "userNo": args.mobile,
        "name": args.name or table.get(str(args.mobile), {}).get("name", ""),
        "reason": args.reason or "",
        "addedAt": int(time.time()),
    }
    tp.save_ignore(table)
    print(f"✓ ignoring {args.mobile} ({args.name or '?'})")
    return 0


def cmd_remove(args) -> int:
    table = tp.load_ignore()
    if str(args.mobile) not in table:
        print(f"(not on the list: {args.mobile})")
        return 0
    table.pop(str(args.mobile))
    tp.save_ignore(table)
    print(f"✓ removed {args.mobile}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list").set_defaults(func=cmd_list)

    a = sub.add_parser("add")
    a.add_argument("mobile")
    a.add_argument("reason", nargs="?", default="")
    a.add_argument("--name", default="")
    a.set_defaults(func=cmd_add)

    r = sub.add_parser("remove")
    r.add_argument("mobile")
    r.set_defaults(func=cmd_remove)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
