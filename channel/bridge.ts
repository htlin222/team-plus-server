#!/usr/bin/env bun
/**
 * MCP bridge — spawned by Claude Code as a development channel.
 *
 *   claude --dangerously-load-development-channels server:bridge
 *
 * Subscribes to the daemon's state/events.jsonl and pushes each entry as a
 * `<channel source="teamplus-action" ...>` notification into the active
 * Claude session. Exposes two MCP tools the assistant can call back:
 *
 *   - enqueue_draft(chat_id, text [, source_msg_id, recipient_mobile])
 *       Queue a draft TeamPlus reply for the user to approve in Telegram.
 *
 *   - send_teamplus(chat_id, text [, recipient_mobile])
 *       Direct-send (skip approval). Reserved for explicit user requests.
 *
 * Tool calls are written to state/commands.jsonl; the daemon tails it.
 *
 * The bridge also touches state/bridge.alive every 5 s so the daemon can tell
 * Claude is online and surface "Claude session not active" when not.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  appendCommand,
  EVENTS_FILE,
  tailJsonl,
  touchHeartbeat,
} from './ipc.ts'

const HEARTBEAT_MS = 5_000

const INSTRUCTIONS = [
  'TeamPlus action bridge — events arrive when the user taps a button under a',
  'message in their Telegram bot DM. Each event names which action they tapped.',
  '',
  'Event format:',
  '  <channel source="teamplus-action" action="remind|draft" sender_name="..."',
  '           chat_id="..." msg_id="..." ts="...">CONTENT</channel>',
  '',
  'Action handling:',
  '  • remind — invoke /todoist to create a TODO. Title should be the gist of',
  '    the message plus the sender name. Then reply to the user (in this',
  '    session) confirming the TODO was created.',
  '  • draft — analyze the message and produce a 1-2 sentence',
  '    Traditional-Chinese reply. Then call enqueue_draft({chat_id, text,',
  '    source_msg_id}) so the user can approve it in Telegram. DO NOT call',
  '    send_teamplus directly — the approval flow exists for a reason.',
  '',
  'Tools:',
  '  • enqueue_draft — queue a draft for user approval (preferred path).',
  '  • send_teamplus — bypass approval and send immediately. Reserved for',
  '    explicit user instructions like "just send: ...".',
].join('\n')

const mcp = new Server(
  { name: 'tp-bridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

mcp.onclose = () => {
  process.stderr.write('bridge: mcp transport closed; exiting\n')
  process.exit(0)
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'enqueue_draft',
      description:
        'Queue a draft TeamPlus reply. Daemon DMs it to the user with [Send] [Cancel] buttons. Use this for the draft action; do NOT call send_teamplus instead.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'TeamPlus ChatID (e.g. "28_1049" for one-on-one).' },
          text: { type: 'string', description: 'The proposed reply text in the user\'s natural language.' },
          source_msg_id: { type: 'string', description: 'Original message id this is replying to (for threaded reply).' },
          recipient_mobile: { type: 'string', description: 'Optional UserNo of the recipient; if omitted the daemon infers from chat_id.' },
          sender_name: { type: 'string', description: 'Display name of the original sender (for the approval UI).' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'send_teamplus',
      description:
        'Send a TeamPlus message immediately, skipping approval. Reserved for explicit user requests; prefer enqueue_draft.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          recipient_mobile: { type: 'string' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  if (name !== 'enqueue_draft' && name !== 'send_teamplus') {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    }
  }
  try {
    await appendCommand({
      type: name,
      chatId: String(args.chat_id ?? ''),
      text: String(args.text ?? ''),
      sourceMsgId: args.source_msg_id ?? null,
      recipientMobile: args.recipient_mobile ?? null,
      senderName: args.sender_name ?? null,
    })
    return {
      content: [{ type: 'text' as const, text: 'queued' }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `failed: ${err}` }],
      isError: true,
    }
  }
})

async function pushChannel(content: string, meta: Record<string, string>): Promise<void> {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta },
  })
}

function startHeartbeat(): void {
  void touchHeartbeat().catch(() => undefined)
  setInterval(() => {
    void touchHeartbeat().catch(() => undefined)
  }, HEARTBEAT_MS)
}

function buildEventNotification(
  e: any,
): { content: string; meta: Record<string, string> } | null {
  if (!e || typeof e !== 'object' || !e.type) return null

  // Free-text from the user via Telegram → treat as a direct ask to the
  // session. Auto-ack ("收到，處理中" + typing) is sent by the daemon before
  // this event ever lands here, so the bridge just relays the content.
  if (e.type === 'telegram_text') {
    const text = String(e.text ?? '')
    const fromName = String(e.fromUserName ?? '')
    return {
      content:
        `User wrote in Telegram: "${text}"\n\n` +
        'Reply naturally in the same language. The user has already been ' +
        'shown "收到，處理中" so don\'t re-acknowledge — get straight to the ' +
        'answer or action. When you reply, your response will be sent back ' +
        'to the same Telegram DM by the daemon.',
      meta: {
        source: 'telegram-text',
        from_user_name: fromName,
        from_user_id: String(e.fromUserId ?? ''),
        telegram_msg_id: String(e.telegramMessageId ?? ''),
        ts: String(e.ts ?? ''),
      },
    }
  }

  const action = String(e.type).replace(/^action_/, '')
  const senderName = String(e.senderName ?? `#${e.senderId ?? 'unknown'}`)
  const chatId = String(e.chatId ?? '')
  const msgId = String(e.msgId ?? '')
  const content = String(e.content ?? '')

  const meta: Record<string, string> = {
    action,
    sender_name: senderName,
    chat_id: chatId,
    msg_id: msgId,
    ts: String(e.ts ?? ''),
  }
  if (typeof e.senderId === 'number') meta.sender_id = String(e.senderId)
  if (e.chatName) meta.chat_name = String(e.chatName)

  let body: string
  if (action === 'remind') {
    body =
      `${senderName} sent: "${content}"\n\n` +
      'Run /todoist to create a TODO with the gist + sender name as the title. ' +
      'After /todoist replies, confirm in this session.'
  } else if (action === 'draft') {
    const isDm = /^\d+_\d+$/.test(chatId)
    const histCmd = isDm
      ? `python3 .claude/skills/dms/references/fetch_history.py --mobile ${e.senderId} --count 50 --json`
      : `python3 .claude/skills/dms/references/fetch_history.py --chat-id ${chatId} --count 50 --json`
    body =
      `${senderName} sent: "${content}"\n\n` +
      `First, pull recent context: \`${histCmd}\`. ` +
      'Skim messages from the last 24h (filter by ts) so the reply fits the thread. ' +
      'Then draft a 1-2 sentence Traditional-Chinese reply that fits the sender. ' +
      `Finally call enqueue_draft({chat_id:"${chatId}", text:"<your draft>", ` +
      `source_msg_id:"${msgId}", sender_name:"${senderName}"}). ` +
      'Do NOT call send_teamplus — the approval flow is mandatory.'
  } else {
    body = `${senderName} sent: "${content}" (action=${action})`
  }
  return { content: body, meta }
}

async function main(): Promise<void> {
  await mcp.connect(new StdioServerTransport())
  startHeartbeat()
  process.stderr.write('bridge: ✓ MCP connected, tailing events.jsonl\n')

  tailJsonl(
    EVENTS_FILE,
    async (raw) => {
      const built = buildEventNotification(raw)
      if (!built) return
      try {
        await pushChannel(built.content, built.meta)
      } catch (err) {
        process.stderr.write(`bridge: pushChannel failed: ${err}\n`)
      }
    },
    {
      onError: (err) => process.stderr.write(`bridge: tailJsonl error: ${err}\n`),
    },
  )
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    process.stderr.write(`bridge: ${sig} received, exiting\n`)
    process.exit(0)
  })
}

main().catch((err) => {
  process.stderr.write(`bridge: fatal: ${err}\n`)
  process.exit(1)
})
