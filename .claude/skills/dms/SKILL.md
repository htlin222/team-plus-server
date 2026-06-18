---
name: dms
description: Triage TeamPlus inbox — 1-on-1 DMs *and* group chats. Use when the user wants to fetch the latest personal messages, scan group activity, read history with one peer or one group, draft a reply for approval, send directly, or manage an ignore list. Trigger phrases include "DMs", "messages", "群組", "回覆", "draft a reply to <name>", "ignore <name>", "TeamPlus".
---

# dms — fetch, plan, draft, send TeamPlus messages

Five small Python scripts under `references/`, each runnable by hand with
`python3 .claude/skills/dms/references/<script>.py …`. Cookies & `my_id`
come from the project root (`cookies.json`, `.config.json`); state writes go
to `state/` (consumed by the launchd daemon, label `LAUNCH_LABEL` in the Makefile).

## Workflow

```
list_dms.py          ───────────► what's recent (DMs + groups by default)
        │
        ▼ pick a peer (mobile) or a group (chat-id)
fetch_history.py     ───────────► what they actually said (chronological)
        │
        ▼ compose a reply
enqueue_draft.py     ───────────► daemon DMs you in Telegram → tap Approve
                                   (preferred path; DM peers only today)
        │
        ▼ rare: user said "just send"
send_now.py          ───────────► bypass approval, direct send (DM peers)
```

`ignore.py add/remove/list` controls which UserNos `list_dms.py` hides and
which `enqueue_draft` / `send_now` refuse to target. **DM only** — group
chats are always shown (no per-group ignore yet).

## Concrete examples

```bash
# Triage: what's new across DMs + groups (ignored DMs excluded)
python3 .claude/skills/dms/references/list_dms.py

# Just DMs:
python3 .claude/skills/dms/references/list_dms.py --scope dm

# Just groups:
python3 .claude/skills/dms/references/list_dms.py --scope group

# DM history with mobile=729:
python3 .claude/skills/dms/references/fetch_history.py --mobile 729 --count 30

# Group history (note the UUID-style ChatID from list_dms output):
python3 .claude/skills/dms/references/fetch_history.py \
  --chat-id afcf8a37-3a4a-489f-9b62-45f54e75c314 --count 30

# Draft a reply for approval (DM only):
python3 .claude/skills/dms/references/enqueue_draft.py \
  --mobile 729 --name "吳美緻" \
  --text "明天下午 2-3 點我有空，方便嗎？"

# Stop seeing a noisy system DM:
python3 .claude/skills/dms/references/ignore.py add 1812 \
  --name "住院病人資訊" "system bot, no human on the other side"

# Re-include later:
python3 .claude/skills/dms/references/ignore.py remove 1812
```

## Output contract for orchestration

`list_dms.py --json` prints rows tagged with `"type": "dm" | "group"` and
a `"key"` field that is the right handle to feed into the next step:

- `type=dm`    → `key` is the peer's mobile (= UserNo). Pass with `--mobile`.
- `type=group` → `key` is the group's ChatID (UUID). Pass with `--chat-id`.

Both `list_dms.py --json` and `fetch_history.py --json` emit JSON arrays
suitable for piping into another tool. Default human output is a fixed-
width table (`t` column: `DM` or `G`).

For DMs the chatId is always `"<mobile>_<my_id>"`; the helpers construct it
for you. For groups the ChatID is a server-issued UUID.

## Drafting rules (what to write)

- Match the peer's language. Most peers write Traditional Chinese; mirror
  that unless their last message is in another language.
- Keep replies 1-2 sentences. The user reviews the draft in Telegram and
  expects to approve in one tap.
- Reference what they actually asked. Pull a short quote from
  `fetch_history.py` rather than guessing.
- Never invent commitments (times, attendance, decisions). If the reply
  needs a fact you don't have, ask the user first instead of drafting.
- Put it through `enqueue_draft.py`, not `send_now.py`, unless the user
  explicitly says "just send" / "直接發".
- Group replies: not yet supported by `enqueue_draft.py` / `send_now.py`.
  If the user wants to reply in a group, ask them to do it manually for now,
  or extend the daemon's command queue first.

## Failure modes worth checking

- **Cookies expired** — `loadPersonalLogListForMessenger` returns
  `IsSessionTimeOut: true`. Run `make refresh` from the project root.
- **Daemon not running** — `enqueue_draft` writes the line but no Telegram
  approval arrives. Verify with `make status`; `make start` if needed.
- **Ignore list squelching real people** — pass `--include-ignored` to
  `list_dms.py` to audit; `ignore.py list` to read the table.
- **Missing groups** — `list_dms.py --scope group` should show them; if
  empty, cookies likely expired.

## Files this skill manipulates

| Path | Role |
|------|------|
| `cookies.json` (read) | TeamPlus session cookies for REST POSTs |
| `.config.json` (read) | `my_id` |
| `state/commands.jsonl` (append) | Daemon's command queue (drafts + direct sends) |
| `state/dm_ignore.json` (read/write) | Ignore list maintained by `ignore.py` (DMs only) |
