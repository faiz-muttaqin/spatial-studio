import { CAPTURE_MAX_ARTIFACT_BYTES } from '@pascal-app/core/capture'

/**
 * Largest body `PUT /api/artifacts/{sha256}` stores. The capture contract's
 * per-artifact bound; the editor's own artifacts (geometry scripts, clipboard
 * payloads) are far smaller.
 */
export const MAX_ARTIFACT_BYTES = CAPTURE_MAX_ARTIFACT_BYTES

/**
 * Reads a request body only while it stays within `limit` bytes. A declared
 * `Content-Length` over the limit is refused before reading; a body that runs
 * past it without one (chunked, or a lying header) is cancelled mid-stream, so
 * an oversized upload is never buffered whole. Returns null when too large.
 */
export async function readBodyWithin(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) return null
  if (!request.body) return new Uint8Array(0)

  const reader = request.body.getReader()
  // With an honest Content-Length the body is written into one buffer of that size, so a 96 MiB
  // splat is held once, not as chunks plus a joined copy.
  const known = declared !== null && Number.isInteger(Number(declared)) ? Number(declared) : null
  if (known !== null) {
    const buffer = new Uint8Array(known)
    let filled = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (filled + value.byteLength > known) {
        await reader.cancel()
        return null
      }
      buffer.set(value, filled)
      filled += value.byteLength
    }
    return filled === known ? buffer : buffer.slice(0, filled)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
