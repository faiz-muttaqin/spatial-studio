import {
  CAPTURE_MAX_SPLAT_ARTIFACT_BYTES,
  describeSplatPly,
  SplatPlyError,
  withGaussianSplatStream,
} from '@pascal-app/core/capture'

export type SplatAttachErrorCode =
  | 'too_large'
  | 'invalid_file'
  | 'manifest_unreadable'
  | 'upload_failed'
  | 'insecure_context'

export class SplatAttachError extends Error {
  readonly code: SplatAttachErrorCode
  constructor(code: SplatAttachErrorCode, message: string) {
    super(message)
    this.name = 'SplatAttachError'
    this.code = code
  }
}

export type SplatAttachResult = {
  /** The new manifest the scan node must point at. */
  manifestUrl: string
  splatCount: number
  shDegree: number
  byteLength: number
}

const ARTIFACT_PATH = /^\/api\/artifacts\/[0-9a-f]{64}$/

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new SplatAttachError('insecure_context', 'SHA-256 needs a secure context.')
  const digest = await subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Stores a trained splat PLY as an artifact and writes a new manifest that carries it as the
 * scan's `gaussian-splat` stream (CAPTURE_CONTRACT.md, v1.4). The caller then points the scan
 * node at `manifestUrl`. Everything stays on this origin: the manifest URL must name the artifact
 * route, and the splat is sent with the `X-Artifact-Kind` header that lifts the size bound.
 */
export async function attachSplatToManifest(
  file: Blob,
  manifestUrl: string,
  options: { fetchImpl?: typeof fetch; trainer?: string } = {},
): Promise<SplatAttachResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  if (file.size > CAPTURE_MAX_SPLAT_ARTIFACT_BYTES) {
    throw new SplatAttachError(
      'too_large',
      `Splat files are limited to ${CAPTURE_MAX_SPLAT_ARTIFACT_BYTES} bytes.`,
    )
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  let described: { splatCount: number; shDegree: number }
  try {
    described = describeSplatPly(bytes)
  } catch (cause) {
    if (cause instanceof SplatPlyError) throw new SplatAttachError('invalid_file', cause.message)
    throw cause
  }
  const manifestPath = new URL(manifestUrl, 'http://same-origin.invalid').pathname
  if (!ARTIFACT_PATH.test(manifestPath)) {
    throw new SplatAttachError('manifest_unreadable', 'The manifest is not in the artifact store.')
  }

  const splatSha = await sha256Hex(bytes)
  const putSplat = await fetchImpl(`/api/artifacts/${splatSha}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Artifact-Kind': 'gaussian-splat' },
    body: new Blob([bytes as BlobPart]),
  })
  if (!putSplat.ok)
    throw new SplatAttachError('upload_failed', `Upload failed (${putSplat.status}).`)

  const manifestResponse = await fetchImpl(manifestPath, { credentials: 'same-origin' })
  if (!manifestResponse.ok) {
    throw new SplatAttachError('manifest_unreadable', 'The scan manifest could not be read.')
  }
  let manifest: ReturnType<typeof withGaussianSplatStream>
  try {
    manifest = withGaussianSplatStream(await manifestResponse.json(), {
      sha256: splatSha,
      byteLength: bytes.byteLength,
      metadata: { ...described, trainer: options.trainer ?? 'unspecified' },
    })
  } catch {
    throw new SplatAttachError(
      'manifest_unreadable',
      'The scan manifest does not match the contract.',
    )
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const manifestSha = await sha256Hex(manifestBytes)
  const putManifest = await fetchImpl(`/api/artifacts/${manifestSha}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: manifestBytes,
  })
  if (!putManifest.ok) {
    throw new SplatAttachError('upload_failed', `Upload failed (${putManifest.status}).`)
  }
  return {
    manifestUrl: `/api/artifacts/${manifestSha}`,
    splatCount: described.splatCount,
    shDegree: described.shDegree,
    byteLength: bytes.byteLength,
  }
}
