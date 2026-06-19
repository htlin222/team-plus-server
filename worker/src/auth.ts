const SIGNATURE_HEADER = 'x-teamplus-signature'
const TIMESTAMP_HEADER = 'x-teamplus-timestamp'
const MAX_SKEW_MS = 5 * 60 * 1000

export async function verifySignedRequest(
  request: Request,
  secret: string,
  bodyText: string,
): Promise<void> {
  if (!secret) throw new Error('COOKIE_UPLOAD_SECRET is not configured')

  const timestamp = request.headers.get(TIMESTAMP_HEADER) ?? ''
  const signature = request.headers.get(SIGNATURE_HEADER) ?? ''
  const tsMs = Number(timestamp) * 1000
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) {
    throw new Error('stale or invalid timestamp')
  }

  const url = new URL(request.url)
  const message = [
    request.method.toUpperCase(),
    url.pathname,
    timestamp,
    bodyText,
  ].join('\n')
  const expected = await hmacSha256Hex(secret, message)
  if (!timingSafeEqualHex(signature, expected)) {
    throw new Error('invalid signature')
  }
}

/**
 * Verify a time-limited attachment viewer token. The signed message is
 * `${key}\n${exp}` (exp = unix seconds), matching scripts/attachment_url.mjs.
 * Expiry enforcement (incl. the 1-week cap) is the caller's responsibility.
 */
export async function verifyViewerToken(
  secret: string,
  key: string,
  exp: string,
  signature: string,
): Promise<boolean> {
  if (!secret) return false
  const expected = await hmacSha256Hex(secret, `${key}\n${exp}`)
  return timingSafeEqualHex(signature, expected)
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return bytesToHex(new Uint8Array(digest))
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = hexToBytes(a)
  const right = hexToBytes(b)
  if (!left || !right || left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i]! ^ right[i]!
  }
  return diff === 0
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}
