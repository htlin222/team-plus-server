import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { STATE_DIR } from './config.ts'

export const EVENTS_FILE = join(STATE_DIR, 'events.jsonl')
export const COMMANDS_FILE = join(STATE_DIR, 'commands.jsonl')
export const BRIDGE_HEARTBEAT = join(STATE_DIR, 'bridge.alive')

const writeLocks: Map<string, Promise<unknown>> = new Map()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  writeLocks.set(key, next.catch(() => undefined))
  return next
}

export async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await withLock(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    const fd = await open(path, 'a')
    try {
      await fd.write(JSON.stringify(payload) + '\n')
    } finally {
      await fd.close()
    }
  })
}

export async function appendEvent(payload: unknown): Promise<void> {
  await appendJsonl(EVENTS_FILE, payload)
}

export async function appendCommand(payload: unknown): Promise<void> {
  await appendJsonl(COMMANDS_FILE, payload)
}

async function readOffset(offsetFile: string): Promise<number> {
  try {
    const raw = await readFile(offsetFile, 'utf8')
    const n = parseInt(raw.trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

async function writeOffset(offsetFile: string, offset: number): Promise<void> {
  const tmp = `${offsetFile}.tmp`
  await writeFile(tmp, String(offset), 'utf8')
  await rename(tmp, offsetFile)
}

async function fileSize(path: string): Promise<number> {
  try {
    const st = await stat(path)
    return st.size
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0
    throw err
  }
}

async function readChunk(path: string, from: number, to: number): Promise<string> {
  if (to <= from) return ''
  const fd = await open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(to - from)
    await fd.read(buf, 0, buf.length, from)
    return buf.toString('utf8')
  } finally {
    await fd.close()
  }
}

export type TailHandle = {
  close: () => void
}

/**
 * Tail an append-only JSONL file. Each complete line is parsed and passed to
 * onLine. Byte offset is persisted to <path>.offset so restarts don't
 * re-deliver. The watcher uses fs.watch + a polling fallback so it survives
 * editor saves / atomic renames.
 */
export function tailJsonl(
  path: string,
  onLine: (value: unknown, raw: string) => void | Promise<void>,
  opts: { offsetFile?: string; pollMs?: number; onError?: (err: unknown) => void } = {},
): TailHandle {
  const offsetFile = opts.offsetFile ?? `${path}.offset`
  const pollMs = opts.pollMs ?? 1500
  const onError = opts.onError ?? (() => undefined)

  let offset = 0
  let pending = ''
  let stopped = false
  let inFlight = false
  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const size = await fileSize(path)
      if (size < offset) {
        // file truncated/rotated; reset
        offset = 0
        pending = ''
      }
      if (size > offset) {
        const chunk = await readChunk(path, offset, size)
        offset = size
        pending += chunk
        let nl: number
        while ((nl = pending.indexOf('\n')) !== -1) {
          const raw = pending.slice(0, nl)
          pending = pending.slice(nl + 1)
          if (raw.length === 0) continue
          try {
            const value = JSON.parse(raw)
            await onLine(value, raw)
          } catch (err) {
            onError(err)
          }
        }
        await writeOffset(offsetFile, offset)
      }
    } catch (err) {
      onError(err)
    } finally {
      inFlight = false
    }
  }

  ;(async () => {
    offset = await readOffset(offsetFile)
    if (existsSync(path)) {
      try {
        watcher = fsWatch(path, { persistent: true }, () => {
          void tick()
        })
      } catch {
        /* fallback to polling */
      }
    }
    timer = setInterval(() => {
      void tick()
    }, pollMs)
    // Initial pass to drain anything written while we were down.
    void tick()
  })().catch(onError)

  return {
    close: () => {
      stopped = true
      if (timer) clearInterval(timer)
      if (watcher) watcher.close()
    },
  }
}

/** Touch the bridge heartbeat file so the daemon knows Claude is connected. */
export async function touchHeartbeat(path = BRIDGE_HEARTBEAT): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const now = new Date()
  // open with 'w' to update mtime even if it already exists
  await writeFile(path, now.toISOString(), 'utf8')
}

export async function bridgeAlive(maxAgeMs = 15_000, path = BRIDGE_HEARTBEAT): Promise<boolean> {
  try {
    const st = await stat(path)
    return Date.now() - st.mtimeMs < maxAgeMs
  } catch {
    return false
  }
}
