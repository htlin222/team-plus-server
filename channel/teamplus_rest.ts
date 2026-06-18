import { cookieHeader, TEAMPLUS_BASE, type Cookies } from './config.ts'

const BASE = TEAMPLUS_BASE

export type ChatRoom = {
  chatId: string
  name: string
  /** 1 = group, 2 = team. */
  chatType: number
  unread: number
  isImportant: boolean
  memberCount: number
}

/**
 * List the user's chat rooms (groups + teams), ordered by most recent
 * activity. Pinned/important rooms float to the top.
 */
export async function loadChatRoomList(cookies: Cookies): Promise<ChatRoom[]> {
  const data = await postForm(
    `${BASE}/EIM/Chat/ChatMainHandler.ashx?action=loadChatRoomList`,
    cookies,
    { lastChatID: '', searchKey: '' },
  )
  if (data?.IsSuccess === false) {
    throw new Error(`loadChatRoomList: ${data?.Description ?? 'unknown'}`)
  }
  const rows = (data?.DataList ?? []) as any[]
  return rows.map(r => ({
    chatId: String(r.ChatID ?? ''),
    name: String(r.ChatName ?? ''),
    chatType: Number(r.ChatType ?? 0),
    unread: Number(r.UnreadCount ?? 0),
    isImportant: Boolean(r.IsImportant),
    memberCount: Number(r.MemberCount ?? 0),
  }))
}

export type PersonalChat = {
  chatId: string
  /** UserNo of the peer (= Mobile field). */
  mobile: string
  userName: string
  msgPreview: string
  /** 0 = inbound (peer → you), 1 = outbound (you → peer). */
  inOut: number
  unread: number
  timeDesc: string
  /** ms since epoch. */
  createTimeUtc: number
  /** 0 = one-on-one, 1 = group. */
  channelType: number
}

/**
 * Walk loadPersonalLogListForMessenger pages until `count` matching entries
 * are collected. Set `channelType: 0` to keep only one-on-one DMs (the
 * default — leave undefined to keep everything).
 */
export async function loadPersonalChats(
  cookies: Cookies,
  opts: { count: number; channelType?: 0 | 1 } = { count: 10 },
): Promise<PersonalChat[]> {
  const out: PersonalChat[] = []
  let compareSN = 0
  let pages = 0
  while (pages < 8 && out.length < opts.count) {
    const data = await postForm(
      `${BASE}/EIM/Chat/ChatMainHandler.ashx`,
      cookies,
      {
        action: 'loadPersonalLogListForMessenger',
        loadCount: '50',
        compareSN: String(compareSN),
        searchKey: '',
      },
    )
    if (data?.IsSuccess === false) {
      throw new Error(`loadPersonalChats: ${data?.Description ?? 'unknown'}`)
    }
    const rows = (data?.AppMessageLogList ?? []) as any[]
    if (rows.length === 0) break
    for (const r of rows) {
      const ct = Number(r.ChannelType ?? 0)
      if (opts.channelType !== undefined && ct !== opts.channelType) continue
      out.push({
        chatId: String(r.ChatID ?? ''),
        mobile: String(r.Mobile ?? ''),
        userName: String(r.AllUserName ?? r.UserName ?? ''),
        msgPreview: String(r.MsgContent ?? ''),
        inOut: Number(r.InOut ?? 0),
        unread: Number(r.UnreadCount ?? 0),
        timeDesc: String(r.TimeDesc ?? ''),
        createTimeUtc: Number(r.CreateTimeUTC ?? 0),
        channelType: ct,
      })
      if (out.length >= opts.count) break
    }
    if (!data?.HasMore) break
    compareSN = Number(data?.LastSN ?? rows[rows.length - 1]?.SN ?? 0)
    pages += 1
  }
  return out
}

const COMMON_HEADERS: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'x-requested-with': 'XMLHttpRequest',
}

async function postForm(
  url: string,
  cookies: Cookies,
  fields: Record<string, string>,
): Promise<any> {
  const body = new URLSearchParams(fields).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, cookie: cookieHeader(cookies) },
    body,
  })
  if (!res.ok) {
    throw new Error(`${url} ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

export type SearchHit = {
  chatId: string
  userName: string
  /** Mobile field equals UserNo / SenderID for one-on-one chats. */
  mobile: string
  chatType: number
  channelType: number
}

export async function searchByName(
  cookies: Cookies,
  name: string,
): Promise<SearchHit[]> {
  const data = await postForm(
    `${BASE}/EIM/Chat/ChatMainHandler.ashx`,
    cookies,
    {
      action: 'loadSearchChatLogList',
      loadCount: '25',
      compareSN: '0',
      compareChatID: '',
      searchKey: name,
      nowSearchLog: '1',
    },
  )
  if (!data?.IsSuccess) {
    throw new Error(`searchByName failed: ${data?.Description ?? 'unknown'}`)
  }
  const rows = (data.AppMessageLogList ?? []) as any[]
  return rows.map(r => ({
    chatId: String(r.ChatID ?? ''),
    userName: String(r.UserName ?? ''),
    mobile: String(r.Mobile ?? ''),
    chatType: Number(r.ChatType ?? 0),
    channelType: Number(r.ChannelType ?? 0),
  })).filter(h => h.chatId)
}

export type ContactInfo = {
  userName: string
  deptName?: string
  email?: string
}

/** Resolve userNo → display name. Returns map keyed by stringified userNo. */
export async function lookupContacts(
  cookies: Cookies,
  userNos: Array<string | number>,
): Promise<Map<string, ContactInfo>> {
  const list = userNos.map(String).filter(Boolean)
  if (list.length === 0) return new Map()
  const data = await postForm(
    `${BASE}/EIM/Contact/SelectContactApi.ashx`,
    cookies,
    {
      action: 'getContactByUserNoList',
      userNoList: JSON.stringify(list),
    },
  )
  if (!data?.IsSuccess) {
    throw new Error(`lookupContacts failed: ${data?.Description ?? 'unknown'}`)
  }
  const out = new Map<string, ContactInfo>()
  // Accept either ContactList or DataList — be defensive about field naming.
  const rows = (data.ContactList ?? data.DataList ?? data.Data ?? []) as any[]
  for (const r of rows) {
    const userNo = String(r.UserNo ?? r.Mobile ?? r.UserID ?? '')
    if (!userNo) continue
    out.set(userNo, {
      userName: String(r.UserName ?? r.RealName ?? ''),
      deptName: r.DeptName ? String(r.DeptName) : undefined,
      email: r.Email ? String(r.Email) : undefined,
    })
  }
  return out
}

export type SendArgs = {
  chatId: string
  /** 0 = one-on-one, 1 = group */
  channelType: number
  /** [{Mobile,Email}] for one-on-one; [] for group */
  recipients: Array<{ mobile: string; email?: string }>
  /** Group member user_no list when channelType=1; else [] */
  groupList?: Array<string | number>
  /** The actual text body. */
  content: string
  /** Original message's batchID, if you want to thread the reply. */
  replyBatchId?: string
}

export type SendResult = {
  isSuccess: boolean
  description: string
  batchId: string
  raw: any
}

export async function sendChatMessage(
  cookies: Cookies,
  args: SendArgs,
): Promise<SendResult> {
  const batchId = crypto.randomUUID()
  const recipients = args.recipients.map(r => ({
    Mobile: r.mobile,
    Email: r.email ?? '',
  }))
  const groupList = (args.groupList ?? []).map(String)
  const fields: Record<string, string> = {
    action: 'sendChatMessage',
    batchID: batchId,
    ChannelType: String(args.channelType),
    ChatID: args.chatId,
    Recipients: JSON.stringify(recipients),
    GroupList: JSON.stringify(groupList),
    MsgContent: args.content,
    Content2: '',
    MsgType: '1',
    FileList: '',
    SourceType: '1',
    AtUsers: '[]',
    replyBatchID: args.replyBatchId ?? '',
    UrlPreviewList: '[]',
  }
  const data = await postForm(
    `${BASE}/EIM/Common/SendMsgHandler.ashx`,
    cookies,
    fields,
  )
  return {
    isSuccess: Boolean(data?.IsSuccess),
    description: String(data?.Description ?? ''),
    batchId,
    raw: data,
  }
}
