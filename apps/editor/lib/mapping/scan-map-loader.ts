import {
  buildDenseCloud,
  buildOrthomap,
  CAPTURE_MAX_ARTIFACT_BYTES,
  type CapturePlane,
  CapturePlaneSetSchema,
  type CaptureSessionDescriptor,
  captureDirectionToLevel,
  captureToLevel,
  type DenseCloudFrame,
  DepthKeyframeIndexSchema,
  DeviceMotionTrajectorySchema,
  downscaleOrthomap,
  type ManualMeasurements,
  ManualMeasurementsSchema,
  multiplyMatrix4,
  normalizeCaptureSessionManifest,
  type Orthomap,
  pathPositions,
  proposeRoom,
  type RgbKeyframe,
  RgbKeyframeIndexSchema,
  resolveFrameTransform,
  type ScanTransform,
  TrueNorthSchema,
} from '@pascal-app/core/capture'
import type { z } from 'zod'

/** Bounds shared with the MCP `view_scan_map` tool, so the browser and the agent see alike. */
export const MAP_LIMITS = {
  outlineFrames: 120,
  cloudFrames: 150,
  fuseMillis: 15_000,
  totalMillis: 40_000,
  maxJpegBytes: 8 * 1024 * 1024,
  maxDepthPixels: 1_000_000,
  /** Longest side of the photo decoded for colour; depth is 160x90, so more is wasted. */
  photoLongEdge: 320,
  maxPixels: 2048,
  /** The map shown is shrunk to this longest side. */
  displaySide: 2048,
} as const

export type MapPhase = 'manifest' | 'streams' | 'frames' | 'fuse' | 'outline' | 'map'

export type MapProgress = { phase: MapPhase; done: number; total: number }

export type ScanMapRequest = {
  manifestUrl: string
  transform: ScanTransform
  layer: 'top' | 'floor'
  minConfidence?: number
}

export type ScanMapResult = {
  map: Orthomap
  /** The walked path in level x, z. */
  path: Array<[number, number]>
  /** The room outline `proposeRoom` gives on these frames, in level x, z, or null. */
  proposal: Array<[number, number]> | null
  /** Direction of north in level x, z as a unit vector, or null when the scan has no trueNorth. */
  north: [number, number] | null
  northReference: 'true' | 'magnetic' | null
  notes: string[]
  framesFused: number
  photosDecoded: number
}

/** Fetches a checked artifact URL, refusing before reading when the size is wrong. */
export type BoundedFetch = (
  url: string,
  limit: { max?: number; exact?: number },
) => Promise<Uint8Array | null>

/** Decodes JPEG bytes to RGB at about `longEdge` pixels, or null. Never rotates by EXIF. */
export type PhotoDecoder = (
  bytes: Uint8Array,
  longEdge: number,
) => Promise<{
  width: number
  height: number
  /** Pixel size of the full image the decoded one stands for. */
  sourceWidth: number
  sourceHeight: number
  data: Uint8Array | Uint8ClampedArray
  channels: 3 | 4
} | null>

export type LoaderDeps = {
  fetchBytes: BoundedFetch
  decodePhoto: PhotoDecoder
  /** Resolves a manifest URL or `/api/artifacts/<sha>` path; throws unless it is a same-origin artifact. */
  artifactUrl: (value: string) => string
  now?: () => number
  isCancelled?: () => boolean
  onProgress?: (progress: MapProgress) => void
  yieldToLoop?: () => Promise<void>
}

const SHA256_AT_END = /([0-9a-f]{64})(?:[?#].*)?$/

export function shaFromReference(reference: { uri?: string; sha256?: string }): string | null {
  if (reference.sha256 && /^[0-9a-f]{64}$/.test(reference.sha256)) return reference.sha256
  return reference.uri?.match(SHA256_AT_END)?.[1] ?? null
}

export function evenSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items]
  return Array.from(
    { length: count },
    (_, index) => items[Math.round((index * (items.length - 1)) / (count - 1))]!,
  )
}

export class MapCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export class MapRefusal extends Error {}

/**
 * Unit vector of north in level x, z for a `trueNorth` bearing: clockwise from the capture
 * world's -Z seen from above, taken through the scan node's rotation. Its angle on the map,
 * clockwise from up, is `atan2(x, -z)`.
 */
export function northInLevel(worldYawDeg: number, transform: ScanTransform): [number, number] {
  const theta = (worldYawDeg * Math.PI) / 180
  const direction = captureDirectionToLevel(transform, [Math.sin(theta), 0, -Math.cos(theta)])
  const length = Math.hypot(direction[0], direction[2]) || 1
  return [direction[0] / length, direction[2] / length]
}

export async function loadScanMap(
  request: ScanMapRequest,
  deps: LoaderDeps,
): Promise<ScanMapResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const yieldToLoop = deps.yieldToLoop ?? (() => new Promise<void>((r) => setTimeout(r, 0)))
  const check = () => {
    if (deps.isCancelled?.()) throw new MapCancelled()
  }
  const progress = (phase: MapPhase, done: number, total: number) =>
    deps.onProgress?.({ phase, done, total })
  const notes: string[] = []
  const problems: string[] = []
  const artifact = (sha: string) => deps.artifactUrl(`/api/artifacts/${sha}`)

  progress('manifest', 0, 1)
  const manifestBytes = await deps.fetchBytes(deps.artifactUrl(request.manifestUrl), {
    max: CAPTURE_MAX_ARTIFACT_BYTES,
  })
  if (!manifestBytes) throw new MapRefusal('The scan manifest could not be read.')
  let manifest: CaptureSessionDescriptor
  try {
    manifest = normalizeCaptureSessionManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
  } catch {
    throw new MapRefusal('The scan manifest does not match the capture contract.')
  }
  check()

  const readStream = async <Schema extends z.ZodType>(
    kind: string,
    schema: Schema,
  ): Promise<z.infer<Schema> | null> => {
    const stream = manifest.streams.find((candidate) => candidate.kind === kind)
    if (!stream) return null
    try {
      let value: unknown = stream.inline
      if (value === undefined && stream.artifact) {
        const sha = shaFromReference(stream.artifact)
        const bytes = sha
          ? await deps.fetchBytes(artifact(sha), { max: CAPTURE_MAX_ARTIFACT_BYTES })
          : null
        if (!bytes) {
          problems.push(`${kind}: artifact not available`)
          return null
        }
        value = JSON.parse(new TextDecoder().decode(bytes))
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success) {
        problems.push(`${kind}: does not match the contract`)
        return null
      }
      return parsed.data
    } catch {
      problems.push(`${kind}: unreadable`)
      return null
    }
  }
  const frameOf = (kind: string) => {
    const frameId = manifest.streams.find((stream) => stream.kind === kind)?.frameId
    const { matrix, unresolved } = resolveFrameTransform(manifest.coordinateFrames, frameId)
    if (unresolved)
      notes.push(`${kind}: its coordinate frame is not usable, read as capture world.`)
    return matrix
  }

  progress('streams', 0, 1)
  const [rgbIndex, depthIndex, planeSet, measurements, motion] = await Promise.all([
    readStream('rgb-keyframes', RgbKeyframeIndexSchema),
    readStream('depth-keyframes', DepthKeyframeIndexSchema),
    readStream('plane-set', CapturePlaneSetSchema),
    readStream('manual-measurements', ManualMeasurementsSchema),
    readStream('device-motion', DeviceMotionTrajectorySchema),
  ])
  check()
  if (!depthIndex?.frames.length || !rgbIndex?.frames.length) {
    throw new MapRefusal('This scan has no depth keyframes with photo keyframes, so no map.')
  }

  const rgbFrame = frameOf('rgb-keyframes')
  const keyframes = new Map<string, RgbKeyframe>()
  for (const frame of rgbIndex.frames) {
    if (frame.trackingState !== 'tracking' || !frame.pose) continue
    keyframes.set(frame.id, {
      ...frame,
      pose: rgbFrame ? multiplyMatrix4(rgbFrame, frame.pose) : frame.pose,
    })
  }

  const frames: DenseCloudFrame[] = []
  let photosDecoded = 0
  let photosFailed = 0
  let unreadable = 0
  const entries = evenSample(depthIndex.frames, MAP_LIMITS.cloudFrames)
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at]!
    check()
    progress('frames', at, entries.length)
    if (now() - started > MAP_LIMITS.totalMillis / 2) {
      notes.push('Reading stopped at the time budget; later keyframes were left out.')
      break
    }
    const keyframe = keyframes.get(entry.rgbKeyframeId)
    const depthSha = shaFromReference(entry.depth)
    const expected = entry.width * entry.height
    if (!keyframe?.pose || !depthSha || expected > MAP_LIMITS.maxDepthPixels) {
      unreadable += 1
      continue
    }
    await yieldToLoop()
    const bytes = await deps.fetchBytes(artifact(depthSha), { exact: expected * 2 })
    if (!bytes) {
      unreadable += 1
      continue
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const depth = new Uint16Array(expected)
    for (let pixel = 0; pixel < expected; pixel += 1) depth[pixel] = view.getUint16(pixel * 2, true)
    let confidence: Uint8Array | null = null
    const confidenceSha = entry.confidence ? shaFromReference(entry.confidence) : null
    if (confidenceSha) {
      const raw = await deps.fetchBytes(artifact(confidenceSha), { exact: expected })
      if (raw) confidence = Uint8Array.from(raw)
    }
    let image: DenseCloudFrame['image'] = null
    const imageSha = shaFromReference(keyframe.image)
    const jpeg = imageSha
      ? await deps.fetchBytes(artifact(imageSha), { max: MAP_LIMITS.maxJpegBytes })
      : null
    const decoded = jpeg ? await deps.decodePhoto(jpeg, MAP_LIMITS.photoLongEdge) : null
    // The file's own size must match the keyframe's declared size, or its colours are not used.
    if (
      decoded &&
      decoded.sourceWidth === keyframe.width &&
      decoded.sourceHeight === keyframe.height
    ) {
      const sx = decoded.width / keyframe.width
      const sy = decoded.height / keyframe.height
      image = {
        width: decoded.width,
        height: decoded.height,
        channels: decoded.channels,
        data: decoded.data,
        intrinsics: keyframe.intrinsics
          ? {
              fx: keyframe.intrinsics.fx * sx,
              fy: keyframe.intrinsics.fy * sy,
              cx: keyframe.intrinsics.cx * sx,
              cy: keyframe.intrinsics.cy * sy,
            }
          : null,
      }
      photosDecoded += 1
    } else {
      photosFailed += 1
    }
    frames.push({
      id: entry.id,
      width: entry.width,
      height: entry.height,
      intrinsics: entry.intrinsics,
      pose: keyframe.pose,
      depth,
      confidence,
      image,
    })
  }
  if (unreadable) {
    problems.push(
      `depth-keyframes: ${unreadable} frame(s) unreadable, not tracked, or without a pose`,
    )
  }
  if (frames.length === 0) throw new MapRefusal('No depth frame could be read with a tracked pose.')
  if (photosFailed > 0) {
    notes.push(
      `${photosFailed} photo(s) could not be used (missing, over the size cap, a different size from the keyframe, or undecodable); those frames add shape but no colour.`,
    )
  }

  progress('fuse', 0, 1)
  await yieldToLoop()
  check()
  const remaining = Math.max(2_000, MAP_LIMITS.totalMillis - (now() - started) - 5_000)
  const cloud = buildDenseCloud(frames, {
    maxFrames: MAP_LIMITS.cloudFrames,
    minConfidence: request.minConfidence ?? 128,
    maxMillis: Math.min(MAP_LIMITS.fuseMillis, remaining),
  })
  if (cloud.count === 0) {
    throw new MapRefusal('No surface was seen in two or more depth frames, so no map.')
  }
  if (cloud.stats.timedOut) {
    notes.push(`Fusing stopped at the time budget after ${cloud.stats.framesUsed} frame(s).`)
  }
  check()

  progress('outline', 0, 1)
  let proposalPolygon: Array<[number, number]> | null = null
  let floorY: number | null = null
  let ceilingY: number | null = null
  const walked = motion ? pathPositions(motion.samples, frameOf('device-motion')) : null
  if (now() - started > MAP_LIMITS.totalMillis * 0.6) {
    notes.push('The room outline was skipped at the time budget.')
  } else {
    try {
      const planeFrame = planeSet ? frameOf('plane-set') : null
      const planes: CapturePlane[] | null =
        planeSet?.planes.map((plane) =>
          planeFrame
            ? { ...plane, centerPose: multiplyMatrix4(planeFrame, plane.centerPose) }
            : plane,
        ) ?? null
      const proposal = proposeRoom({
        planes,
        measurements: measurements as ManualMeasurements | null,
        transform: request.transform,
        depthFrames: evenSample(frames, MAP_LIMITS.outlineFrames),
        walkedPath: walked as Array<readonly [number, number, number]> | null,
      })
      floorY = proposal.floorY ?? null
      ceilingY =
        proposal.depth?.ceilingY ??
        (floorY !== null && proposal.height ? floorY + proposal.height.value : null)
      proposalPolygon = proposal.polygon
        ? (proposal.polygon as Array<readonly [number, number]>).map(([x, z]) => [x, z])
        : null
    } catch {
      notes.push('The room outline could not be computed, so none is available.')
    }
  }
  check()

  progress('map', 0, 1)
  await yieldToLoop()
  const full = buildOrthomap(cloud, {
    floorY,
    ceilingY,
    transform: request.transform,
    layer: request.layer,
    maxPixels: MAP_LIMITS.maxPixels,
  })
  if (full.width === 0) throw new MapRefusal(full.notes.join(' '))
  const map = downscaleOrthomap(full, MAP_LIMITS.displaySide)

  const path: Array<[number, number]> = walked
    ? evenSample(walked, 600).map((point) => {
        const level = captureToLevel(request.transform, point)
        return [level[0], level[2]]
      })
    : []
  const trueNorth = TrueNorthSchema.safeParse(
    (manifest.metadata as Record<string, unknown> | undefined)?.trueNorth,
  )
  progress('map', 1, 1)
  return {
    map,
    path,
    proposal: proposalPolygon,
    north: trueNorth.success ? northInLevel(trueNorth.data.worldYawDeg, request.transform) : null,
    northReference: trueNorth.success ? trueNorth.data.reference : null,
    notes: [
      ...map.notes,
      ...notes,
      ...(problems.length ? [`Unreadable: ${problems.join('; ')}`] : []),
    ],
    framesFused: cloud.stats.framesUsed,
    photosDecoded,
  }
}
