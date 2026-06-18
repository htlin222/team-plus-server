export { TeamplusSession } from './session'

import { verifySignedRequest } from './auth'
import type { CookieUpload, TeamplusSession } from './session'

type HandlerResult = Response | Promise<Response>

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
    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

function matchSessionRoute(pathname: string): { accountId: string; action: string } | null {
  const match = /^\/v1\/sessions\/([^/]+)\/(cookies|status|start|stop|nudge)$/.exec(pathname)
  if (!match) return null
  return {
    accountId: decodeURIComponent(match[1]!),
    action: match[2]!,
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}
