import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(HERE)

/**
 * TeamPlus instance base URL (origin, no trailing slash), e.g.
 * https://team.your-org.example. Configured via the TEAMPLUS_BASE env var
 * (loaded from .env) so no organisation URL is hardcoded. Every TeamPlus
 * endpoint + the cookie domain is derived from it.
 */
function resolveTeamplusBase(): string {
  const base = (process.env.TEAMPLUS_BASE ?? '').trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error('TEAMPLUS_BASE is not set — copy .env.example to .env and set it')
  }
  return base
}

export const TEAMPLUS_BASE = resolveTeamplusBase()
export const TEAMPLUS_HOST = new URL(TEAMPLUS_BASE).host
/** WebSocket URL for the `ws` client (https → wss). */
export const TEAMPLUS_WS_URL = `${TEAMPLUS_BASE.replace(/^http/, 'ws')}/AppService/WSService.ashx`
export const TEAMPLUS_TOKEN_URL = `${TEAMPLUS_BASE}/AppService/WSService.ashx`

export const COOKIES_FILE = join(ROOT, 'cookies.json')
export const TG_FILE = join(ROOT, '.telegram.json')
export const CONFIG_FILE = join(ROOT, '.config.json')
export const STATE_DIR = join(ROOT, 'state')
export const CURSORS_FILE = join(STATE_DIR, 'cursors.json')

export type Cookies = Record<string, string>
export type TelegramConfig = { token: string; chat_id: string }
export type ServerConfig = {
  my_id: number
  muted_chats: string[]
  muted_senders: string[]
  /** When non-empty, the daemon appends this tag to every outbound TeamPlus message. */
  test_tag: string
}

export async function loadCookies(): Promise<Cookies> {
  const raw = await readFile(COOKIES_FILE, 'utf8')
  const arr = JSON.parse(raw) as Array<{ domain?: string; name: string; value: string }>
  const jar: Cookies = {}
  for (const c of arr) {
    if (c.domain === TEAMPLUS_HOST) jar[c.name] = c.value
  }
  return jar
}

export async function loadTelegramConfig(): Promise<TelegramConfig> {
  const raw = await readFile(TG_FILE, 'utf8')
  const cfg = JSON.parse(raw) as TelegramConfig
  if (!cfg.token || !cfg.chat_id) {
    throw new Error(`${TG_FILE} must contain token and chat_id`)
  }
  return cfg
}

export async function loadServerConfig(): Promise<ServerConfig> {
  const raw = await readFile(CONFIG_FILE, 'utf8')
  const parsed = JSON.parse(raw) as Partial<ServerConfig>
  if (typeof parsed.my_id !== 'number' || !Number.isFinite(parsed.my_id)) {
    throw new Error(`${CONFIG_FILE} must contain numeric my_id`)
  }
  return {
    my_id: parsed.my_id,
    muted_chats: Array.isArray(parsed.muted_chats) ? parsed.muted_chats.map(String) : [],
    muted_senders: Array.isArray(parsed.muted_senders) ? parsed.muted_senders.map(String) : [],
    test_tag: typeof parsed.test_tag === 'string' ? parsed.test_tag : '',
  }
}

/** Mutable in-process config wrapper that persists changes to .config.json. */
export class ConfigStore {
  private data: ServerConfig
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(data: ServerConfig) {
    this.data = data
  }

  static async load(): Promise<ConfigStore> {
    return new ConfigStore(await loadServerConfig())
  }

  get myId(): number {
    return this.data.my_id
  }

  get testTag(): string {
    return this.data.test_tag
  }

  /** Apply the test tag to outbound text if configured. */
  decorate(text: string): string {
    if (!this.data.test_tag) return text
    return `${text}\n\n${this.data.test_tag}`
  }

  isMuted(chatId: string, senderId: number | string): boolean {
    if (this.data.muted_chats.includes(chatId)) return true
    if (this.data.muted_senders.includes(String(senderId))) return true
    return false
  }

  /** Add an entry to muted_chats. Returns true if added; false if already muted. */
  muteChat(chatId: string): boolean {
    if (!chatId) return false
    if (this.data.muted_chats.includes(chatId)) return false
    this.data.muted_chats.push(chatId)
    return true
  }

  unmuteChat(chatId: string): boolean {
    const i = this.data.muted_chats.indexOf(chatId)
    if (i < 0) return false
    this.data.muted_chats.splice(i, 1)
    return true
  }

  muteSender(userNo: string): boolean {
    const v = String(userNo)
    if (!v) return false
    if (this.data.muted_senders.includes(v)) return false
    this.data.muted_senders.push(v)
    return true
  }

  unmuteSender(userNo: string): boolean {
    const v = String(userNo)
    const i = this.data.muted_senders.indexOf(v)
    if (i < 0) return false
    this.data.muted_senders.splice(i, 1)
    return true
  }

  mutedChats(): string[] {
    return this.data.muted_chats.slice()
  }

  mutedSenders(): string[] {
    return this.data.muted_senders.slice()
  }

  save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${CONFIG_FILE}.tmp`
      const payload = JSON.stringify(this.data, null, 2) + '\n'
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, CONFIG_FILE)
    }).catch(err => {
      process.stderr.write(`config: save failed: ${err}\n`)
    })
    return this.writeQueue
  }
}

export function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}
