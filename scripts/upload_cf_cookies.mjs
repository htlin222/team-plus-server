#!/usr/bin/env node
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadDotenv(resolve(root, '.cf-worker.env'))

const workerUrl = requiredEnv('CF_TEAMPLUS_WORKER_URL').replace(/\/+$/, '')
const accountId = process.env.CF_TEAMPLUS_ACCOUNT_ID || 'default'
const secret = requiredEnv('CF_TEAMPLUS_UPLOAD_SECRET')

const cookies = JSON.parse(await readFile(resolve(root, 'cookies.json'), 'utf8'))
const config = JSON.parse(await readFile(resolve(root, '.config.json'), 'utf8'))
const endpoint = `${workerUrl}/v1/sessions/${encodeURIComponent(accountId)}/cookies`
const body = JSON.stringify({
  cookies,
  my_id: config.my_id,
  updated_at_ms: Date.now(),
  start: true,
})

const url = new URL(endpoint)
const timestamp = String(Math.floor(Date.now() / 1000))
const message = ['POST', url.pathname, timestamp, body].join('\n')
const signature = createHmac('sha256', secret).update(message).digest('hex')

const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-teamplus-timestamp': timestamp,
    'x-teamplus-signature': signature,
  },
  body,
})
const text = await res.text()
if (!res.ok) {
  console.error(text)
  process.exit(1)
}
console.log(text)

function loadDotenv(path) {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [key, ...rest] = line.split('=')
    const value = rest.join('=').trim().replace(/^"|"$/g, '')
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required; create .cf-worker.env first`)
  return value
}
