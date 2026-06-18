#!/usr/bin/env node
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadDotenv(resolve(root, '.cf-worker.env'))

const method = (process.argv[2] || 'GET').toUpperCase()
const defaultAccount = process.env.CF_TEAMPLUS_ACCOUNT_ID || 'default'
const path = process.argv[3] || `/v1/sessions/${encodeURIComponent(defaultAccount)}/status`
const body = process.argv[4] || ''

const workerUrl = requiredEnv('CF_TEAMPLUS_WORKER_URL').replace(/\/+$/, '')
const secret = requiredEnv('CF_TEAMPLUS_UPLOAD_SECRET')
const endpoint = `${workerUrl}${path.startsWith('/') ? path : `/${path}`}`
const url = new URL(endpoint)
const timestamp = String(Math.floor(Date.now() / 1000))
const message = [method, url.pathname, timestamp, body].join('\n')
const signature = createHmac('sha256', secret).update(message).digest('hex')

const res = await fetch(endpoint, {
  method,
  headers: {
    'content-type': 'application/json',
    'x-teamplus-timestamp': timestamp,
    'x-teamplus-signature': signature,
  },
  body: method === 'GET' ? undefined : body,
})
console.log(await res.text())
if (!res.ok) process.exit(1)

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
