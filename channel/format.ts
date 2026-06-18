import type { ChatCursor, UnreadEntry } from './cursor.ts'

// Telegram sendMessage caps at 4096 chars. Use 3800 to leave headroom for
// emoji/CJK UTF-16 counting quirks.
export const TG_MAX_CHARS = 3800

export function chunkForTelegram(text: string, max = TG_MAX_CHARS): string[] {
  if (text.length <= max) return [text]

  const out: string[] = []
  let buf = ''
  const flush = () => {
    if (buf) {
      out.push(buf)
      buf = ''
    }
  }
  const appendUnit = (unit: string, sep: string) => {
    if (!buf) {
      buf = unit
    } else if ((buf + sep + unit).length > max) {
      flush()
      buf = unit
    } else {
      buf = buf + sep + unit
    }
  }

  for (const para of text.split(/\n\n+/)) {
    if (para.length <= max) {
      appendUnit(para, '\n\n')
      continue
    }
    flush()
    for (const line of para.split('\n')) {
      if (line.length <= max) {
        appendUnit(line, '\n')
        continue
      }
      flush()
      for (let i = 0; i < line.length; i += max) {
        out.push(line.slice(i, i + max))
      }
    }
  }
  flush()
  return out
}

export function describeMsgType(msgType: number, content: string): string {
  if (msgType === 1) return content
  if (msgType === 202) return '[貼圖]'
  if (msgType === 203) return '[圖片]'
  if (msgType === 204) return '[檔案]'
  return content ? `[type=${msgType}] ${content}` : `[type=${msgType}]`
}

function formatHHMM(ts: number): string {
  const d = new Date(ts * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function chatLabel(chatId: string, cursor: ChatCursor): string {
  return cursor.name ? `${cursor.name} (${chatId})` : chatId
}

/** Live-forward format: "💬 邱子玲 in 1234 [14:32] hi" */
export function formatLive(chatId: string, cursor: ChatCursor, entry: UnreadEntry): string {
  const chat = chatLabel(chatId, cursor)
  const time = formatHHMM(entry.ts)
  const sender = entry.senderName || `#${entry.senderId}`
  const body = describeMsgType(entry.msgType, entry.content)
  return `💬 ${sender} · ${chat}\n[${time}] ${body}`
}

/** /unread per-chat block. */
export function formatUnreadBlock(
  chatId: string,
  cursor: ChatCursor,
  drained: UnreadEntry[],
  spilled: number,
): string {
  const header = `📬 ${chatLabel(chatId, cursor)} (${drained.length}${spilled ? ` +${spilled} earlier` : ''})`
  const lines = drained.map(e => {
    const time = formatHHMM(e.ts)
    const sender = e.senderName || `#${e.senderId}`
    const body = describeMsgType(e.msgType, e.content)
    return `[${time}] ${sender}: ${body}`
  })
  return [header, ...lines].join('\n')
}

/** /chats list view. Single-line per chat, matches /action /latest_* shape. */
export function formatChatsList(
  chats: Array<{ chatId: string; cursor: ChatCursor }>,
): string {
  if (chats.length === 0) return 'No chats tracked yet.'
  const sorted = chats
    .slice()
    .sort((a, b) => b.cursor.unread.length - a.cursor.unread.length)
  const head = `📋 Tracked chats (${sorted.length})`
  const lines = sorted.map(({ chatId, cursor }, i) => {
    const u = cursor.unread.length
    const badge = u > 0 ? `[${u}] ` : ''
    const name = cursor.name ?? chatId
    // DM chatIds look like "1141_1049"; groups are 36-char UUIDs.
    const isGroup = chatId.includes('-')
    const kind = isGroup ? '🧑‍🤝‍🧑' : '💬'
    const key = isGroup ? chatId.slice(0, 8) : chatId
    return `${i + 1}. ${kind} ${badge}${name} (${key})`
  })
  return [head, ...lines].join('\n')
}

// ── Inline keyboards ────────────────────────────────────────────────

export type InlineButton = { text: string; callback_data: string }
export type InlineKeyboard = { inline_keyboard: InlineButton[][] }

/** Buttons attached under each forwarded TeamPlus message (when not muted). */
export function buildActionKeyboard(cbId: string): InlineKeyboard {
  return {
    inline_keyboard: [[
      { text: '📝 Remind', callback_data: `rm:${cbId}` },
      { text: '✏️ Draft', callback_data: `df:${cbId}` },
    ]],
  }
}

/** Buttons attached to a draft approval prompt. */
export function buildDraftKeyboard(draftId: string): InlineKeyboard {
  return {
    inline_keyboard: [[
      { text: '✅ Send', callback_data: `snd:${draftId}` },
      { text: '🗑 Cancel', callback_data: `cnc:${draftId}` },
    ]],
  }
}

export function formatDraftPrompt(senderName: string, text: string): string {
  return `📝 Draft for ${senderName}\n\n${text}`
}

export function formatSentResult(senderName: string, ts: number): string {
  const d = new Date(ts * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `✅ Sent to ${senderName} at ${hh}:${mm}`
}

export function formatCancelled(senderName: string): string {
  return `🗑 Cancelled draft to ${senderName}`
}

export function formatSendFailed(senderName: string, reason: string): string {
  return `❌ Failed to send to ${senderName}: ${reason}`
}

export function formatMutedList(entries: Array<{ key: string; label: string }>): string {
  if (entries.length === 0) return '🔇 Mute list is empty.'
  const head = `🔇 Muted (${entries.length})`
  const lines = entries.map((e, i) => `${i + 1}. ·  ${e.label}`)
  return [head, ...lines].join('\n')
}
