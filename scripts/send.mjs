#!/usr/bin/env node
// Send a TeamPlus message via the worker (cloud — no local daemon needed).
//
//   ./scripts/send.mjs --to 1344 --text "晚點回你"            # DM to a peer userNo
//   ./scripts/send.mjs --chat-id 1049_1344 --text "…"         # explicit DM chat id
//   ./scripts/send.mjs --chat-id <group-guid> --text "…"      # group (auto-detected)
//
// Chat id shaped "n_n" is a DM (channelType 0); anything else (a GUID) is a
// group (channelType 1). Admin-signed with CF_TEAMPLUS_UPLOAD_SECRET.
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadDotenv(resolve(root, '.cf-worker.env'))

const args = parseArgs(process.argv.slice(2))
if (!args.text || (args.to == null && !args['chat-id'])) {
  console.error('usage: send.mjs --to <userNo> --text "message"  [or --chat-id <id>]')
  process.exit(1)
}

const workerUrl = requiredEnv('CF_TEAMPLUS_WORKER_URL').replace(/\/+$/, '')
const secret = requiredEnv('CF_TEAMPLUS_UPLOAD_SECRET')
const account = process.env.CF_TEAMPLUS_ACCOUNT_ID || 'default'
const path = `/v1/sessions/${encodeURIComponent(account)}/send`
const isGroup = args['chat-id'] && !/^\d+_\d+$/.test(args['chat-id'])
const body = JSON.stringify({
  ...(args.to != null ? { to: Number(args.to) } : {}),
  ...(args['chat-id'] ? { chatId: args['chat-id'] } : {}),
  ...(isGroup ? { channelType: 1 } : {}),
  text: args.text,
})

const ts = String(Math.floor(Date.now() / 1000))
const sig = createHmac('sha256', secret).update(['POST', path, ts, body].join('\n')).digest('hex')
const res = await fetch(`${workerUrl}${path}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-teamplus-timestamp': ts,
    'x-teamplus-signature': sig,
  },
  body,
})
const out = await res.json().catch(() => ({}))
const ok = res.ok && out.isSuccess
console.log(ok ? `✓ sent → ${out.chatId} (batch ${out.batchId})` : `✗ failed: ${JSON.stringify(out)}`)
process.exit(ok ? 0 : 1)

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].replace(/^--/, '')
    if (a === 'to' || a === 'text' || a === 'chat-id') o[a] = argv[++i]
    else {
      console.error(`unknown arg: ${argv[i]}`)
      process.exit(1)
    }
  }
  return o
}

function loadDotenv(path) {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [k, ...rest] = line.split('=')
    const v = rest.join('=').trim().replace(/^"|"$/g, '')
    if (k && process.env[k] === undefined) process.env[k] = v
  }
}

function requiredEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required; create .cf-worker.env first`)
  return v
}
