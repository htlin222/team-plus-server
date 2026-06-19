// Image (msg_type 205) and file (206) events carry no bytes — only a FileName
// reference in Content2. The actual file is fetched from DownloadFileHandler
// with the session cookie, then archived to R2.

export type AttachmentMeta = {
  fileName: string
  showName: string | null
  fileSize: number | null
}

/** Extract attachment metadata from a message's Content2 JSON, if present. */
export function parseAttachment(content2: string | null): AttachmentMeta | null {
  if (!content2) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content2) as Record<string, unknown>
  } catch {
    return null
  }
  const fileName = typeof parsed.FileName === 'string' ? parsed.FileName : ''
  if (!fileName) return null
  return {
    fileName,
    showName: typeof parsed.ShowName === 'string' ? parsed.ShowName : null,
    fileSize: typeof parsed.FileSize === 'number' ? parsed.FileSize : null,
  }
}

export type DownloadedAttachment = {
  bytes: ArrayBuffer
  contentType: string
}

/** Download an attachment's bytes from TeamPlus. Returns null on any failure. */
export async function downloadAttachment(
  base: string,
  cookieHeader: string,
  input: { fileName: string; channelType: number | null; batchId: string | null },
): Promise<DownloadedAttachment | null> {
  if (!input.batchId) return null
  const url =
    `${base}/EIM/Common/DownloadFileHandler.ashx?action=getFile` +
    `&realFileName=${encodeURIComponent(input.fileName)}` +
    `&channelType=${input.channelType ?? 0}` +
    `&batchID=${encodeURIComponent(input.batchId)}` +
    `&FromNearline=`
  const res = await fetch(url, {
    headers: { cookie: cookieHeader, 'x-requested-with': 'XMLHttpRequest' },
  })
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  // The endpoint returns an HTML error page (200) when the file is gone/denied.
  if (!res.ok || contentType.includes('text/html')) return null
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength === 0) return null
  return { bytes, contentType }
}

/** Stable R2 object key for an attachment. */
export function attachmentKey(batchId: string, fileName: string): string {
  return `attachments/${batchId}/${fileName}`
}
