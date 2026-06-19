#!/usr/bin/env node
// Friendly CLI over the worker's GET /v1/logs read API.
//
//   ./scripts/logs.mjs                 last 24h (default)
//   ./scripts/logs.mjs --hours 6
//   ./scripts/logs.mjs --days 7        (7 = server-enforced max)
//   ./scripts/logs.mjs --from 邱子玲    only this sender (substring match)
//   ./scripts/logs.mjs --in            only inbound (others → you)
//   ./scripts/logs.mjs --out           only outbound (you → others)
//   ./scripts/logs.mjs --files         only messages with an attachment
//   ./scripts/logs.mjs --url           print attachment viewer URLs
//   ./scripts/logs.mjs --limit 50
//   ./scripts/logs.mjs --json          raw JSON (after filters)
//
// Key + worker URL are read from env, then worker/.dev.vars / .cf-worker.env.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n').replace(/^\/\/ ?/gm, ''))
  process.exit(0)
}

const key = process.env.TEAMPLUS_DB_KEY || fromFile('worker/.dev.vars', 'TEAMPLUS_DB_KEY')
const workerUrl = (process.env.CF_TEAMPLUS_WORKER_URL || fromFile('.cf-worker.env', 'CF_TEAMPLUS_WORKER_URL') || '').replace(/\/+$/, '')
if (!key) fail('TEAMPLUS_DB_KEY not found (set env or worker/.dev.vars)')
if (!workerUrl) fail('CF_TEAMPLUS_WORKER_URL not found (set env or .cf-worker.env)')

const qs = new URLSearchParams()
if (opts.days != null) qs.set('days', String(opts.days))
else if (opts.hours != null) qs.set('hours', String(opts.hours))
if (opts.limit != null) qs.set('limit', String(opts.limit))

const res = await fetch(`${workerUrl}/v1/logs?${qs}`, { headers: { 'x-api-key': key } })
if (!res.ok) fail(`HTTP ${res.status}: ${await res.text()}`)
const data = await res.json()

let msgs = data.messages
if (opts.from) msgs = msgs.filter(m => (m.sender_name || '').includes(opts.from) || String(m.sender_id) === opts.from)
if (opts.in) msgs = msgs.filter(m => m.direction === 'in')
if (opts.out) msgs = msgs.filter(m => m.direction === 'out')
if (opts.files) msgs = msgs.filter(m => m.attachment)

if (opts.json) {
  console.log(JSON.stringify({ ...data, count: msgs.length, messages: msgs }, null, 2))
  process.exit(0)
}

console.error(`window ${data.window_hours}h · ${msgs.length}/${data.count} shown\n`)
for (const m of msgs.slice().reverse()) {
  const t = m.ts.slice(5, 16).replace('T', ' ')
  const dir = m.direction === 'in' ? '←' : '→'
  const who = m.sender_name || m.sender_id
  const body = m.content || (m.attachment ? `📎 ${m.attachment.name}` : '(non-text)')
  console.log(`${t} ${dir} ${who}: ${body}`)
  if (opts.url && m.attachment) console.log(`           ${m.attachment.url}`)
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--in') o.in = true
    else if (a === '--out') o.out = true
    else if (a === '--files') o.files = true
    else if (a === '--url') o.url = true
    else if (a === '--json') o.json = true
    else if (a === '--hours') o.hours = Number(argv[++i])
    else if (a === '--days') o.days = Number(argv[++i])
    else if (a === '--limit') o.limit = Number(argv[++i])
    else if (a === '--from') o.from = argv[++i]
    else fail(`unknown arg: ${a} (try --help)`)
  }
  return o
}

function fromFile(rel, name) {
  const p = resolve(root, rel)
  if (!existsSync(p)) return ''
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#') || !line.includes('=')) continue
    const [k, ...rest] = line.split('=')
    if (k.trim() === name) return rest.join('=').trim().replace(/^"|"$/g, '')
  }
  return ''
}

function fail(msg) {
  console.error(`logs: ${msg}`)
  process.exit(1)
}
