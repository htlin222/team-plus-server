const WS_PATH = '/AppService/WSService.ashx'

/**
 * Resolve the TeamPlus instance base URL (origin, no trailing slash) from the
 * worker env. Configured per-deployment via TEAMPLUS_BASE — never hardcoded,
 * so this repo can target any TeamPlus instance. See .dev.vars.example.
 */
export function resolveTeamplusBase(env: Env): string {
  const base = (env.TEAMPLUS_BASE ?? '').trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error(
      'TEAMPLUS_BASE is not configured — set it in worker/.dev.vars and push it as a secret',
    )
  }
  return base
}

/**
 * WebSocket endpoint. In Cloudflare Workers the WS is opened via a fetch()
 * upgrade, which uses the http(s) URL (NOT ws(s)) plus an Upgrade header.
 */
export function teamplusWsUrl(base: string): string {
  return `${base}${WS_PATH}`
}

/** getToken endpoint derived from the base. */
export function teamplusTokenUrl(base: string): string {
  return `${base}${WS_PATH}`
}

/** Cookie domain to keep, derived from the base host (e.g. team.example.org). */
export function teamplusHost(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return ''
  }
}

export type CookieRecord = {
  domain?: string
  name: string
  value: string
}

export type TeamplusMessage = {
  eventKey: string
  chatId: string
  chatName: string | null
  channelType: number | null
  msgId: string | null
  batchId: string | null
  messageSn: number | null
  senderId: number | null
  senderName: string | null
  direction: 'in' | 'out'
  msgType: number | null
  content: string | null
  content2: string | null
  teamplusTsMs: number | null
  receivedAtMs: number
  rawJson: string
}

export function buildCookieHeader(
  cookies: CookieRecord[] | Record<string, string>,
  host: string,
): string {
  const pairs = Array.isArray(cookies)
    ? cookies
      .filter(c => c.domain === host && c.name && c.value)
      .map(c => [c.name, c.value] as const)
    : Object.entries(cookies)
  return pairs.map(([name, value]) => `${name}=${value}`).join('; ')
}

export async function getTeamplusToken(base: string, cookieHeader: string): Promise<string> {
  const res = await fetch(teamplusTokenUrl(base), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      cookie: cookieHeader,
    },
    body: 'Ask=getToken',
  })
  const data = (await res.json()) as { IsSuccess?: boolean; Data?: string; Description?: string }
  if (!data.Data) {
    throw new Error(`TeamPlus getToken failed: ${JSON.stringify(data)}`)
  }
  return data.Data
}

export async function normalizeTeamplusEvent(
  rawJson: string,
  myId: number | null,
): Promise<TeamplusMessage | null> {
  let parsed: { Event?: string; Ask?: string; Data?: Record<string, unknown> }
  try {
    parsed = JSON.parse(rawJson) as typeof parsed
  } catch {
    return null
  }

  const event = parsed.Event ?? parsed.Ask ?? ''
  if (event !== 'IM_CHAT:NEW_MESSAGE') return null

  const data = parsed.Data
  if (!data || typeof data !== 'object') return null

  const chatId = str(data.ChatID)
  if (!chatId) return null

  const senderId = num(data.SenderID)
  const batchId = str(data.BatchID ?? data.batchID)
  const msgId = str(data.MsgID ?? data.MessageID ?? data.ID)
  const messageSn = num(data.MessageSN ?? data.SN)
  const msgType = num(data.MsgType)
  const content = str(data.Content ?? data.MsgContent)
  const content2 = strOrJson(data.Content2)
  const teamplusTsMs = parseTeamplusTs(
    data.SendTime ?? data.CreateTimeUTCValue ?? data.CreateTimeUTC ?? data.CreateTime,
  )
  const inOut = bool(data.InOut)
  const direction = inOut === true || (myId !== null && senderId === myId) ? 'out' : 'in'

  return {
    eventKey: await eventKey({ chatId, batchId, msgId, messageSn, rawJson }),
    chatId,
    chatName: str(data.ChatName ?? data.ChatLogName),
    channelType: num(data.ChannelType),
    msgId,
    batchId,
    messageSn,
    senderId,
    senderName: str(data.SenderName ?? data.SenderRealName ?? data.SenderNickName),
    direction,
    msgType,
    content,
    content2,
    teamplusTsMs,
    receivedAtMs: Date.now(),
    rawJson,
  }
}

async function eventKey(input: {
  chatId: string
  batchId: string | null
  msgId: string | null
  messageSn: number | null
  rawJson: string
}): Promise<string> {
  if (input.batchId) return `batch:${input.batchId}`
  if (input.messageSn !== null) return `sn:${input.chatId}:${input.messageSn}`
  if (input.msgId) return `msg:${input.chatId}:${input.msgId}`
  return `hash:${await sha256Hex(input.rawJson)}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function str(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value)
  return text ? text : null
}

function strOrJson(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  return null
}

function parseTeamplusTs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000)
  }
  if (typeof value === 'string' && value) {
    const n = Number(value)
    if (Number.isFinite(n)) return parseTeamplusTs(n)
    const t = Date.parse(value)
    if (!Number.isNaN(t)) return t
  }
  return null
}
