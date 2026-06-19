export { TeamplusSession } from './session'

import { signViewerToken, verifyApiKey, verifySignedRequest, verifyViewerToken } from './auth'
import { selectRecentMessages } from './turso'
import type { CookieUpload, TeamplusSession } from './session'

// Hard cap on attachment viewer links: one week.
const VIEWER_MAX_TTL_S = 7 * 24 * 3600
// Read-API time window: default 24h, hard cap one week.
const LOGS_DEFAULT_HOURS = 24
const LOGS_MAX_HOURS = 7 * 24
const LOGS_MAX_ROWS = 2000

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx)
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    const accountId = env.DEFAULT_ACCOUNT_ID || 'default'
    const stub = env.TEAMPLUS_SESSION.getByName(accountId)
    ctx.waitUntil(stub.nudge())
  },
} satisfies ExportedHandler<Env>

async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true })
  }

  // Public, token-gated attachment viewer (links expire within a week).
  if (request.method === 'GET' && url.pathname === '/a') {
    return serveAttachment(url, env)
  }

  // Read-only log API, gated by TEAMPLUS_DB_KEY.
  if (request.method === 'GET' && url.pathname === '/v1/logs') {
    return serveLogs(request, url, env)
  }

  const route = matchSessionRoute(url.pathname)
  if (!route) return json({ error: 'not found' }, 404)

  const bodyText = request.method === 'GET' ? '' : await request.text()
  try {
    await verifySignedRequest(request, env.COOKIE_UPLOAD_SECRET, bodyText)
  } catch (err) {
    return json({ error: String(err) }, 401)
  }

  const stub = env.TEAMPLUS_SESSION.getByName(route.accountId)
  return dispatchSessionRoute(request.method, route.action, bodyText, stub)
}

async function dispatchSessionRoute(
  method: string,
  action: string,
  bodyText: string,
  stub: DurableObjectStub<TeamplusSession>,
): Promise<Response> {
  try {
    if (method === 'GET' && action === 'status') {
      return json(await stub.status())
    }
    if (method === 'POST' && action === 'cookies') {
      const upload = JSON.parse(bodyText) as CookieUpload
      return json(await stub.updateSession(upload))
    }
    if (method === 'POST' && action === 'start') {
      return json(await stub.start())
    }
    if (method === 'POST' && action === 'stop') {
      return json(await stub.stop())
    }
    if (method === 'POST' && action === 'nudge') {
      return json(await stub.nudge())
    }
    if (method === 'POST' && action === 'send') {
      const body = JSON.parse(bodyText) as {
        to?: number
        chatId?: string
        text: string
        channelType?: number
        replyBatchId?: string
      }
      return json(await stub.send(body))
    }
    if (method === 'POST' && action === 'backfill-attachments') {
      const body = bodyText ? (JSON.parse(bodyText) as { limit?: number }) : {}
      return json(await stub.backfillAttachments(body.limit))
    }
    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

function matchSessionRoute(pathname: string): { accountId: string; action: string } | null {
  const match = /^\/v1\/sessions\/([^/]+)\/(cookies|status|start|stop|nudge|send|backfill-attachments)$/.exec(pathname)
  if (!match) return null
  return {
    accountId: decodeURIComponent(match[1]!),
    action: match[2]!,
  }
}

async function serveLogs(request: Request, url: URL, env: Env): Promise<Response> {
  const presented =
    url.searchParams.get('key') ??
    request.headers.get('x-api-key') ??
    bearerToken(request) ??
    ''
  if (!verifyApiKey(env.TEAMPLUS_DB_KEY, presented)) {
    return json({ error: 'unauthorized' }, 401)
  }

  // Window: ?days=N or ?hours=N; default 24h, hard-capped at one week.
  let hours = LOGS_DEFAULT_HOURS
  const daysParam = url.searchParams.get('days')
  const hoursParam = url.searchParams.get('hours')
  if (daysParam !== null) hours = Number(daysParam) * 24
  else if (hoursParam !== null) hours = Number(hoursParam)
  if (!Number.isFinite(hours) || hours <= 0) hours = LOGS_DEFAULT_HOURS
  hours = Math.min(hours, LOGS_MAX_HOURS)

  let limit = Number(url.searchParams.get('limit') ?? LOGS_MAX_ROWS)
  if (!Number.isFinite(limit) || limit <= 0) limit = LOGS_MAX_ROWS
  limit = Math.min(limit, LOGS_MAX_ROWS)

  const sinceMs = Date.now() - hours * 3_600_000
  const rows = await selectRecentMessages(env, sinceMs, limit)

  const exp = String(Math.floor(Date.now() / 1000) + VIEWER_MAX_TTL_S)
  const messages = []
  for (const r of rows) {
    let attachment = null
    if (r.attachmentKey) {
      const sig = await signViewerToken(env.COOKIE_UPLOAD_SECRET, r.attachmentKey, exp)
      attachment = {
        name: r.attachmentName,
        url: `${url.origin}/a?key=${encodeURIComponent(r.attachmentKey)}&exp=${exp}&sig=${sig}`,
      }
    }
    messages.push({
      id: r.batchId,
      ts: new Date(r.teamplusTsMs ?? r.receivedAtMs).toISOString(),
      direction: r.direction,
      channel_type: r.channelType,
      chat_id: r.chatId,
      chat_name: r.chatName,
      sender_id: r.senderId,
      sender_name: r.senderName,
      msg_type: r.msgType,
      content: r.content,
      attachment,
    })
  }

  return json({
    since: new Date(sinceMs).toISOString(),
    window_hours: hours,
    count: messages.length,
    messages,
  })
}

function bearerToken(request: Request): string | null {
  const h = request.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1]! : null
}

async function serveAttachment(url: URL, env: Env): Promise<Response> {
  const key = url.searchParams.get('key') ?? ''
  const expRaw = url.searchParams.get('exp') ?? ''
  const sig = url.searchParams.get('sig') ?? ''
  const exp = Number(expRaw)
  const nowS = Math.floor(Date.now() / 1000)

  if (!key || !key.startsWith('attachments/') || !Number.isFinite(exp)) {
    return json({ error: 'bad request' }, 400)
  }
  if (nowS >= exp) return json({ error: 'link expired' }, 410)
  // Reject links minted to live longer than a week, regardless of the secret.
  if (exp - nowS > VIEWER_MAX_TTL_S + 60) return json({ error: 'expiry too far' }, 400)
  if (!(await verifyViewerToken(env.COOKIE_UPLOAD_SECRET, key, expRaw, sig))) {
    return json({ error: 'invalid signature' }, 403)
  }

  const obj = await env.ATTACHMENTS.get(key)
  if (!obj) return json({ error: 'not found' }, 404)

  const headers = new Headers()
  headers.set('content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream')
  const showName = obj.customMetadata?.showName
  if (showName) {
    headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(showName)}`)
  }
  // Cache only until the link's own expiry, capped so it never outlives the token.
  headers.set('cache-control', `private, max-age=${Math.min(exp - nowS, 3600)}`)
  return new Response(obj.body, { headers })
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}
