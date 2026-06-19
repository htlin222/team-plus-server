#!/usr/bin/env node
// Mint a time-limited (1 week) viewable URL for an archived attachment.
//
//   ./scripts/attachment_url.mjs attachments/<batchID>/<file>   # by R2 key
//   ./scripts/attachment_url.mjs batch:<BATCHID>                # by event_key
//   ./scripts/attachment_url.mjs <BATCHID>                      # by batch_id
//
// The link is HMAC-signed with CF_TEAMPLUS_UPLOAD_SECRET (same secret the
// worker holds) and is rejected by the worker once it is older than a week.
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadDotenv(resolve(root, '.cf-worker.env'))

const workerUrl = requiredEnv('CF_TEAMPLUS_WORKER_URL').replace(/\/+$/, '')
const secret = requiredEnv('CF_TEAMPLUS_UPLOAD_SECRET')
const db = process.env.TEAMPLUS_DB || 'teamplus-messages'
const WEEK_S = 7 * 24 * 3600

const arg = process.argv[2]
if (!arg) {
  console.error('usage: attachment_url.mjs <attachment_key | event_key | batch_id>')
  process.exit(1)
}

let key = arg
if (!arg.startsWith('attachments/')) {
  // Treat as event_key or batch_id and look the R2 key up via the turso CLI.
  const id = arg.replace(/[^A-Za-z0-9:_-]/g, '')
  const sql = `select attachment_key from messages where (event_key='${id}' or batch_id='${id}') and attachment_key is not null limit 1;`
  const out = execFileSync('turso', ['db', 'shell', db, sql], { encoding: 'utf8' })
  const m = out.match(/attachments\/\S+/)
  if (!m) {
    console.error(`no archived attachment found for "${arg}"`)
    process.exit(1)
  }
  key = m[0]
}

const exp = Math.floor(Date.now() / 1000) + WEEK_S
const sig = createHmac('sha256', secret).update(`${key}\n${exp}`).digest('hex')
const link = `${workerUrl}/a?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`

console.log(link)
console.error(`valid until ${new Date(exp * 1000).toISOString()} (1 week)`)

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
