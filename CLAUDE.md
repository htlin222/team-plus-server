# team-plus-server

## Telegram bridge replies (always)

When a user message arrives wrapped in `<channel source="bridge" …>` (or
`source="teamplus-action"`), the daemon forwards your reply text back to
that Telegram DM. **Always end the turn with a user-facing reply** — even
for trivial confirmations, errors, or "nothing found" results. Silence on
your side = silence in Telegram, and the user has no other window into
this session.

Rules:
- Reply in the same language the user wrote in (default: zh-TW).
- Don't re-acknowledge "收到" — the daemon already showed it.
- Keep it short. One or two sentences, or a tight list.
- If a tool fails, say so in the reply; don't just stop.
