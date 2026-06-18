import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { CURSORS_FILE, STATE_DIR } from './config.ts'

export type UnreadEntry = {
  msgId: string
  senderId: number
  senderName: string
  ts: number
  msgType: number
  content: string
}

export type ChatCursor = {
  name: string | null
  lastSeenMsgId: string | null
  lastSeenTs: number
  unread: UnreadEntry[]
  spilled: number
}

export type CallbackEntry = {
  cbId: string
  chatId: string
  msgId: string
  senderId: number
  senderName: string
  content: string
  ts: number
  /** Telegram message_id of the forwarded message, useful for editing later. */
  telegramMessageId: number | null
}

export type CursorFile = {
  myId: number
  chats: Record<string, ChatCursor>
  /** userNo (string) → display name; populated lazily via REST lookup. */
  senderNames: Record<string, string>
  /** cbId (8-char) → metadata for an outstanding action button. */
  callbacks: Record<string, CallbackEntry>
}

const UNREAD_CAP = 200
const CALLBACK_TTL_MS = 24 * 3600 * 1000

function emptyChat(): ChatCursor {
  return { name: null, lastSeenMsgId: null, lastSeenTs: 0, unread: [], spilled: 0 }
}

export class CursorStore {
  private data: CursorFile
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(data: CursorFile) {
    this.data = data
  }

  static async load(myId: number): Promise<CursorStore> {
    let data: CursorFile
    try {
      const raw = await readFile(CURSORS_FILE, 'utf8')
      const parsed = JSON.parse(raw) as Partial<CursorFile>
      data = {
        myId,
        chats: parsed.chats ?? {},
        senderNames: parsed.senderNames ?? {},
        callbacks: parsed.callbacks ?? {},
      }
      for (const c of Object.values(data.chats)) {
        if (typeof c.spilled !== 'number') c.spilled = 0
        if (!Array.isArray(c.unread)) c.unread = []
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        process.stderr.write(`cursor: load failed (${err}); starting fresh\n`)
      }
      data = { myId, chats: {}, senderNames: {}, callbacks: {} }
    }
    const store = new CursorStore(data)
    store.pruneCallbacks()
    return store
  }

  private chat(chatId: string): ChatCursor {
    let c = this.data.chats[chatId]
    if (!c) {
      c = emptyChat()
      this.data.chats[chatId] = c
    }
    return c
  }

  setName(chatId: string, name: string | null): void {
    if (!name) return
    const c = this.chat(chatId)
    if (c.name !== name) c.name = name
  }

  appendUnread(chatId: string, entry: UnreadEntry, chatName?: string | null): void {
    const c = this.chat(chatId)
    if (chatName) c.name = chatName
    if (c.unread.some(u => u.msgId === entry.msgId)) return
    c.unread.push(entry)
    while (c.unread.length > UNREAD_CAP) {
      c.unread.shift()
      c.spilled += 1
    }
  }

  hasSeen(chatId: string, msgId: string): boolean {
    const c = this.data.chats[chatId]
    if (!c) return false
    if (c.lastSeenMsgId === msgId) return true
    return c.unread.some(u => u.msgId === msgId)
  }

  /** Return chats with unread, in insertion order. */
  unreadChats(): Array<{ chatId: string; cursor: ChatCursor }> {
    return Object.entries(this.data.chats)
      .filter(([, c]) => c.unread.length > 0)
      .map(([chatId, cursor]) => ({ chatId, cursor }))
  }

  /** Drain unread for one chat: empty queue, advance lastSeen markers. */
  drain(chatId: string): { drained: UnreadEntry[]; spilled: number } {
    const c = this.data.chats[chatId]
    if (!c || c.unread.length === 0) return { drained: [], spilled: 0 }
    const drained = c.unread.slice()
    const spilled = c.spilled
    const last = drained[drained.length - 1]!
    c.lastSeenMsgId = last.msgId
    c.lastSeenTs = last.ts
    c.unread = []
    c.spilled = 0
    return { drained, spilled }
  }

  /** Drain all chats. */
  drainAll(): Array<{ chatId: string; cursor: ChatCursor; drained: UnreadEntry[]; spilled: number }> {
    const out: Array<{ chatId: string; cursor: ChatCursor; drained: UnreadEntry[]; spilled: number }> = []
    for (const { chatId, cursor } of this.unreadChats()) {
      const { drained, spilled } = this.drain(chatId)
      out.push({ chatId, cursor, drained, spilled })
    }
    return out
  }

  knownChats(): Array<{ chatId: string; cursor: ChatCursor }> {
    return Object.entries(this.data.chats).map(([chatId, cursor]) => ({ chatId, cursor }))
  }

  // ── sender name cache ────────────────────────────────────────────

  getSenderName(senderId: number | string): string | null {
    return this.data.senderNames[String(senderId)] ?? null
  }

  setSenderName(senderId: number | string, name: string): void {
    if (!name) return
    const key = String(senderId)
    if (this.data.senderNames[key] !== name) {
      this.data.senderNames[key] = name
    }
  }

  // ── action-button callback registry ──────────────────────────────

  recordCallback(entry: Omit<CallbackEntry, 'cbId'> & { cbId?: string }): CallbackEntry {
    const cbId = entry.cbId || this.newCbId()
    const full: CallbackEntry = { ...entry, cbId }
    this.data.callbacks[cbId] = full
    return full
  }

  getCallback(cbId: string): CallbackEntry | undefined {
    return this.data.callbacks[cbId]
  }

  attachTelegramMessageId(cbId: string, telegramMessageId: number): void {
    const c = this.data.callbacks[cbId]
    if (c) c.telegramMessageId = telegramMessageId
  }

  pruneCallbacks(): number {
    const cutoff = Date.now() / 1000 - CALLBACK_TTL_MS / 1000
    let removed = 0
    for (const [k, v] of Object.entries(this.data.callbacks)) {
      if (v.ts < cutoff) {
        delete this.data.callbacks[k]
        removed += 1
      }
    }
    return removed
  }

  private newCbId(): string {
    // 8 chars from base36 — collision-safe for thousands of outstanding callbacks
    for (let i = 0; i < 5; i++) {
      const id = Math.random().toString(36).slice(2, 10).padEnd(8, '0').slice(0, 8)
      if (!this.data.callbacks[id]) return id
    }
    return Math.random().toString(36).slice(2, 10)
  }

  /** Persist atomically. Calls are serialized so concurrent saves don't race. */
  save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(STATE_DIR, { recursive: true })
      const tmp = `${CURSORS_FILE}.tmp`
      const payload = JSON.stringify(this.data, null, 2)
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, CURSORS_FILE)
    }).catch(err => {
      process.stderr.write(`cursor: save failed: ${err}\n`)
    })
    return this.writeQueue
  }
}

export { CURSORS_FILE }
