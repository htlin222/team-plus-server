#!/usr/bin/env node
// Worker health probe + daily report. Reads everything from env:
//   CF_TEAMPLUS_WORKER_URL, CF_TEAMPLUS_UPLOAD_SECRET   (required)
//   CF_TEAMPLUS_ACCOUNT_ID                              (default "default")
//   TURSO_URL, TURSO_AUTH_TOKEN                          (optional — adds counts)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID                 (optional — sends report)
//
// Exits non-zero when the worker is unhealthy (so CI flags it too).
import { createHmac } from 'node:crypto'

const workerUrl = required('CF_TEAMPLUS_WORKER_URL').replace(/\/+$/, '')
const secret = required('CF_TEAMPLUS_UPLOAD_SECRET')
const accountId = process.env.CF_TEAMPLUS_ACCOUNT_ID || 'default'

const status = await signedGet(`/v1/sessions/${encodeURIComponent(accountId)}/status`)
const cookieAgeH = status.cookieUpdatedAtMs
  ? (Date.now() - status.cookieUpdatedAtMs) / 3_600_000
  : Infinity
const lastMsgAgeH = status.lastMessageAtMs
  ? (Date.now() - status.lastMessageAtMs) / 3_600_000
  : Infinity

// Cookie should be refreshed twice a day; flag if older than 36h.
const problems = []
if (!status.connected) problems.push('WS not connected')
if (status.lastError) problems.push(`lastError: ${status.lastError}`)
if (cookieAgeH > 36) problems.push(`cookie stale (${cookieAgeH.toFixed(1)}h)`)
const healthy = problems.length === 0

let counts = null
if (process.env.TURSO_URL && process.env.TURSO_AUTH_TOKEN) {
  try {
    counts = await tursoCounts()
  } catch (err) {
    problems.push(`turso query failed: ${err}`)
  }
}

const icon = healthy ? '✅' : '🔴'
const lines = [
  `${icon} TeamPlus worker ${healthy ? 'healthy' : 'PROBLEM'}`,
  `connected: ${status.connected} · myId: ${status.myId ?? '—'}`,
  `cookie age: ${fmtAge(cookieAgeH)} · last msg: ${fmtAge(lastMsgAgeH)} ago`,
]
if (counts) {
  lines.push(
    `messages: ${counts.total} total · 24h: ${counts.last24}` +
      ` (${counts.in24} in / ${counts.out24} out, ${counts.files24} files)`,
  )
}
if (problems.length) lines.push(`⚠ ${problems.join('; ')}`)
const report = lines.join('\n')

console.log(report)
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n')
}

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  await sendTelegram(report).catch(err => console.error(`telegram send failed: ${err}`))
}

if (!healthy) process.exit(1)

// ── helpers ──────────────────────────────────────────────────────────
async function signedGet(path) {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = createHmac('sha256', secret).update(['GET', path, ts, ''].join('\n')).digest('hex')
  const res = await fetch(`${workerUrl}${path}`, {
    headers: { 'x-teamplus-timestamp': ts, 'x-teamplus-signature': sig },
  })
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`)
  return res.json()
}

async function tursoCounts() {
  const httpUrl = process.env.TURSO_URL.replace(/^libsql:/, 'https:').replace(/\/+$/, '')
  const t = "(strftime('%s','now')*1000 - 86400000)"
  const sql =
    'select count(*) as total, ' +
    `sum(case when received_at_ms > ${t} then 1 else 0 end) as last24, ` +
    `sum(case when received_at_ms > ${t} and direction='in' then 1 else 0 end) as in24, ` +
    `sum(case when received_at_ms > ${t} and direction='out' then 1 else 0 end) as out24, ` +
    `sum(case when received_at_ms > ${t} and attachment_key is not null then 1 else 0 end) as files24 ` +
    'from messages'
  const res = await fetch(`${httpUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }],
    }),
  })
  if (!res.ok) throw new Error(`turso ${res.status}`)
  const data = await res.json()
  const row = data.results[0].response.result.rows[0]
  const cell = i => Number(row[i]?.value ?? 0)
  return {
    total: cell(0),
    last24: cell(1),
    in24: cell(2),
    out24: cell(3),
    files24: cell(4),
  }
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
  })
  if (!res.ok) throw new Error(`telegram ${res.status}: ${await res.text()}`)
}

function fmtAge(h) {
  if (!Number.isFinite(h)) return 'n/a'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}
