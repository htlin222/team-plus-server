#!/usr/bin/env bun
/**
 * TeamPlus → Telegram bridge daemon.
 *
 * Connects to TeamPlus WebSocket, forwards every inbound (non-self) message to
 * the configured Telegram bot DM with [Remind] / [Draft] inline buttons, and
 * coordinates with a Claude Code session via the bridge.ts MCP server through
 * append-only JSONL files in state/.
 */
import {
  ConfigStore,
  loadCookies,
  loadTelegramConfig,
  type Cookies,
  type TelegramConfig,
} from './config.ts'
import { CursorStore, type CallbackEntry } from './cursor.ts'
import { DraftsStore, type Draft } from './drafts.ts'
import {
  buildActionKeyboard,
  buildDraftKeyboard,
  formatCancelled,
  formatDraftPrompt,
  formatLive,
  formatSendFailed,
  formatSentResult,
} from './format.ts'
import {
  appendEvent,
  bridgeAlive,
  COMMANDS_FILE,
  tailJsonl,
} from './ipc.ts'
import { runTeamplusLoop } from './teamplus.ts'
import {
  answerCallback,
  editMessage,
  runTelegramLoop,
  sendTelegram,
  setBotCommands,
  type CallbackResult,
} from './telegram.ts'
import {
  loadChatRoomList,
  lookupContacts,
  sendChatMessage,
} from './teamplus_rest.ts'

function log(line: string): void {
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] ${line}\n`)
}

async function fireAndForget(label: string, p: Promise<unknown>): Promise<void> {
  try {
    await p
  } catch (err) {
    log(`${label}: ${err}`)
  }
}

async function main(): Promise<void> {
  const tg = await loadTelegramConfig()
  const serverCfg = await ConfigStore.load()
  log(`server: my_id=${serverCfg.myId} tg_chat=${tg.chat_id}`)

  const cursor = await CursorStore.load(serverCfg.myId)
  const drafts = await DraftsStore.load()

  await setBotCommands(tg).catch(err => {
    log(`server: setMyCommands failed (continuing): ${err}`)
  })

  await sendTelegram(tg, '🟢 TeamPlus bridge online').catch(err => {
    log(`server: hello send failed: ${err}`)
  })
  log('server: ✓ Telegram bot menu installed (/unread /action /chats /latest_person /latest_group /mute /unmute /muted /ping /help)')

  const forward = makeForwardChain()
  let cookies = await loadCookies()
  const refreshCookies = async () => {
    try {
      cookies = await loadCookies()
    } catch (err) {
      log(`server: cookie reload failed: ${err}`)
    }
  }

  // Per-id in-flight sender lookup (dedupes concurrent asks for the same id).
  const senderInflight = new Map<string, Promise<string | null>>()
  const ensureSenderName = async (senderId: number): Promise<string | null> => {
    const key = String(senderId)
    const cached = cursor.getSenderName(senderId)
    if (cached) return cached
    let p = senderInflight.get(key)
    if (!p) {
      p = (async () => {
        try {
          const map = await lookupContacts(cookies, [senderId])
          const info = map.get(key)
          if (info?.userName) {
            cursor.setSenderName(senderId, info.userName)
            await cursor.save()
            return info.userName
          }
        } catch (err) {
          log(`server: sender lookup ${key} failed: ${err}`)
        } finally {
          senderInflight.delete(key)
        }
        return null
      })()
      senderInflight.set(key, p)
    }
    return p
  }

  // Chat-name resolver: one shared in-flight loadChatRoomList for all unknowns;
  // refreshed at most once per 30s so a brand-new chat eventually gets a name.
  let chatNameRefreshAt = 0
  let chatNameInflight: Promise<void> | null = null
  const refreshChatNames = async (): Promise<void> => {
    if (chatNameInflight) return chatNameInflight
    if (Date.now() - chatNameRefreshAt < 30_000) return
    chatNameInflight = (async () => {
      try {
        const rooms = await loadChatRoomList(cookies)
        for (const r of rooms) {
          if (r.chatId && r.name) cursor.setName(r.chatId, r.name)
        }
        await cursor.save()
      } catch (err) {
        log(`server: refresh chat names failed: ${err}`)
      } finally {
        chatNameRefreshAt = Date.now()
        chatNameInflight = null
      }
    })()
    return chatNameInflight
  }

  // Best-effort: seed all chat names at startup so the first message in a known
  // group/team renders with the room name instead of the raw UUID.
  await refreshChatNames()

  const teamplus = runTeamplusLoop({
    myId: serverCfg.myId,
    cursor,
    log,
    onMessage: (chatId, _chatName, entry) => {
      // Enqueue synchronously to preserve arrival order in the bot DM, then
      // resolve sender + chat names inside the job before sending.
      void fireAndForget(
        'forward',
        forward(async () => {
          if (!entry.senderName) {
            const name = await ensureSenderName(entry.senderId)
            if (name) entry.senderName = name
          }
          const c = cursor.knownChats().find(k => k.chatId === chatId)?.cursor
          if (!c) return
          if (!c.name) await refreshChatNames()
          const line = formatLive(chatId, c, entry)
          const muted = serverCfg.isMuted(chatId, entry.senderId)
          await forwardWithButtons(tg, cursor, chatId, entry, line, !muted)
        }),
      )
    },
  })

  const telegram = runTelegramLoop({
    cfg: tg,
    cursor,
    serverCfg,
    log,
    cookies: () => cookies,
    onCallback: (data, query) =>
      handleCallback(data, query, {
        cfg: tg,
        cursor,
        drafts,
        cookies: () => cookies,
        myId: serverCfg.myId,
        decorate: (text: string) => serverCfg.decorate(text),
        log,
      }),
    onFreeText: async (text, msg) => {
      // Hand the user's free-text message to the bridge so it lands in the
      // active Claude session as a <channel> event. Ack only after we know
      // the bridge is alive so we never promise "處理中" with no listener.
      if (!(await bridgeAlive())) {
        await sendTelegram(
          tg,
          '❌ No Claude session attached.\n\nStart one with:\n' +
            'claude --dangerously-load-development-channels server:bridge',
        ).catch(() => undefined)
        return
      }
      void sendTelegram(tg, '收到，處理中…').catch(() => undefined)
      await appendEvent({
        type: 'telegram_text',
        text,
        telegramMessageId: msg.message_id,
        fromUserId: msg.from?.id,
        fromUserName:
          [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
          msg.from?.username ||
          '',
        ts: msg.date,
      })
    },
  })

  // Tail commands.jsonl coming from the bridge process.
  tailJsonl(
    COMMANDS_FILE,
    async (raw) => {
      const cmd = raw as { type?: string; [k: string]: any }
      if (!cmd?.type) return
      try {
        await handleCommand(cmd, {
          cfg: tg,
          drafts,
          cookies: () => cookies,
          myId: serverCfg.myId,
          decorate: (text: string) => serverCfg.decorate(text),
          log,
          refreshCookies,
        })
      } catch (err) {
        log(`server: command handler failed: ${err}`)
      }
    },
    {
      onError: (err) => log(`server: tailJsonl(commands) error: ${err}`),
    },
  )

  await Promise.race([teamplus, telegram])
}

/** Send the live-forward line, optionally with [Remind] [Draft] buttons. */
async function forwardWithButtons(
  tg: TelegramConfig,
  cursor: CursorStore,
  chatId: string,
  entry: import('./cursor.ts').UnreadEntry,
  text: string,
  withButtons: boolean,
): Promise<void> {
  if (!withButtons) {
    await sendTelegram(tg, text)
    return
  }
  // Pre-allocate a callback id and stash metadata so callback handler can
  // resolve the original message context.
  const cb = cursor.recordCallback({
    cbId: '',
    chatId,
    msgId: entry.msgId,
    senderId: entry.senderId,
    senderName: entry.senderName,
    content: entry.content,
    ts: entry.ts,
    telegramMessageId: null,
  })
  await cursor.save()
  const messageId = await sendTelegram(tg, text, { reply_markup: buildActionKeyboard(cb.cbId) })
  if (messageId) {
    cursor.attachTelegramMessageId(cb.cbId, messageId)
    await cursor.save()
  }
}

/** Serialize async work so messages preserve their arrival order. */
function makeForwardChain(): (job: () => Promise<unknown>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  return (job: () => Promise<unknown>) => {
    chain = chain
      .then(() => job())
      .then(() => undefined)
      .catch(err => {
        log(`forward: ${err}`)
      })
    return chain
  }
}

// ── Callback dispatch ────────────────────────────────────────────────

type CallbackContext = {
  cfg: TelegramConfig
  cursor: CursorStore
  drafts: DraftsStore
  cookies: () => Cookies
  myId: number
  decorate: (text: string) => string
  log: (line: string) => void
}

async function handleCallback(
  data: string,
  query: any,
  ctx: CallbackContext,
): Promise<CallbackResult> {
  const [kind, id] = data.split(':', 2) as [string, string?]
  if (!id) return { text: '⚠ malformed callback', alert: true }

  switch (kind) {
    case 'rm':
    case 'df':
      return handleActionCallback(kind, id, ctx)
    case 'snd':
      return handleSendDraft(id, query, ctx)
    case 'cnc':
      return handleCancelDraft(id, query, ctx)
    default:
      return { text: `⚠ unknown action: ${kind}`, alert: true }
  }
}

async function handleActionCallback(
  kind: 'rm' | 'df',
  cbId: string,
  ctx: CallbackContext,
): Promise<CallbackResult> {
  const cb = ctx.cursor.getCallback(cbId)
  if (!cb) {
    return {
      text: '⚠ This message is too old or already handled (callback not found).',
      alert: true,
    }
  }
  if (!(await bridgeAlive())) {
    return {
      text:
        '❌ Claude session not active.\n\nRun:\nclaude --dangerously-load-development-channels server:bridge',
      alert: true,
    }
  }
  const eventType = kind === 'rm' ? 'action_remind' : 'action_draft'
  await appendEvent({
    type: eventType,
    cbId: cb.cbId,
    chatId: cb.chatId,
    chatName: ctx.cursor.knownChats().find(k => k.chatId === cb.chatId)?.cursor.name ?? null,
    msgId: cb.msgId,
    senderId: cb.senderId,
    senderName: cb.senderName,
    content: cb.content,
    ts: cb.ts,
  })
  void sendTelegram(ctx.cfg, kind === 'rm' ? '📝 收到，處理中…' : '✏️ 收到，處理中…')
    .catch(() => undefined)
  return { text: '' }
}

async function handleSendDraft(
  draftId: string,
  query: any,
  ctx: CallbackContext,
): Promise<CallbackResult> {
  const draft = ctx.drafts.get(draftId)
  if (!draft) return { text: '⚠ Draft not found', alert: true }
  if (draft.status === 'sent') {
    return { text: '(already sent)', alert: false }
  }
  if (draft.status === 'cancelled') {
    return { text: '(cancelled)', alert: false }
  }

  let result: CallbackResult
  try {
    const outbound = ctx.decorate(draft.text)
    const send = await sendChatMessage(ctx.cookies(), {
      chatId: draft.chatId,
      channelType: draft.channelType,
      recipients: [{ mobile: draft.recipientMobile }],
      content: outbound,
      replyBatchId: draft.sourceMsgId ?? undefined,
    })
    if (send.isSuccess) {
      ctx.drafts.markSent(draft.id)
      await ctx.drafts.save()
      const sentAt = Math.floor(Date.now() / 1000)
      const messageId = draft.telegramMessageId ?? query.message?.message_id
      if (messageId) {
        await editMessage(
          ctx.cfg,
          messageId,
          formatSentResult(draft.senderName, sentAt) + '\n\n' + draft.text,
          { reply_markup: null },
        ).catch(err => ctx.log(`server: editMessage(sent) failed: ${err}`))
      }
      result = { text: '✅ Sent' }
    } else {
      ctx.drafts.markFailed(draft.id, send.description || 'unknown')
      await ctx.drafts.save()
      result = { text: `❌ TeamPlus rejected: ${send.description || 'unknown'}`, alert: true }
      const messageId = draft.telegramMessageId ?? query.message?.message_id
      if (messageId) {
        await editMessage(
          ctx.cfg,
          messageId,
          formatSendFailed(draft.senderName, send.description || 'unknown') +
            '\n\n' + draft.text,
          { reply_markup: buildDraftKeyboard(draft.id) },
        ).catch(err => ctx.log(`server: editMessage(failed) failed: ${err}`))
      }
    }
  } catch (err) {
    ctx.drafts.markFailed(draft.id, String(err))
    await ctx.drafts.save()
    result = { text: `❌ ${err}`, alert: true }
  }
  return result
}

async function handleCancelDraft(
  draftId: string,
  query: any,
  ctx: CallbackContext,
): Promise<CallbackResult> {
  const draft = ctx.drafts.get(draftId)
  if (!draft) return { text: '⚠ Draft not found', alert: true }
  if (draft.status === 'sent') return { text: '(already sent)' }
  if (draft.status === 'cancelled') return { text: '(already cancelled)' }
  ctx.drafts.markCancelled(draft.id)
  await ctx.drafts.save()
  const messageId = draft.telegramMessageId ?? query.message?.message_id
  if (messageId) {
    await editMessage(
      ctx.cfg,
      messageId,
      formatCancelled(draft.senderName) + '\n\n' + draft.text,
      { reply_markup: null },
    ).catch(err => ctx.log(`server: editMessage(cancel) failed: ${err}`))
  }
  return { text: '🗑 Cancelled' }
}

// ── Bridge → daemon command dispatch ─────────────────────────────────

type CommandContext = {
  cfg: TelegramConfig
  drafts: DraftsStore
  cookies: () => Cookies
  myId: number
  decorate: (text: string) => string
  log: (line: string) => void
  refreshCookies: () => Promise<void>
}

async function handleCommand(cmd: any, ctx: CommandContext): Promise<void> {
  switch (cmd.type) {
    case 'enqueue_draft':
      await handleEnqueueDraft(cmd, ctx)
      return
    case 'send_teamplus':
      await handleDirectSend(cmd, ctx)
      return
    default:
      ctx.log(`server: unknown command type: ${cmd.type}`)
  }
}

async function handleEnqueueDraft(cmd: any, ctx: CommandContext): Promise<void> {
  const chatId = String(cmd.chatId ?? cmd.chat_id ?? '')
  const text = String(cmd.text ?? '')
  if (!chatId || !text) {
    ctx.log(`server: enqueue_draft missing chat/text: ${JSON.stringify(cmd)}`)
    return
  }
  const channelType = inferChannelType(chatId)
  const recipientMobile =
    String(cmd.recipientMobile ?? '') || inferRecipientMobile(chatId, ctx.myId)
  const draft: Draft = ctx.drafts.enqueue({
    chatId,
    channelType,
    recipientMobile,
    senderName: String(cmd.senderName ?? cmd.sender_name ?? chatId),
    sourceMsgId: cmd.sourceMsgId ?? cmd.source_msg_id ?? null,
    text,
  })
  await ctx.drafts.save()
  const prompt = formatDraftPrompt(draft.senderName, draft.text)
  const messageId = await sendTelegram(ctx.cfg, prompt, {
    reply_markup: buildDraftKeyboard(draft.id),
  })
  if (messageId) {
    ctx.drafts.setTelegramMessageId(draft.id, messageId)
    await ctx.drafts.save()
  }
  ctx.log(`server: ✓ draft ${draft.id} queued for ${draft.senderName}`)
}

async function handleDirectSend(cmd: any, ctx: CommandContext): Promise<void> {
  const chatId = String(cmd.chatId ?? cmd.chat_id ?? '')
  const text = String(cmd.text ?? '')
  if (!chatId || !text) {
    ctx.log(`server: send_teamplus missing chat/text: ${JSON.stringify(cmd)}`)
    return
  }
  const channelType = inferChannelType(chatId)
  const recipientMobile =
    String(cmd.recipientMobile ?? '') || inferRecipientMobile(chatId, ctx.myId)
  try {
    const result = await sendChatMessage(ctx.cookies(), {
      chatId,
      channelType,
      recipients: recipientMobile ? [{ mobile: recipientMobile }] : [],
      content: ctx.decorate(text),
    })
    if (result.isSuccess) {
      await sendTelegram(ctx.cfg, `✅ Direct-sent to ${chatId}`)
    } else {
      await sendTelegram(
        ctx.cfg,
        `❌ Direct send to ${chatId} rejected: ${result.description}`,
      )
    }
  } catch (err) {
    ctx.log(`server: direct send failed: ${err}`)
    await sendTelegram(ctx.cfg, `❌ Direct send failed: ${err}`).catch(() => undefined)
  }
}

/** UUID-style ChatID → group (1); else one-on-one (0). */
function inferChannelType(chatId: string): number {
  return /^[0-9a-f]{8}-/.test(chatId) ? 1 : 0
}

/**
 * One-on-one ChatID is "<userA>_<userB>"; one of those is myId. Return the
 * other side as the recipient's UserNo.
 */
function inferRecipientMobile(chatId: string, myId: number): string {
  const m = /^(\d+)_(\d+)$/.exec(chatId)
  if (!m) return ''
  const a = m[1]!
  const b = m[2]!
  const me = String(myId)
  if (a === me) return b
  if (b === me) return a
  // Pattern doesn't include me — fall back to the second half (matches HAR
  // example where ChatID="<senderId>_<myId>" and we send to <senderId>).
  return a
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`server: ${sig} received, exiting`)
    process.exit(0)
  })
}

main().catch(err => {
  log(`server: fatal: ${err}`)
  process.exit(1)
})
