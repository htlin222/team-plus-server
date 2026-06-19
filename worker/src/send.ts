// Outbound: send a chat message via the same REST endpoint the web client uses.
// Ported from channel/teamplus_rest.ts so the worker can send with its cookie.

export type SendResult = {
  isSuccess: boolean
  description: string
  batchId: string
}

export async function sendChatMessage(
  base: string,
  cookieHeader: string,
  args: {
    chatId: string
    channelType: number
    recipients: Array<{ mobile: string; email?: string }>
    groupList?: Array<string | number>
    content: string
    replyBatchId?: string
  },
): Promise<SendResult> {
  const batchId = crypto.randomUUID()
  const recipients = args.recipients.map(r => ({ Mobile: r.mobile, Email: r.email ?? '' }))
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
  const res = await fetch(`${base}/EIM/Common/SendMsgHandler.ashx`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      cookie: cookieHeader,
    },
    body: new URLSearchParams(fields).toString(),
  })
  const data = (await res.json().catch(() => ({}))) as {
    IsSuccess?: boolean
    Description?: string
  }
  return {
    isSuccess: Boolean(data?.IsSuccess),
    description: String(data?.Description ?? ''),
    batchId,
  }
}
