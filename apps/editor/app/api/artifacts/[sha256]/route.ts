import { CAPTURE_MAX_SPLAT_ARTIFACT_BYTES } from '@pascal-app/core/capture'
import { DiskArtifactStore, resolveDefaultDatabasePath } from '@pascal-app/mcp/storage'
import { artifactMediaType } from '@/lib/artifact-media-type'
import { MAX_ARTIFACT_BYTES, readBodyWithin } from '@/lib/artifact-upload-limit'
import {
  guardSceneApiRequest,
  sceneApiJson,
  sceneApiPreflight,
  withSceneApiHeaders,
} from '@/lib/scene-api-security'
import { isArtifactShared } from '@/lib/scene-sharing'

export const dynamic = 'force-dynamic'

export function OPTIONS(request: Request) {
  return sceneApiPreflight(request)
}

export async function GET(request: Request, { params }: { params: Promise<{ sha256: string }> }) {
  // A scene loads one artifact per scripted object; immutable reads stay outside the request budget.
  const guard = guardSceneApiRequest(request, { skipRateLimit: true })
  const { sha256 } = await params
  if (guard && (!/^[0-9a-f]{64}$/.test(sha256) || !(await isArtifactShared(sha256)))) return guard
  if (!/^[0-9a-f]{64}$/.test(sha256))
    return sceneApiJson(request, { error: 'invalid_hash' }, { status: 400 })
  const bytes = await new DiskArtifactStore(resolveDefaultDatabasePath()).read(sha256)
  if (!bytes) return sceneApiJson(request, { error: 'not_found' }, { status: 404 })
  return withSceneApiHeaders(
    request,
    new Response(bytes as BodyInit, {
      headers: {
        'Content-Type': artifactMediaType(bytes),
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    }),
  )
}

export async function PUT(request: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const guard = guardSceneApiRequest(request)
  if (guard) return guard
  const { sha256 } = await params
  if (!/^[0-9a-f]{64}$/.test(sha256))
    return sceneApiJson(request, { error: 'invalid_hash' }, { status: 400 })
  // A trained splat is larger than any other capture artifact; it asks for its own bound.
  const maxBytes =
    request.headers.get('x-artifact-kind') === 'gaussian-splat'
      ? CAPTURE_MAX_SPLAT_ARTIFACT_BYTES
      : MAX_ARTIFACT_BYTES
  const bytes = await readBodyWithin(request, maxBytes)
  if (!bytes) {
    return sceneApiJson(request, { error: 'too_large', maxBytes }, { status: 413 })
  }
  try {
    await new DiskArtifactStore(resolveDefaultDatabasePath()).put(sha256, bytes)
  } catch (error) {
    if (error instanceof Error && error.message === 'Artifact hash mismatch') {
      return sceneApiJson(request, { error: 'hash_mismatch' }, { status: 400 })
    }
    throw error
  }
  return sceneApiJson(request, { sha256 })
}
