import {
  BRUSH_POINTS_FILE,
  BRUSH_TRANSFORMS_FILE,
  type BrushCloudInput,
  buildBrushDataset,
  CAPTURE_MAX_ARTIFACT_BYTES,
  type CaptureSessionDescriptor,
  normalizeCaptureSessionManifest,
  PointCloudPayloadSchema,
  type RgbKeyframe,
  RgbKeyframeIndexSchema,
  resolveFrameTransform,
} from '@pascal-app/core/capture'
import { type ZipEntry, zipStoreStream } from './zip-store'

/** Reads a stored artifact by hash; the disk artifact store has this shape. */
export type ArtifactHost = {
  read(sha256: string): Promise<Uint8Array | null>
  size(sha256: string): Promise<number | null>
}

export type BrushExportErrorCode =
  | 'scan_not_found'
  | 'no_capture'
  | 'manifest_unreadable'
  | 'no_keyframes'

export class BrushExportError extends Error {
  readonly code: BrushExportErrorCode
  constructor(code: BrushExportErrorCode, message: string) {
    super(message)
    this.name = 'BrushExportError'
    this.code = code
  }
}

export type BrushExport = {
  stream: ReadableStream<Uint8Array>
  frames: number
  pointCount: number
  /** Keyframes left out, with the reason; never silently dropped. */
  skipped: Array<{ keyframeId: string; reason: string }>
  notes: string[]
}

const SHA256_AT_END = /([0-9a-f]{64})(?:[?#].*)?$/

function shaOf(reference: { uri?: string; sha256?: string }): string | null {
  if (reference.sha256 && /^[0-9a-f]{64}$/.test(reference.sha256)) return reference.sha256
  return reference.uri?.match(SHA256_AT_END)?.[1] ?? null
}

async function readJson(host: ArtifactHost, sha256: string): Promise<unknown | null> {
  const size = await host.size(sha256)
  if (size === null || size > CAPTURE_MAX_ARTIFACT_BYTES) return null
  const bytes = await host.read(sha256)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

async function readStreamPayload(
  host: ArtifactHost,
  descriptor: CaptureSessionDescriptor,
  kind: string,
): Promise<unknown | null> {
  const stream = descriptor.streams.find((entry) => entry.kind === kind)
  if (!stream) return null
  if (stream.inline !== undefined) return stream.inline
  const sha256 = stream.artifact ? shaOf(stream.artifact) : null
  return sha256 ? readJson(host, sha256) : null
}

/**
 * The Brush dataset of one scan as a zip stream: `images/`, `transforms.json` and, when the
 * bundle has a point cloud, `points.ply`.
 *
 * Seam for the coloured dense cloud (R1, `buildDenseCloud`): `points.ply` is built from the
 * bundle's own `point-cloud` stream, which carries positions and, for some providers, colours. A
 * caller that has fused a coloured cloud can pass it as `cloud` and it replaces the stream's.
 */
export async function exportBrushDataset(
  node: { id: string; type?: string; captureSession?: { manifestUrl?: string | null } | null },
  host: ArtifactHost,
  options: { cloud?: BrushCloudInput | null } = {},
): Promise<BrushExport> {
  if (node.type !== 'scan') throw new BrushExportError('scan_not_found', 'Not a scan node.')
  const manifestSha = node.captureSession?.manifestUrl
    ? shaOf({ uri: node.captureSession.manifestUrl })
    : null
  if (!manifestSha) throw new BrushExportError('no_capture', 'The scan has no capture manifest.')
  const rawManifest = await readJson(host, manifestSha)
  let descriptor: CaptureSessionDescriptor
  try {
    descriptor = normalizeCaptureSessionManifest(rawManifest)
  } catch {
    throw new BrushExportError('manifest_unreadable', 'The capture manifest could not be read.')
  }
  const rgbRaw = await readStreamPayload(host, descriptor, 'rgb-keyframes')
  const rgb = RgbKeyframeIndexSchema.safeParse(rgbRaw)
  if (!rgb.success || rgb.data.frames.length === 0) {
    throw new BrushExportError('no_keyframes', 'The scan has no readable photo keyframes.')
  }

  const notes: string[] = []
  const frameOf = (kind: string) => {
    const frameId = descriptor.streams.find((entry) => entry.kind === kind)?.frameId
    const { matrix, unresolved } = resolveFrameTransform(descriptor.coordinateFrames, frameId)
    if (unresolved)
      notes.push(`${kind}: its coordinate frame is not usable, read as capture world.`)
    return matrix
  }

  // A keyframe whose JPEG is not in the store cannot be trained on; it is listed, not dropped.
  const present: RgbKeyframe[] = []
  const missing: Array<{ keyframeId: string; reason: string }> = []
  for (const keyframe of rgb.data.frames) {
    const size = await host.size(keyframe.image.sha256)
    if (size === null) missing.push({ keyframeId: keyframe.id, reason: 'image-missing' })
    else present.push(keyframe)
  }

  let cloud: BrushCloudInput | null = options.cloud ?? null
  let cloudFrame: number[] | null = null
  if (!cloud) {
    const payload = PointCloudPayloadSchema.safeParse(
      await readStreamPayload(host, descriptor, 'point-cloud'),
    )
    if (payload.success) {
      cloud = { positions: payload.data.positions, colors: payload.data.colors ?? null }
      cloudFrame = frameOf('point-cloud')
    } else {
      notes.push('The bundle has no readable point cloud, so there is no points.ply.')
    }
  }

  const dataset = buildBrushDataset({
    keyframes: present,
    keyframeFrame: frameOf('rgb-keyframes'),
    cloud,
    cloudFrame,
  })
  if (dataset.transforms.frames.length === 0) {
    throw new BrushExportError('no_keyframes', 'No keyframe has a tracked pose and intrinsics.')
  }
  const skipped = [
    ...missing,
    ...dataset.skipped.map((entry) => ({ keyframeId: entry.keyframeId, reason: entry.reason })),
  ]

  async function* entries(): AsyncGenerator<ZipEntry> {
    const encoder = new TextEncoder()
    yield {
      name: BRUSH_TRANSFORMS_FILE,
      data: encoder.encode(`${JSON.stringify(dataset.transforms, null, 2)}\n`),
    }
    if (dataset.pointsPly) yield { name: BRUSH_POINTS_FILE, data: dataset.pointsPly }
    for (const image of dataset.images) {
      const data = await host.read(image.sha256)
      // Present when checked above; an artifact deleted since then is left out of the zip.
      if (data) yield { name: image.path, data }
    }
  }

  return {
    stream: zipStoreStream(entries()),
    frames: dataset.transforms.frames.length,
    pointCount: dataset.pointCount,
    skipped,
    notes,
  }
}
