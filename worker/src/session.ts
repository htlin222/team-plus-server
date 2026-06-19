import { DurableObject } from 'cloudflare:workers'
import {
  buildCookieHeader,
  getTeamplusToken,
  normalizeTeamplusEvent,
  resolveTeamplusBase,
  teamplusHost,
  teamplusWsUrl,
  type CookieRecord,
  type TeamplusMessage,
} from './teamplus'
import {
  insertMessage,
  insertSessionEvent,
  selectPendingAttachments,
  updateAttachmentKey,
} from './turso'
import { dmPeerId, loadChatRoomNames, lookupContactNames } from './contacts'
import { attachmentKey, downloadAttachment, parseAttachment } from './attachments'
import { sendChatMessage, type SendResult } from './send'

const SESSION_KEY = 'session'
const PING_MS = 30_000
const RECONNECT_MS = 5_000

export type CookieUpload = {
  cookies: CookieRecord[] | Record<string, string>
  my_id?: number
  updated_at_ms?: number
  start?: boolean
}

export type SessionStatus = {
  accountId: string
  hasCookies: boolean
  myId: number | null
  cookieUpdatedAtMs: number | null
  connected: boolean
  connectRequested: boolean
  connectedAtMs: number | null
  lastMessageAtMs: number | null
  lastEventKey: string | null
  lastError: string | null
  alarmAtMs: number | null
}

type StoredSession = {
  cookieHeader: string
  myId: number | null
  cookieUpdatedAtMs: number
  connectRequested: boolean
  connectedAtMs: number | null
  lastMessageAtMs: number | null
  lastEventKey: string | null
  lastError: string | null
}

export class TeamplusSession extends DurableObject<Env> {
  private accountId: string
  private session: StoredSession | null = null
  private ws: WebSocket | null = null
  private connecting: Promise<void> | null = null
  // Lazily-filled name caches (in-memory; cheap to rebuild after eviction).
  private contactNames = new Map<string, string>()
  private groupNames = new Map<string, string>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.accountId = ctx.id.name ?? 'unknown'
    ctx.blockConcurrencyWhile(async () => {
      this.session = (await this.ctx.storage.get<StoredSession>(SESSION_KEY)) ?? null
    })
  }

  async updateSession(input: CookieUpload): Promise<SessionStatus> {
    const host = teamplusHost(resolveTeamplusBase(this.env))
    const cookieHeader = buildCookieHeader(input.cookies, host)
    if (!cookieHeader) throw new Error('cookie upload produced an empty TeamPlus cookie header')

    const previous = this.session
    this.session = {
      cookieHeader,
      myId: typeof input.my_id === 'number' ? input.my_id : previous?.myId ?? null,
      cookieUpdatedAtMs: input.updated_at_ms ?? Date.now(),
      connectRequested: input.start !== false,
      connectedAtMs: null,
      lastMessageAtMs: previous?.lastMessageAtMs ?? null,
      lastEventKey: previous?.lastEventKey ?? null,
      lastError: null,
    }
    await this.persist()
    await this.logEvent('cookies_updated')

    this.closeWs(1000, 'cookie refresh')
    if (this.session.connectRequested) {
      await this.ctx.storage.setAlarm(Date.now() + 100)
    }
    return this.status()
  }

  async start(): Promise<SessionStatus> {
    if (!this.session) throw new Error('no cookies uploaded yet')
    this.session.connectRequested = true
    await this.persist()
    await this.ensureConnected()
    return this.status()
  }

  async stop(): Promise<SessionStatus> {
    if (this.session) {
      this.session.connectRequested = false
      this.session.connectedAtMs = null
      await this.persist()
    }
    this.closeWs(1000, 'manual stop')
    await this.ctx.storage.deleteAlarm()
    await this.logEvent('stopped')
    return this.status()
  }

  async status(): Promise<SessionStatus> {
    const alarmAtMs = await this.ctx.storage.getAlarm()
    return {
      accountId: this.accountId,
      hasCookies: Boolean(this.session?.cookieHeader),
      myId: this.session?.myId ?? null,
      cookieUpdatedAtMs: this.session?.cookieUpdatedAtMs ?? null,
      connected: this.ws?.readyState === WebSocket.OPEN,
      connectRequested: this.session?.connectRequested ?? false,
      connectedAtMs: this.session?.connectedAtMs ?? null,
      lastMessageAtMs: this.session?.lastMessageAtMs ?? null,
      lastEventKey: this.session?.lastEventKey ?? null,
      lastError: this.session?.lastError ?? null,
      alarmAtMs,
    }
  }

  async nudge(): Promise<SessionStatus> {
    if (this.session?.connectRequested) {
      await this.ensureConnected()
    }
    return this.status()
  }

  /** Send an outbound message. DM: pass `to` (peer userNo). */
  async send(input: {
    to?: number
    chatId?: string
    text: string
    channelType?: number
    replyBatchId?: string
  }): Promise<SendResult & { chatId: string }> {
    if (!this.session?.cookieHeader) throw new Error('no cookies uploaded yet')
    if (!input.text) throw new Error('text is required')
    const channelType = input.channelType ?? 0

    let chatId = input.chatId ?? ''
    let recipients: Array<{ mobile: string }> = []
    if (channelType === 0) {
      if (input.to == null) throw new Error('to (peer userNo) is required for a DM')
      const myId = this.session.myId
      if (myId == null) throw new Error('myId unknown — upload cookies first')
      chatId = chatId || [myId, input.to].sort((a, b) => a - b).join('_')
      recipients = [{ mobile: String(input.to) }]
    } else if (!chatId) {
      throw new Error('chatId is required for a group send')
    }

    const base = resolveTeamplusBase(this.env)
    const result = await sendChatMessage(base, this.session.cookieHeader, {
      chatId,
      channelType,
      recipients,
      content: input.text,
      replyBatchId: input.replyBatchId,
    })
    await this.logEvent('sent', `${chatId} ok=${result.isSuccess}`)
    return { ...result, chatId }
  }

  async alarm(): Promise<void> {
    try {
      if (!this.session?.connectRequested) return
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ Ask: 'PING' }))
        await this.ctx.storage.setAlarm(Date.now() + PING_MS)
        return
      }
      await this.ensureConnected()
    } catch (err) {
      await this.recordError(err)
      await this.ctx.storage.setAlarm(Date.now() + RECONNECT_MS)
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.session?.cookieHeader) throw new Error('no cookies uploaded yet')
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.connecting) return this.connecting

    this.connecting = this.openTeamplusSocket()
      .catch(async err => {
        await this.recordError(err)
        throw err
      })
      .finally(() => {
        this.connecting = null
      })
    return this.connecting
  }

  private async openTeamplusSocket(): Promise<void> {
    if (!this.session) throw new Error('no session loaded')

    const base = resolveTeamplusBase(this.env)
    const token = await getTeamplusToken(base, this.session.cookieHeader)
    const res = await fetch(teamplusWsUrl(base), {
      headers: {
        Upgrade: 'websocket',
        Cookie: this.session.cookieHeader,
      },
    })
    if (res.status !== 101 || !res.webSocket) {
      throw new Error(`TeamPlus websocket upgrade failed: ${res.status}`)
    }

    const ws = res.webSocket
    ws.accept()
    this.ws = ws

    ws.addEventListener('message', event => {
      const raw = typeof event.data === 'string'
        ? event.data
        : event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : ''
      this.ctx.waitUntil(this.handleRawMessage(raw).catch(err => this.recordError(err)))
    })
    ws.addEventListener('close', event => {
      this.ws = null
      this.ctx.waitUntil(this.scheduleReconnect(`closed ${event.code}: ${event.reason}`))
    })
    ws.addEventListener('error', () => {
      this.ws = null
      this.ctx.waitUntil(this.scheduleReconnect('websocket error'))
    })

    ws.send(JSON.stringify({ Ask: 'CORE:AUTH', Data: token }))
    this.session.connectedAtMs = Date.now()
    this.session.lastError = null
    await this.persist()
    await this.logEvent('connected')
    await this.ctx.storage.setAlarm(Date.now() + PING_MS)
  }

  private async handleRawMessage(raw: string): Promise<void> {
    if (!raw) return
    const session = this.session
    const message = await normalizeTeamplusEvent(raw, session?.myId ?? null)
    if (!message) return

    await this.enrichNames(message)
    await insertMessage(this.env, message)
    if (this.session) {
      this.session.lastMessageAtMs = Date.now()
      this.session.lastEventKey = message.eventKey
      await this.persist()
    }
    await this.archiveAttachment(message)
  }

  /**
   * If the message carries an image/file, download the bytes from TeamPlus and
   * archive them to R2, then record the object key on the row. Best-effort: a
   * failure leaves attachment_key null (and can be backfilled later).
   */
  private async archiveAttachment(message: TeamplusMessage): Promise<boolean> {
    return this.archiveOne({
      eventKey: message.eventKey,
      content2: message.content2,
      batchId: message.batchId,
      channelType: message.channelType,
      chatId: message.chatId,
      senderId: message.senderId,
    })
  }

  private async archiveOne(row: {
    eventKey: string
    content2: string | null
    batchId: string | null
    channelType: number | null
    chatId: string
    senderId: number | null
  }): Promise<boolean> {
    const cookieHeader = this.session?.cookieHeader
    if (!cookieHeader || !row.batchId) return false
    const meta = parseAttachment(row.content2)
    if (!meta) return false
    try {
      const dl = await downloadAttachment(resolveTeamplusBase(this.env), cookieHeader, {
        fileName: meta.fileName,
        channelType: row.channelType,
        batchId: row.batchId,
      })
      if (!dl) return false
      const key = attachmentKey(row.batchId, meta.fileName)
      await this.env.ATTACHMENTS.put(key, dl.bytes, {
        httpMetadata: { contentType: dl.contentType },
        customMetadata: {
          showName: meta.showName ?? '',
          chatId: row.chatId,
          senderId: String(row.senderId ?? ''),
        },
      })
      await updateAttachmentKey(this.env, row.eventKey, key)
      return true
    } catch (err) {
      console.error(`attachment archive failed (${row.eventKey}): ${err}`)
      return false
    }
  }

  /** Archive any not-yet-stored image/file attachments. Re-runnable repair op. */
  async backfillAttachments(limit = 50): Promise<{ scanned: number; archived: number }> {
    if (!this.session?.cookieHeader) throw new Error('no cookies uploaded yet')
    const rows = await selectPendingAttachments(this.env, limit)
    let archived = 0
    for (const row of rows) {
      if (await this.archiveOne(row)) archived++
    }
    return { scanned: rows.length, archived }
  }

  /**
   * Fill sender_name / chat_name from the REST contact + chat-room APIs.
   * Best-effort and fully cached: a lookup failure leaves names null rather
   * than dropping the message.
   */
  private async enrichNames(message: TeamplusMessage): Promise<void> {
    const cookieHeader = this.session?.cookieHeader
    if (!cookieHeader) return
    const base = resolveTeamplusBase(this.env)
    const myId = this.session?.myId ?? null

    if (message.senderId != null && !message.senderName) {
      message.senderName = await this.resolveContact(base, cookieHeader, message.senderId)
    }

    if (!message.chatName) {
      if (message.channelType === 1) {
        message.chatName = await this.resolveGroupName(base, cookieHeader, message.chatId)
      } else {
        const peerId = dmPeerId(message.chatId, myId)
        if (peerId != null) {
          message.chatName = await this.resolveContact(base, cookieHeader, peerId)
        }
      }
    }
  }

  private async resolveContact(
    base: string,
    cookieHeader: string,
    userNo: number,
  ): Promise<string | null> {
    const key = String(userNo)
    const cached = this.contactNames.get(key)
    if (cached !== undefined) return cached
    try {
      const map = await lookupContactNames(base, cookieHeader, [key])
      const name = map.get(key) ?? null
      if (name) this.contactNames.set(key, name)
      return name
    } catch (err) {
      console.error(`contact lookup failed for ${key}: ${err}`)
      return null
    }
  }

  private async resolveGroupName(
    base: string,
    cookieHeader: string,
    chatId: string,
  ): Promise<string | null> {
    const cached = this.groupNames.get(chatId)
    if (cached !== undefined) return cached
    try {
      const map = await loadChatRoomNames(base, cookieHeader)
      for (const [id, name] of map) this.groupNames.set(id, name)
      return this.groupNames.get(chatId) ?? null
    } catch (err) {
      console.error(`chat room lookup failed for ${chatId}: ${err}`)
      return null
    }
  }

  private async scheduleReconnect(detail: string): Promise<void> {
    if (!this.session?.connectRequested) return
    await this.recordError(detail)
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_MS)
  }

  private async recordError(err: unknown): Promise<void> {
    if (this.session) {
      this.session.connectedAtMs = null
      this.session.lastError = String(err)
      await this.persist()
    }
    await this.logEvent('error', String(err)).catch(() => undefined)
  }

  private closeWs(code: number, reason: string): void {
    if (!this.ws) return
    try {
      this.ws.close(code, reason)
    } catch {
      /* ignored */
    }
    this.ws = null
  }

  private async persist(): Promise<void> {
    if (this.session) await this.ctx.storage.put(SESSION_KEY, this.session)
  }

  private async logEvent(eventType: string, detail?: string): Promise<void> {
    try {
      await insertSessionEvent(this.env, this.accountId, eventType, detail)
    } catch (err) {
      console.error(`session event insert failed: ${err}`)
    }
  }
}
