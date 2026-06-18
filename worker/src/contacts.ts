// TeamPlus WS events carry only numeric IDs (SenderID / ChatID), never names.
// These REST calls mirror the local daemon's name resolution so the cloud
// worker can fill sender_name / chat_name before inserting into Turso.

const COMMON_HEADERS: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'x-requested-with': 'XMLHttpRequest',
}

async function postForm(
  url: string,
  cookieHeader: string,
  fields: Record<string, string>,
): Promise<any> {
  const body = new URLSearchParams(fields).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, cookie: cookieHeader },
    body,
  })
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return res.json()
}

/** Resolve userNo → display name via getContactByUserNoList. */
export async function lookupContactNames(
  base: string,
  cookieHeader: string,
  userNos: Array<string | number>,
): Promise<Map<string, string>> {
  const list = userNos.map(String).filter(Boolean)
  if (list.length === 0) return new Map()
  const data = await postForm(
    `${base}/EIM/Contact/SelectContactApi.ashx`,
    cookieHeader,
    { action: 'getContactByUserNoList', userNoList: JSON.stringify(list) },
  )
  const out = new Map<string, string>()
  const rows = (data?.ContactList ?? data?.DataList ?? data?.Data ?? []) as any[]
  for (const r of rows) {
    const userNo = String(r.UserNo ?? r.Mobile ?? r.UserID ?? '')
    if (!userNo) continue
    const name = String(r.UserName ?? r.RealName ?? '').trim()
    if (name) out.set(userNo, name)
  }
  return out
}

/** Resolve group chatId → room name via loadChatRoomList. */
export async function loadChatRoomNames(
  base: string,
  cookieHeader: string,
): Promise<Map<string, string>> {
  const data = await postForm(
    `${base}/EIM/Chat/ChatMainHandler.ashx?action=loadChatRoomList`,
    cookieHeader,
    { lastChatID: '', searchKey: '' },
  )
  const out = new Map<string, string>()
  const rows = (data?.DataList ?? []) as any[]
  for (const r of rows) {
    const id = String(r.ChatID ?? '')
    const name = String(r.ChatName ?? '').trim()
    if (id && name) out.set(id, name)
  }
  return out
}

/**
 * For a one-on-one chat the chatId is "a_b" where a/b are the two userNos.
 * The peer is whichever side is not me.
 */
export function dmPeerId(chatId: string, myId: number | null): number | null {
  if (myId == null) return null
  const parts = chatId.split('_')
  if (parts.length !== 2) return null
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  if (a === myId) return b
  if (b === myId) return a
  return null
}
