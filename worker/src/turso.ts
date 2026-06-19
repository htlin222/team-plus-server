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

export async function updateAttachmentKey(
  env: Env,
  eventKey: string,
  attachmentKey: string,
): Promise<void> {
  const client = createClient({
    url: required(env.TURSO_URL, 'TURSO_URL'),
    authToken: required(env.TURSO_AUTH_TOKEN, 'TURSO_AUTH_TOKEN'),
  })
  await client.execute({
    sql: `update messages set attachment_key = ? where event_key = ?`,
    args: [attachmentKey, eventKey],
  })
}

export type PendingAttachment = {
  eventKey: string
  content2: string | null
  batchId: string | null
  channelType: number | null
  chatId: string
  senderId: number | null
}

/** Messages that carry a file (Content2 has FileName) but aren't archived yet. */
export async function selectPendingAttachments(
  env: Env,
  limit: number,
): Promise<PendingAttachment[]> {
  const client = createClient({
    url: required(env.TURSO_URL, 'TURSO_URL'),
    authToken: required(env.TURSO_AUTH_TOKEN, 'TURSO_AUTH_TOKEN'),
  })
  const res = await client.execute({
    sql: `
      select event_key, content2, batch_id, channel_type, chat_id, sender_id
      from messages
      where attachment_key is null and content2 like '%"FileName"%'
      order by received_at_ms desc
      limit ?
    `,
    args: [limit],
  })
  return res.rows.map(r => ({
    eventKey: String(r.event_key),
    content2: (r.content2 as string | null) ?? null,
    batchId: (r.batch_id as string | null) ?? null,
    channelType: (r.channel_type as number | null) ?? null,
    chatId: String(r.chat_id),
    senderId: (r.sender_id as number | null) ?? null,
  }))
}

export type LogRow = {
  teamplusTsMs: number | null
  receivedAtMs: number
  direction: string
  channelType: number | null
  chatId: string
  chatName: string | null
  senderId: number | null
  senderName: string | null
  msgType: number | null
  content: string | null
  attachmentKey: string | null
  attachmentName: string | null
}

/** Messages received at/after `sinceMs`, newest first, for the read API. */
export async function selectRecentMessages(
  env: Env,
  sinceMs: number,
  limit: number,
): Promise<LogRow[]> {
  const client = createClient({
    url: required(env.TURSO_URL, 'TURSO_URL'),
    authToken: required(env.TURSO_AUTH_TOKEN, 'TURSO_AUTH_TOKEN'),
  })
  const res = await client.execute({
    sql: `
      select teamplus_ts_ms, received_at_ms, direction, channel_type, chat_id, chat_name,
             sender_id, sender_name, msg_type, content, attachment_key,
             case when json_valid(content2) then json_extract(content2, '$.ShowName') end
               as attachment_name
      from messages
      where received_at_ms >= ?
      order by received_at_ms desc
      limit ?
    `,
    args: [sinceMs, limit],
  })
  // libSQL may return integer columns as BigInt; coerce so the result is
  // JSON-serialisable (Response.json throws on BigInt).
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
  return res.rows.map(r => ({
    teamplusTsMs: num(r.teamplus_ts_ms),
    receivedAtMs: Number(r.received_at_ms),
    direction: String(r.direction),
    channelType: num(r.channel_type),
    chatId: String(r.chat_id),
    chatName: (r.chat_name as string | null) ?? null,
    senderId: num(r.sender_id),
    senderName: (r.sender_name as string | null) ?? null,
    msgType: num(r.msg_type),
    content: (r.content as string | null) ?? null,
    attachmentKey: (r.attachment_key as string | null) ?? null,
    attachmentName: (r.attachment_name as string | null) ?? null,
  }))
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
