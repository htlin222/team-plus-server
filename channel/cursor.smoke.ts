// Smoke test for the cbId='' regression.
// Run with: bun ./channel/cursor.smoke.ts
import { CursorStore } from './cursor.ts'

const empty = {
  myId: 0,
  chats: {},
  senderNames: {},
  callbacks: {},
}
// Bypass `private constructor` at runtime — TS access modifier only.
const store = new (CursorStore as any)(structuredClone(empty)) as CursorStore

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
  console.log(`ok   ${msg}`)
}

const baseEntry = {
  chatId: 'c1',
  msgId: 'm1',
  senderId: 1,
  senderName: 'A',
  content: 'hi',
  ts: Date.now() / 1000,
  telegramMessageId: null,
}

const a = store.recordCallback({ ...baseEntry, cbId: '' })
assert(typeof a.cbId === 'string' && a.cbId.length === 8, `empty cbId is replaced (got "${a.cbId}")`)

const b = store.recordCallback({ ...baseEntry })
assert(typeof b.cbId === 'string' && b.cbId.length === 8, `undefined cbId is replaced (got "${b.cbId}")`)

const c = store.recordCallback({ ...baseEntry, cbId: 'preset123' })
assert(c.cbId === 'preset123', `preset cbId is preserved (got "${c.cbId}")`)

const fetched = store.getCallback(a.cbId)
assert(fetched?.cbId === a.cbId, 'getCallback round-trip works')

const orphan = store.getCallback('')
assert(orphan === undefined, 'no entry stored under empty key')

console.log('\nall smoke checks passed')
