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
  type EdgeBasis,
  type EdgeConfidence,
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
  /** A photo larger than this many pixels is refused before it is decoded. */
  maxPhotoPixels: 1920 * 1440,
  /** Longest wait for one artifact, clamped to what is left of the total budget. */
  fetchTimeoutMillis: 12_000,
  /** Bytes the frames may hold at once (depth, confidence and decoded photos). */
  memoryBudgetBytes: 192 * 1024 * 1024,
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

/** A user-visible remark about a build; the component turns the code into translated text. */
export type MapNote =
  | { code: 'frame-coordinates'; kind: string }
  | { code: 'time-budget-reading' }
  | { code: 'memory-budget'; frames: number }
  | { code: 'photos-unused'; count: number }
  | { code: 'fuse-time-budget'; frames: number }
  | { code: 'outline-skipped' }
  | { code: 'outline-failed' }
  | { code: 'streams-unreadable' }

export type MapRefusalCode =
  | 'manifest-unreadable'
  | 'manifest-invalid'
  | 'no-depth'
  | 'no-frames'
  | 'no-surface'
  | 'no-map'
  | 'timeout'

export type ProposalReview = {
  polygon: Array<[number, number]>
  edges: Array<{
    confidence: EdgeConfidence
    basis: EdgeBasis
    likelyGlass: boolean
    length: number
  }>
  height: {
    value: number
    basis: 'plane-estimate' | 'depth-estimate' | 'manual-measurement'
  } | null
  suggestedScanTransform: {
    position: [number, number, number]
    rotation: [number, number, number]
    scale: number
    confidence: 'low' | 'medium'
    floorBasis: 'plane' | 'depth-histogram'
  } | null
  unknowns: string[]
}

export type ScanMapResult = {
  map: Orthomap
  /** The walked path in level x, z. */
  path: Array<[number, number]>
  /** The room outline `proposeRoom` gives on these frames, in level x, z, or null. */
  proposal: Array<[number, number]> | null
  /** What a person needs to review that outline: edge confidence, height and the suggested scan placement. */
  review: ProposalReview | null
  /** Direction of north in level x, z as a unit vector, or null when the scan has no trueNorth. */
  north: [number, number] | null
  northReference: 'true' | 'magnetic' | null
  notes: MapNote[]
  /** Untranslated technical remarks from the builders and the stream readers. */
  diagnostics: string[]
  framesFused: number
  photosDecoded: number
}

/** Fetches a checked artifact URL, refusing before reading when the size is wrong. */
export type BoundedFetch = (
  url: string,
  limit: { max?: number; exact?: number; timeoutMs: number },
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

export class MapRefusal extends Error {
  constructor(readonly code: MapRefusalCode) {
    super(code)
  }
}

/**
 * Width and height from a JPEG's first start-of-frame header, read from the bytes alone so a
 * forged size is seen before any decoder allocates for it. Null when there is no usable header.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (at + 9 > bytes.length) return null
      const height = (bytes[at + 5]! << 8) | bytes[at + 6]!
      const width = (bytes[at + 7]! << 8) | bytes[at + 8]!
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (length < 2) return null
    at += 2 + length
  }
  return null
}

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
  const notes: MapNote[] = []
  const diagnostics: string[] = []
  const problems: string[] = []
  // Each artifact may take up to the fetch timeout, but never more than the total budget has left.
  const timeoutMs = () => {
    const left = MAP_LIMITS.totalMillis - (now() - started)
    if (left < 1_000) throw new MapRefusal('timeout')
    return Math.min(MAP_LIMITS.fetchTimeoutMillis, left)
  }
  const artifact = (sha: string) => deps.artifactUrl(`/api/artifacts/${sha}`)

  progress('manifest', 0, 1)
  const manifestBytes = await deps.fetchBytes(deps.artifactUrl(request.manifestUrl), {
    max: CAPTURE_MAX_ARTIFACT_BYTES,
    timeoutMs: timeoutMs(),
  })
  if (!manifestBytes) throw new MapRefusal('manifest-unreadable')
  let manifest: CaptureSessionDescriptor
  try {
    manifest = normalizeCaptureSessionManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
  } catch {
    throw new MapRefusal('manifest-invalid')
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
          ? await deps.fetchBytes(artifact(sha), {
              max: CAPTURE_MAX_ARTIFACT_BYTES,
              timeoutMs: timeoutMs(),
            })
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
    } catch (error) {
      if (error instanceof MapRefusal) throw error
      problems.push(`${kind}: unreadable`)
      return null
    }
  }
  const frameOf = (kind: string) => {
    const frameId = manifest.streams.find((stream) => stream.kind === kind)?.frameId
    const { matrix, unresolved } = resolveFrameTransform(manifest.coordinateFrames, frameId)
    if (unresolved) notes.push({ code: 'frame-coordinates', kind })
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
    throw new MapRefusal('no-depth')
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
  let retained = 0
  const entries = evenSample(depthIndex.frames, MAP_LIMITS.cloudFrames)
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at]!
    check()
    progress('frames', at, entries.length)
    if (now() - started > MAP_LIMITS.totalMillis / 2) {
      notes.push({ code: 'time-budget-reading' })
      break
    }
    const keyframe = keyframes.get(entry.rgbKeyframeId)
    const depthSha = shaFromReference(entry.depth)
    const expected = entry.width * entry.height
    if (!keyframe?.pose || !depthSha || expected > MAP_LIMITS.maxDepthPixels) {
      unreadable += 1
      continue
    }
    // Depth, its confidence and the decoded photo stay in memory until fusing is done.
    const photoBytes = Math.ceil(MAP_LIMITS.photoLongEdge * MAP_LIMITS.photoLongEdge * 0.5625) * 4
    if (retained + expected * 3 + photoBytes > MAP_LIMITS.memoryBudgetBytes) {
      notes.push({ code: 'memory-budget', frames: frames.length })
      break
    }
    await yieldToLoop()
    const bytes = await deps.fetchBytes(artifact(depthSha), {
      exact: expected * 2,
      timeoutMs: timeoutMs(),
    })
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
      const raw = await deps.fetchBytes(artifact(confidenceSha), {
        exact: expected,
        timeoutMs: timeoutMs(),
      })
      if (raw) confidence = Uint8Array.from(raw)
    }
    let image: DenseCloudFrame['image'] = null
    const imageSha = shaFromReference(keyframe.image)
    const jpeg = imageSha
      ? await deps.fetchBytes(artifact(imageSha), {
          max: MAP_LIMITS.maxJpegBytes,
          timeoutMs: timeoutMs(),
        })
      : null
    // The header is read first: a file that claims another size, or a huge one, is never decoded.
    const header = jpeg ? jpegSize(jpeg) : null
    const headerOk =
      header !== null &&
      header.width === keyframe.width &&
      header.height === keyframe.height &&
      header.width * header.height <= MAP_LIMITS.maxPhotoPixels
    const decoded = headerOk ? await deps.decodePhoto(jpeg!, MAP_LIMITS.photoLongEdge) : null
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
      retained += decoded.data.byteLength
    } else {
      photosFailed += 1
    }
    retained += expected * 2 + (confidence ? expected : 0)
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
  if (frames.length === 0) throw new MapRefusal('no-frames')
  if (photosFailed > 0) {
    notes.push({ code: 'photos-unused', count: photosFailed })
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
    throw new MapRefusal('no-surface')
  }
  if (cloud.stats.timedOut) {
    notes.push({ code: 'fuse-time-budget', frames: cloud.stats.framesUsed })
  }
  check()

  progress('outline', 0, 1)
  let proposalPolygon: Array<[number, number]> | null = null
  let review: ProposalReview | null = null
  let floorY: number | null = null
  let ceilingY: number | null = null
  const walked = motion ? pathPositions(motion.samples, frameOf('device-motion')) : null
  if (now() - started > MAP_LIMITS.totalMillis * 0.6) {
    notes.push({ code: 'outline-skipped' })
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
      if (proposalPolygon && proposal.edges.length === proposalPolygon.length) {
        const suggested = proposal.suggestedScanTransform
        review = {
          polygon: proposalPolygon,
          edges: proposal.edges.map((edge) => ({
            confidence: edge.confidence,
            basis: edge.basis,
            likelyGlass: edge.likelyGlass,
            length: edge.length,
          })),
          height: proposal.height,
          suggestedScanTransform: suggested
            ? {
                position: suggested.position,
                rotation: suggested.rotation,
                scale: suggested.scale,
                confidence: suggested.confidence,
                floorBasis: suggested.floorBasis,
              }
            : null,
          unknowns: proposal.unknowns,
        }
      }
    } catch {
      notes.push({ code: 'outline-failed' })
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
  if (full.width === 0) throw new MapRefusal('no-map')
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
    review,
    north: trueNorth.success ? northInLevel(trueNorth.data.worldYawDeg, request.transform) : null,
    northReference: trueNorth.success ? trueNorth.data.reference : null,
    notes: problems.length ? [...notes, { code: 'streams-unreadable' }] : notes,
    diagnostics: [...map.notes, ...diagnostics, ...problems],
    framesFused: cloud.stats.framesUsed,
    photosDecoded,
  }
}
