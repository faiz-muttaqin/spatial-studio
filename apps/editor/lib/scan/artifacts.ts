import { CAPTURE_MAX_ARTIFACT_BYTES } from '@pascal-app/core/capture'

/** One content-addressed artifact, ready for `PUT /api/artifacts/{sha256}`. */
export type PreparedArtifact = {
  sha256: string
  byteLength: number
  mediaType: string
  body: Blob
}

export class ArtifactError extends Error {
  readonly code: 'insecure_context' | 'too_large' | 'upload_failed' | 'rate_limited'
  readonly status?: number

  constructor(code: ArtifactError['code'], message: string, status?: number) {
    super(message)
    this.name = 'ArtifactError'
    this.code = code
    this.status = status
  }
}

export function artifactUri(sha256: string): string {
  return `/api/artifacts/${sha256}`
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  // WebCrypto only exists in a secure context (HTTPS or localhost).
  if (!subtle) throw new ArtifactError('insecure_context', 'SHA-256 needs a secure context.')
  const digest = await subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function prepareArtifact(
  data: Blob | Uint8Array | string,
  mediaType: string,
): Promise<PreparedArtifact> {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(await data.arrayBuffer())
  if (bytes.byteLength > CAPTURE_MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(
      'too_large',
      `Artifacts are limited to ${CAPTURE_MAX_ARTIFACT_BYTES} bytes.`,
    )
  }
  return {
    sha256: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
    mediaType,
    body: new Blob([bytes as BlobPart], { type: mediaType }),
  }
}

export type UploadProgress = { done: number; total: number; bytesDone: number; bytesTotal: number }

/**
 * Stores every artifact on the same origin. Identical hashes are sent once.
 * A 429 from the API's per-minute budget waits for `Retry-After` and retries,
 * so a large capture slows down instead of failing.
 */
export async function uploadArtifacts(
  artifacts: readonly PreparedArtifact[],
  options: {
    fetchImpl?: typeof fetch
    onProgress?: (progress: UploadProgress) => void
    /** Called once per artifact the API confirmed, so a retry can skip it. */
    onStored?: (sha256: string) => void
    concurrency?: number
    maxRateLimitRetries?: number
    sleep?: (ms: number) => Promise<void>
    signal?: AbortSignal
  } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const unique = [...new Map(artifacts.map((artifact) => [artifact.sha256, artifact])).values()]
  const bytesTotal = unique.reduce((sum, artifact) => sum + artifact.byteLength, 0)
  let done = 0
  let bytesDone = 0
  options.onProgress?.({ done, total: unique.length, bytesDone, bytesTotal })

  const putOne = async (artifact: PreparedArtifact) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(artifactUri(artifact.sha256), {
        method: 'PUT',
        headers: { 'Content-Type': artifact.mediaType },
        body: artifact.body,
        signal: options.signal,
      })
      if (response.ok) break
      if (response.status === 429 && attempt < (options.maxRateLimitRetries ?? 6)) {
        const retryAfter = Number(response.headers.get('Retry-After'))
        await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5) * 1000)
        continue
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw new ArtifactError(
        response.status === 429 ? 'rate_limited' : 'upload_failed',
        body?.error ?? `Artifact upload failed (${response.status}).`,
        response.status,
      )
    }
    options.onStored?.(artifact.sha256)
    done += 1
    bytesDone += artifact.byteLength
    options.onProgress?.({ done, total: unique.length, bytesDone, bytesTotal })
  }

  const queue = [...unique]
  const workers = Array.from(
    { length: Math.min(options.concurrency ?? 3, queue.length) },
    async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          await putOne(next)
        } catch (error) {
          // Stop the other workers from starting new uploads.
          queue.length = 0
          throw error
        }
      }
    },
  )
  await Promise.all(workers)
}
