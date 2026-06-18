import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from './config.ts'

export const DRAFTS_FILE = join(STATE_DIR, 'drafts.json')

export type DraftStatus = 'pending' | 'sent' | 'cancelled'

export type Draft = {
  id: string
  chatId: string
  channelType: number
  recipientMobile: string
  senderName: string
  sourceMsgId: string | null
  text: string
  status: DraftStatus
  /** Telegram message id of the approval prompt, so we can edit it on result. */
  telegramMessageId: number | null
  createdAt: number
  sentAt: number | null
  errorReason?: string
}

type DraftsFile = {
  drafts: Record<string, Draft>
}

function shortId(): string {
  // base36 of randomUUID slices is short, easy on the 64-byte callback_data limit
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

export class DraftsStore {
  private data: DraftsFile
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(data: DraftsFile) {
    this.data = data
  }

  static async load(): Promise<DraftsStore> {
    let data: DraftsFile = { drafts: {} }
    try {
      const raw = await readFile(DRAFTS_FILE, 'utf8')
      const parsed = JSON.parse(raw) as Partial<DraftsFile>
      data = { drafts: parsed.drafts ?? {} }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        process.stderr.write(`drafts: load failed (${err}); starting fresh\n`)
      }
    }
    return new DraftsStore(data)
  }

  enqueue(input: {
    chatId: string
    channelType: number
    recipientMobile: string
    senderName: string
    sourceMsgId: string | null
    text: string
  }): Draft {
    const id = shortId()
    const draft: Draft = {
      id,
      chatId: input.chatId,
      channelType: input.channelType,
      recipientMobile: input.recipientMobile,
      senderName: input.senderName,
      sourceMsgId: input.sourceMsgId,
      text: input.text,
      status: 'pending',
      telegramMessageId: null,
      createdAt: Math.floor(Date.now() / 1000),
      sentAt: null,
    }
    this.data.drafts[id] = draft
    return draft
  }

  get(id: string): Draft | undefined {
    return this.data.drafts[id]
  }

  setTelegramMessageId(id: string, messageId: number): void {
    const d = this.data.drafts[id]
    if (d) d.telegramMessageId = messageId
  }

  markSent(id: string): Draft | undefined {
    const d = this.data.drafts[id]
    if (!d) return undefined
    d.status = 'sent'
    d.sentAt = Math.floor(Date.now() / 1000)
    return d
  }

  markCancelled(id: string): Draft | undefined {
    const d = this.data.drafts[id]
    if (!d) return undefined
    d.status = 'cancelled'
    return d
  }

  markFailed(id: string, reason: string): Draft | undefined {
    const d = this.data.drafts[id]
    if (!d) return undefined
    d.status = 'pending'
    d.errorReason = reason
    return d
  }

  /** Drop drafts older than 7 days that aren't pending. */
  prune(maxAgeSec = 7 * 24 * 3600): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec
    let removed = 0
    for (const [id, d] of Object.entries(this.data.drafts)) {
      if (d.status !== 'pending' && d.createdAt < cutoff) {
        delete this.data.drafts[id]
        removed += 1
      }
    }
    return removed
  }

  save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(STATE_DIR, { recursive: true })
      const tmp = `${DRAFTS_FILE}.tmp`
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await rename(tmp, DRAFTS_FILE)
    }).catch(err => {
      process.stderr.write(`drafts: save failed: ${err}\n`)
    })
    return this.writeQueue
  }
}
