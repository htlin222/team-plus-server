import WebSocket from 'ws'
import {
  cookieHeader,
  loadCookies,
  TEAMPLUS_TOKEN_URL,
  TEAMPLUS_WS_URL,
  type Cookies,
} from './config.ts'
import type { CursorStore, UnreadEntry } from './cursor.ts'

const WS_URL = TEAMPLUS_WS_URL
const TOKEN_URL = TEAMPLUS_TOKEN_URL
const PING_INTERVAL_MS = 30_000
const RECONNECT_DELAY_MS = 5_000

async function getToken(cookies: Cookies): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      cookie: cookieHeader(cookies),
    },
    body: 'Ask=getToken',
  })
  const data = (await res.json()) as { IsSuccess?: boolean; Data?: string }
  if (!data.Data) throw new Error(`Failed to get token: ${JSON.stringify(data)}`)
  return data.Data
}

type RawMsg = {
  Event?: string
  Ask?: string
  Data?: any
}

export type TeamplusOptions = {
  myId: number
  cursor: CursorStore
  /** Called with the freshly-stored unread entry for each new inbound message. */
  onMessage: (chatId: string, chatName: string | null, entry: UnreadEntry) => void
  /** Status logger (one-line strings). */
  log: (line: string) => void
}

export async function runTeamplusLoop(opts: TeamplusOptions): Promise<never> {
  let cookies = await loadCookies()

  for (;;) {
    try {
      await wsSession(cookies, opts)
      opts.log(`teamplus: ws closed; reconnecting in ${RECONNECT_DELAY_MS}ms`)
    } catch (err) {
      opts.log(`teamplus: session error: ${err}`)
    }
    await sleep(RECONNECT_DELAY_MS)
    try {
      cookies = await loadCookies()
    } catch (err) {
      opts.log(`teamplus: cookie reload failed (${err}); reusing previous`)
    }
  }
}

async function wsSession(cookies: Cookies, opts: TeamplusOptions): Promise<void> {
  const token = await getToken(cookies)
  opts.log('teamplus: ✓ token acquired')

  const ws = new WebSocket(WS_URL, {
    headers: { Cookie: cookieHeader(cookies) },
  })

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      ws.off('open', onOpen)
      reject(err)
    }
    ws.once('open', onOpen)
    ws.once('error', onError)
  })

  ws.send(JSON.stringify({ Ask: 'CORE:AUTH', Data: token }))
  opts.log('teamplus: ✓ authenticated, listening for messages')

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ Ask: 'PING' }))
      } catch {
        /* swallow — close handler will fire */
      }
    }
  }, PING_INTERVAL_MS)

  await new Promise<void>(resolve => {
    ws.on('message', (raw: Buffer | string) => {
      try {
        handleEvent(typeof raw === 'string' ? raw : raw.toString('utf8'), opts)
      } catch (err) {
        opts.log(`teamplus: handler error: ${err}`)
      }
    })
    ws.on('close', () => {
      clearInterval(ping)
      resolve()
    })
    ws.on('error', err => {
      opts.log(`teamplus: ws error: ${err}`)
      clearInterval(ping)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve()
    })
  })
}

function handleEvent(raw: string, opts: TeamplusOptions): void {
  let msg: RawMsg
  try {
    msg = JSON.parse(raw) as RawMsg
  } catch {
    return
  }

  const event = msg.Event ?? msg.Ask ?? ''
  if (event !== 'IM_CHAT:NEW_MESSAGE') return

  const data = msg.Data
  if (!data || typeof data !== 'object') return

  const senderId = Number(data.SenderID)
  if (!Number.isFinite(senderId)) return
  // skip own messages
  if (senderId === opts.myId) return

  const chatId = String(data.ChatID ?? '')
  if (!chatId) return

  const msgId = String(
    data.MsgID ?? data.MessageID ?? data.ID ?? `${chatId}-${data.SendTime ?? Date.now()}`,
  )

  if (opts.cursor.hasSeen(chatId, msgId)) return

  const msgType = Number(data.MsgType ?? 0)
  const content = String(data.Content ?? '')
  // TeamPlus payloads sometimes carry friendly names; fall back to raw IDs.
  const senderName = String(
    data.SenderName ?? data.SenderRealName ?? data.SenderNickName ?? '',
  )
  const chatName = data.ChatName ? String(data.ChatName) : null
  const ts = parseTs(data.SendTime ?? data.CreateTime) ?? Math.floor(Date.now() / 1000)

  const entry: UnreadEntry = {
    msgId,
    senderId,
    senderName,
    ts,
    msgType,
    content,
  }

  opts.cursor.appendUnread(chatId, entry, chatName)
  opts.cursor.save()
  opts.onMessage(chatId, chatName, entry)
}

function parseTs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // TeamPlus UTC value is seconds; if it's milliseconds, normalize.
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  }
  if (typeof value === 'string' && value) {
    const t = Date.parse(value)
    if (!Number.isNaN(t)) return Math.floor(t / 1000)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
