import { createClient } from '@libsql/client/web'
import type { TeamplusMessage } from './teamplus'

export async function insertMessage(env: Env, message: TeamplusMessage): Promise<void> {
  const client = createClient({
    url: required(env.TURSO_URL, 'TURSO_URL'),
    authToken: required(env.TURSO_AUTH_TOKEN, 'TURSO_AUTH_TOKEN'),
  })
  await client.execute({
    sql: `
      insert into messages (
        event_key, chat_id, chat_name, channel_type, msg_id, batch_id, message_sn,
        sender_id, sender_name, direction, msg_type, content, content2,
        teamplus_ts_ms, received_at_ms, raw_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(event_key) do nothing
    `,
    args: [
      message.eventKey,
      message.chatId,
      message.chatName,
      message.channelType,
      message.msgId,
      message.batchId,
      message.messageSn,
      message.senderId,
      message.senderName,
      message.direction,
      message.msgType,
      message.content,
      message.content2,
      message.teamplusTsMs,
      message.receivedAtMs,
      message.rawJson,
    ],
  })
}

export async function insertSessionEvent(
  env: Env,
  accountId: string,
  eventType: string,
  detail?: string,
): Promise<void> {
  const client = createClient({
    url: required(env.TURSO_URL, 'TURSO_URL'),
    authToken: required(env.TURSO_AUTH_TOKEN, 'TURSO_AUTH_TOKEN'),
  })
  await client.execute({
    sql: `
      insert into session_events (account_id, event_type, detail, created_at_ms)
      values (?, ?, ?, ?)
    `,
    args: [accountId, eventType, detail ?? null, Date.now()],
  })
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`${name} is not configured`)
  return trimmed
}
