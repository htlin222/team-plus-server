import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR, type Cookies } from './config.ts'
import type { ConfigStore, TelegramConfig } from './config.ts'
import type { ChatCursor, CursorStore } from './cursor.ts'
import {
  chunkForTelegram,
  formatChatsList,
  formatMutedList,
  formatUnreadBlock,
  TG_MAX_CHARS,
  type InlineKeyboard,
} from './format.ts'
import {
  loadChatRoomList,
  loadPersonalChats,
  type ChatRoom,
  type PersonalChat,
} from './teamplus_rest.ts'

const IGNORE_FILE = join(STATE_DIR, 'dm_ignore.json')

/** Read the DM ignore list maintained by .claude/skills/dms/references/ignore.py. */
function loadIgnoreSet(): Set<string> {
  if (!existsSync(IGNORE_FILE)) return new Set()
  try {
    const raw = JSON.parse(readFileSync(IGNORE_FILE, 'utf8')) as any
    const arr = (raw?.ignored ?? []) as Array<{ userNo: unknown }>
    return new Set(arr.map(e => String(e?.userNo ?? '')).filter(Boolean))
  } catch {
    return new Set()
  }
}

const POLL_TIMEOUT_S = 30
const RETRY_DELAY_MS = 5_000

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`
}

export type SendOptions = {
  silent?: boolean
  reply_markup?: InlineKeyboard
}

/**
 * Send a Telegram message. If reply_markup is set, the message is sent as a
 * single chunk (Telegram only attaches keyboards to the message they're sent
 * with). Otherwise we chunk for the 4096-char limit. Returns the message_id of
 * the LAST chunk so callers can edit it later.
 */
export async function sendTelegram(
  cfg: TelegramConfig,
  text: string,
  opts: SendOptions = {},
): Promise<number | null> {
  const chunks = opts.reply_markup ? [text] : chunkForTelegram(text, TG_MAX_CHARS)
  let lastMessageId: number | null = null
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = {
      chat_id: cfg.chat_id,
      text: chunks[i],
    }
    if (opts.silent) body.disable_notification = true
    if (opts.reply_markup && i === chunks.length - 1) {
      body.reply_markup = opts.reply_markup
    }
    const res = await fetch(apiUrl(cfg.token, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Telegram sendMessage ${res.status}: ${err}`)
    }
    const json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
    if (json.result?.message_id) lastMessageId = json.result.message_id
    if (i < chunks.length - 1) await sleep(250)
  }
  return lastMessageId
}

/** Edit the text of a previously-sent message. Used to finalize draft prompts. */
export async function editMessage(
  cfg: TelegramConfig,
  messageId: number,
  text: string,
  opts: { reply_markup?: InlineKeyboard | null } = {},
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: cfg.chat_id,
    message_id: messageId,
    text,
  }
  if (opts.reply_markup === null) {
    // empty inline_keyboard removes the keyboard
    body.reply_markup = { inline_keyboard: [] }
  } else if (opts.reply_markup) {
    body.reply_markup = opts.reply_markup
  }
  const res = await fetch(apiUrl(cfg.token, 'editMessageText'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`editMessageText ${res.status}: ${await res.text()}`)
  }
}

/** Acknowledge a callback_query (mandatory — Telegram dims the button until this fires). */
export async function answerCallback(
  cfg: TelegramConfig,
  callbackQueryId: string,
  text: string,
  opts: { alert?: boolean } = {},
): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 200), // 200-char limit
  }
  if (opts.alert) body.show_alert = true
  const res = await fetch(apiUrl(cfg.token, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    process.stderr.write(`telegram: answerCallback failed ${res.status}: ${await res.text()}\n`)
  }
}

export async function setBotCommands(cfg: TelegramConfig): Promise<void> {
  const commands = [
    { command: 'unread', description: 'List all unread TeamPlus messages and clear queue' },
    { command: 'action', description: 'Inbox items awaiting your reply (DMs + groups)' },
    { command: 'chats', description: 'Show known chats and their unread counts' },
    { command: 'latest_person', description: 'Latest 10 one-on-one DMs (ignore-list filtered)' },
    { command: 'latest_group', description: 'Latest 10 chat rooms (groups + teams)' },
    { command: 'mute', description: 'Mute a chat (no buttons): /mute <chatId|name>' },
    { command: 'unmute', description: 'Unmute a chat: /unmute <chatId|name>' },
    { command: 'muted', description: 'List currently muted chats / senders' },
    { command: 'ping', description: 'Liveness check' },
    { command: 'help', description: 'Show command help' },
  ]
  const res = await fetch(apiUrl(cfg.token, 'setMyCommands'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands }),
  })
  if (!res.ok) {
    throw new Error(`setMyCommands ${res.status}: ${await res.text()}`)
  }
}

/** Result a callback handler returns to telegram.ts so it can call answerCallbackQuery. */
export type CallbackResult = {
  text: string
  alert?: boolean
}

export type TelegramOptions = {
  cfg: TelegramConfig
  cursor: CursorStore
  serverCfg: ConfigStore
  log: (line: string) => void
  /** Live cookies for any TeamPlus REST call (auto-refreshed by server.ts). */
  cookies: () => Cookies
  /** Handle inline-button callbacks. Returns the popup text + alert flag. */
  onCallback: (data: string, query: any) => Promise<CallbackResult>
  /**
   * Optional handler for free-text (non-slash) messages from the user.
   * dispatchUpdate auto-acks ("收到，處理中" + typing indicator) before
   * invoking this; callbacks just need to forward the text wherever it's
   * being routed (e.g. write to events.jsonl for the bridge to pick up).
   */
  onFreeText?: (text: string, msg: any) => Promise<void>
}

/** Show the "…is typing" status to the user (lasts ~5s, no notification). */
export async function sendChatAction(
  cfg: TelegramConfig,
  action: 'typing',
): Promise<void> {
  try {
    await fetch(apiUrl(cfg.token, 'sendChatAction'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chat_id, action }),
    })
  } catch {
    /* best-effort UX hint; never fail the caller */
  }
}

export async function runTelegramLoop(opts: TelegramOptions): Promise<never> {
  let offset = 0
  opts.log('telegram: ✓ long-poll started')

  const allowed = encodeURIComponent('["message","callback_query"]')

  for (;;) {
    try {
      const url = `${apiUrl(opts.cfg.token, 'getUpdates')}?offset=${offset}&timeout=${POLL_TIMEOUT_S}&allowed_updates=${allowed}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
      })
      if (!res.ok) {
        opts.log(`telegram: getUpdates ${res.status}: ${await res.text()}`)
        await sleep(RETRY_DELAY_MS)
        continue
      }
      const data = (await res.json()) as { ok: boolean; result?: any[] }
      if (!data.ok || !data.result?.length) continue

      for (const update of data.result) {
        offset = (update.update_id ?? offset) + 1
        try {
          await dispatchUpdate(update, opts)
        } catch (err) {
          opts.log(`telegram: update handler failed: ${err}`)
        }
      }
    } catch (err) {
      opts.log(`telegram: poll error: ${err}`)
      await sleep(RETRY_DELAY_MS)
    }
  }
}

async function dispatchUpdate(update: any, opts: TelegramOptions): Promise<void> {
  if (update.callback_query) {
    const q = update.callback_query
    const fromChat = String(q.message?.chat?.id ?? '')
    if (fromChat && fromChat !== opts.cfg.chat_id) return
    const data = String(q.data ?? '')
    let result: CallbackResult
    try {
      result = await opts.onCallback(data, q)
    } catch (err) {
      result = { text: `⚠ ${err}`, alert: true }
    }
    await answerCallback(opts.cfg, q.id, result.text, { alert: result.alert })
    return
  }

  const msg = update.message
  if (!msg) return
  const chatId = String(msg.chat?.id ?? '')
  if (chatId !== opts.cfg.chat_id) return
  const text = typeof msg.text === 'string' ? msg.text.trim() : ''
  if (!text) return

  // Slash command → existing routing.
  if (text.startsWith('/')) {
    try {
      await dispatchCommand(text, opts)
    } catch (err) {
      opts.log(`telegram: command failed: ${err}`)
      await sendTelegram(opts.cfg, `⚠ Command failed: ${err}`).catch(() => undefined)
    }
    return
  }

  // Free text → typing indicator immediately for UX, then route to onFreeText
  // (if wired). Text ack ("收到，處理中…") is the handler's call so it can
  // skip it when the bridge is dead and a different message is more useful.
  if (opts.onFreeText) {
    void sendChatAction(opts.cfg, 'typing')
    try {
      await opts.onFreeText(text, msg)
    } catch (err) {
      opts.log(`telegram: free-text handler failed: ${err}`)
      await sendTelegram(opts.cfg, `⚠ ${err}`).catch(() => undefined)
    }
    return
  }

  // Fall back to old "unknown command" behavior so we don't silently swallow.
  await sendTelegram(opts.cfg, `Unknown command: ${text.split(/\s+/)[0]}\n\n${HELP_TEXT}`)
}

const HELP_TEXT = [
  'TeamPlus bridge commands:',
  '/unread — list all unread messages from every chat, then clear the queue',
  '/unread <chatId|name fragment> — list unread for one chat only',
  '/action — inbox items where the last message is → you (DMs + groups, ignore-filtered)',
  '/chats — show known chats with unread counts',
  '/latest_person — latest 10 one-on-one DMs (ignore-list filtered)',
  '/latest_group — latest 10 chat rooms (groups + teams)',
  '/mute <chatId|name fragment> — stop attaching action buttons to that chat',
  '/unmute <chatId|name fragment> — re-enable buttons',
  '/muted — list currently muted chats / senders',
  '/ping — liveness check',
  '/help — this message',
].join('\n')

async function dispatchCommand(text: string, opts: TelegramOptions): Promise<void> {
  const [headRaw, ...rest] = text.split(/\s+/)
  const head = (headRaw ?? '').toLowerCase().split('@')[0]
  const arg = rest.join(' ').trim()

  switch (head) {
    case '/unread':
      await handleUnread(opts, arg)
      return
    case '/chats':
      await sendTelegram(opts.cfg, formatChatsList(opts.cursor.knownChats()))
      return
    case '/latest_person':
      await handleLatestPerson(opts)
      return
    case '/latest_group':
      await handleLatestGroup(opts)
      return
    case '/action':
      await handleAction(opts)
      return
    case '/mute':
      await handleMute(opts, arg)
      return
    case '/unmute':
      await handleUnmute(opts, arg)
      return
    case '/muted':
      await handleMuted(opts)
      return
    case '/ping':
      await sendTelegram(opts.cfg, '🟢 alive')
      return
    case '/help':
    case '/start':
      await sendTelegram(opts.cfg, HELP_TEXT)
      return
    default:
      await sendTelegram(opts.cfg, `Unknown command: ${head}\n\n${HELP_TEXT}`)
  }
}

async function handleLatestPerson(opts: TelegramOptions): Promise<void> {
  try {
    const ignored = loadIgnoreSet()
    // Over-fetch to absorb anyone we'll filter out.
    const target = 10
    const pulled = await loadPersonalChats(opts.cookies(), {
      count: target + ignored.size + 5,
      channelType: 0,
    })
    const filtered = pulled.filter(c => !ignored.has(c.mobile)).slice(0, target)
    await sendTelegram(opts.cfg, formatPersonalChats(filtered, ignored.size))
  } catch (err) {
    opts.log(`telegram: /latest_person failed: ${err}`)
    await sendTelegram(opts.cfg, `⚠ /latest_person failed: ${err}`).catch(() => undefined)
  }
}

async function handleLatestGroup(opts: TelegramOptions): Promise<void> {
  try {
    const rooms = await loadChatRoomList(opts.cookies())
    await sendTelegram(opts.cfg, formatChatRooms(rooms.slice(0, 10)))
  } catch (err) {
    opts.log(`telegram: /latest_group failed: ${err}`)
    await sendTelegram(opts.cfg, `⚠ /latest_group failed: ${err}`).catch(() => undefined)
  }
}

async function handleAction(opts: TelegramOptions): Promise<void> {
  try {
    const ignored = loadIgnoreSet()
    // Pull both DMs + groups (no channelType filter), oversize for filtering.
    const pulled = await loadPersonalChats(opts.cookies(), { count: 40 })
    // Inbox awaiting reply = last message is inbound (peer → you).
    // For DMs, also drop ignored peers; for groups (channelType=1) the
    // ignore list doesn't apply (keyed by UserNo, which is self).
    const items = pulled
      .filter(c => c.inOut === 0)
      .filter(c => c.channelType !== 0 || !ignored.has(c.mobile))
      .slice(0, 12)
    await sendTelegram(opts.cfg, formatActionList(items, ignored.size))
  } catch (err) {
    opts.log(`telegram: /action failed: ${err}`)
    await sendTelegram(opts.cfg, `⚠ /action failed: ${err}`).catch(() => undefined)
  }
}

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Shared one-line formatter for any list view. Keeps every menu command
 * (`/action`, `/latest_person`, `/latest_group`, `/chats`) visually aligned:
 *
 *   N. KIND [u] arrow name (key) · meta «preview»
 *
 * Optional fields are simply omitted but the column order is fixed.
 */
type ListLine = {
  idx: number
  /** Visual kind tag — emoji preferred (💬 DM, 🧑‍🤝‍🧑 group/team). */
  kind: string
  /** Unread count; renders as `[N] ` when > 0, otherwise omitted. */
  unread?: number
  /** '←' = peer→you (your move), '→' = you→peer (their move). */
  arrow?: '←' | '→'
  /** Important / pinned room marker. */
  star?: boolean
  /** Display name. */
  name: string
  /** Stable handle to feed the next command (mobile or chatId-8). */
  key?: string
  /** Right-side meta: time, member count, etc. */
  meta?: string
  /** Last-message snippet — clipped to 50 chars. */
  preview?: string
}

function fmtLine(l: ListLine): string {
  const parts: string[] = [`${l.idx}.`, l.kind]
  if (l.unread && l.unread > 0) parts.push(`[${l.unread}]`)
  if (l.arrow) parts.push(l.arrow)
  if (l.star) parts.push('⭐')
  parts.push(l.name)
  if (l.key) parts.push(`(${l.key})`)
  if (l.meta) parts.push(`· ${l.meta}`)
  let line = parts.join(' ')
  if (l.preview) line += `  «${clip(l.preview, 50)}»`
  return line
}

function personalChatLine(idx: number, c: PersonalChat): ListLine {
  return {
    idx,
    kind: c.channelType === 0 ? '💬' : '🧑‍🤝‍🧑',
    unread: c.unread,
    arrow: c.inOut === 0 ? '←' : '→',
    name: c.userName,
    key: c.channelType === 0 ? c.mobile : c.chatId.slice(0, 8),
    meta: c.timeDesc || undefined,
    preview: c.msgPreview || undefined,
  }
}

function formatActionList(items: PersonalChat[], hiddenCount: number): string {
  if (items.length === 0) {
    return hiddenCount > 0
      ? `🎉 Nothing awaiting reply (${hiddenCount} ignored)`
      : '🎉 Nothing awaiting reply'
  }
  const head = `📥 Awaiting reply (${items.length})`
  const body = items.map((c, i) => fmtLine(personalChatLine(i + 1, c))).join('\n')
  const foot = hiddenCount > 0 ? `\n(${hiddenCount} ignored)` : ''
  return `${head}\n${body}${foot}`
}

function formatPersonalChats(chats: PersonalChat[], hiddenCount: number): string {
  if (chats.length === 0) {
    return hiddenCount > 0
      ? `(no DMs — ${hiddenCount} ignored)`
      : '(no DMs found)'
  }
  const head = `👤 Latest DMs (${chats.length})`
  const body = chats.map((c, i) => fmtLine(personalChatLine(i + 1, c))).join('\n')
  const foot = hiddenCount > 0 ? `\n(${hiddenCount} ignored)` : ''
  return `${head}\n${body}${foot}`
}

function formatChatRooms(rooms: ChatRoom[]): string {
  if (rooms.length === 0) return '(no chat rooms found)'
  const head = `📋 Chat rooms (${rooms.length})`
  const body = rooms
    .map((r, i) =>
      fmtLine({
        idx: i + 1,
        kind: '🧑‍🤝‍🧑',
        unread: r.unread,
        star: r.isImportant,
        name: r.name,
        key: r.chatId.slice(0, 8),
        meta: `${r.memberCount}人${r.chatType === 2 ? ' · team' : ''}`,
      }),
    )
    .join('\n')
  return `${head}\n${body}`
}

async function handleUnread(opts: TelegramOptions, arg: string): Promise<void> {
  const targets = arg
    ? pickChats(opts.cursor.knownChats(), arg)
    : opts.cursor.unreadChats()

  if (!targets.length) {
    await sendTelegram(
      opts.cfg,
      arg ? `No chat matched: ${arg}` : 'No unread messages.',
    )
    return
  }

  const blocks: string[] = []
  let totalDrained = 0
  for (const { chatId, cursor } of targets) {
    const { drained, spilled } = opts.cursor.drain(chatId)
    if (drained.length === 0) continue
    totalDrained += drained.length
    blocks.push(formatUnreadBlock(chatId, cursor, drained, spilled))
  }

  if (totalDrained === 0) {
    await sendTelegram(opts.cfg, 'No unread messages.')
    return
  }

  await opts.cursor.save()

  const summary = `📬 ${totalDrained} unread across ${blocks.length} chat${blocks.length === 1 ? '' : 's'}`
  const body = [summary, '', ...blocks].join('\n\n')
  await sendTelegram(opts.cfg, body)
}

async function handleMute(opts: TelegramOptions, arg: string): Promise<void> {
  if (!arg) {
    await sendTelegram(opts.cfg, 'Usage: /mute <chatId|name fragment>')
    return
  }
  const matches = pickChats(opts.cursor.knownChats(), arg)
  if (matches.length === 0) {
    await sendTelegram(opts.cfg, `No chat matched: ${arg}`)
    return
  }
  if (matches.length > 1) {
    const list = matches.map(m => `· ${m.cursor.name ?? '?'} (${m.chatId})`).join('\n')
    await sendTelegram(opts.cfg, `Ambiguous — matches:\n${list}\nUse the chatId.`)
    return
  }
  const { chatId, cursor } = matches[0]!
  const added = opts.serverCfg.muteChat(chatId)
  await opts.serverCfg.save()
  const label = cursor.name ? `${cursor.name} (${chatId})` : chatId
  await sendTelegram(opts.cfg, added ? `🔇 Muted ${label}` : `(already muted) ${label}`)
}

async function handleUnmute(opts: TelegramOptions, arg: string): Promise<void> {
  if (!arg) {
    await sendTelegram(opts.cfg, 'Usage: /unmute <chatId|name fragment>')
    return
  }
  // First try chat ID match against current mute list directly.
  const muted = opts.serverCfg.mutedChats()
  let removed: string | null = null
  if (muted.includes(arg)) {
    opts.serverCfg.unmuteChat(arg)
    removed = arg
  } else {
    const matches = pickChats(opts.cursor.knownChats(), arg).filter(m => muted.includes(m.chatId))
    if (matches.length === 1) {
      opts.serverCfg.unmuteChat(matches[0]!.chatId)
      removed = matches[0]!.chatId
    } else if (matches.length > 1) {
      const list = matches.map(m => `· ${m.cursor.name ?? '?'} (${m.chatId})`).join('\n')
      await sendTelegram(opts.cfg, `Ambiguous — matches:\n${list}\nUse the chatId.`)
      return
    }
  }
  if (!removed) {
    await sendTelegram(opts.cfg, `Not in mute list: ${arg}`)
    return
  }
  await opts.serverCfg.save()
  await sendTelegram(opts.cfg, `🔊 Unmuted ${removed}`)
}

async function handleMuted(opts: TelegramOptions): Promise<void> {
  const chatIds = opts.serverCfg.mutedChats()
  const senderIds = opts.serverCfg.mutedSenders()
  const known = opts.cursor.knownChats()
  const entries = [
    ...chatIds.map(id => {
      const c = known.find(k => k.chatId === id)?.cursor
      return { key: id, label: c?.name ? `${c.name} (${id})` : id }
    }),
    ...senderIds.map(id => ({ key: id, label: `sender:#${id}` })),
  ]
  await sendTelegram(opts.cfg, formatMutedList(entries))
}

function pickChats(
  chats: Array<{ chatId: string; cursor: ChatCursor }>,
  arg: string,
): Array<{ chatId: string; cursor: ChatCursor }> {
  const lower = arg.toLowerCase()
  const exact = chats.filter(c => c.chatId === arg)
  if (exact.length) return exact
  return chats.filter(
    c => c.chatId.includes(arg) || (c.cursor.name ?? '').toLowerCase().includes(lower),
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
