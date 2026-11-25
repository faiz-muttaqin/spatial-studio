import type { McpServer } from '@modelcontextprotocol/server'
import { refuse, surfaceDescription, viewScanMapTool } from '@pascal-app/core/agent-tools'
import {
  buildDenseCloud,
  buildOrthomap,
  CAPTURE_MAX_ARTIFACT_BYTES,
  type CapturePlane,
  CapturePlaneSetSchema,
  type CaptureSessionDescriptor,
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
  type RoomProposal,
  resolveFrameTransform,
  type ScanTransform,
} from '@pascal-app/core/capture'
import type { ScanNode } from '@pascal-app/core/schema'
import { z } from 'zod'
import type { SceneOperations } from '../operations'
import { READ_ONLY_TOOL_ANNOTATIONS } from './annotations'
import { refusalResult } from './errors'
import { decodeJpegDc } from './jpeg-dc'
import { encodePng } from './png'
import type { CaptureArtifactHost } from './scan-tools'

/** Longest side of the returned image, in pixels. */
export const MAP_MAX_SIDE = 1024
/** Most PNG bytes one call returns; the image is shrunk until it fits. */
export const MAP_MAX_BYTES = 2.5 * 1024 * 1024
/** Depth frames read for the outline, and photo-and-depth frames fused into the cloud. */
const MAX_OUTLINE_FRAMES = 120
const MAX_CLOUD_FRAMES = 150
/** Wall-clock budget for fusing, and for the whole call. */
const FUSE_MILLIS = 15_000
const TOTAL_MILLIS = 40_000
/** Most bytes one photo may occupy; the depth and confidence artifacts must match their size. */
const MAX_JPEG_BYTES = 8 * 1024 * 1024
/** Results kept for repeated calls, and for how long. */
const MEMO_ENTRIES = 4
const MEMO_MILLIS = 60_000
const OUTLINE_COLOUR = [255, 0, 255] as const
const BACKGROUND = 48

const SHA256_AT_END = /([0-9a-f]{64})(?:[?#].*)?$/

function shaFromReference(reference: { uri?: string; sha256?: string }): string | null {
  if (reference.sha256 && /^[0-9a-f]{64}$/.test(reference.sha256)) return reference.sha256
  return reference.uri?.match(SHA256_AT_END)?.[1] ?? null
}

function evenSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items]
  return Array.from(
    { length: count },
    (_, index) => items[Math.round((index * (items.length - 1)) / (count - 1))]!,
  )
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

async function readJson(host: CaptureArtifactHost, sha256: string): Promise<unknown | null> {
  const size = await host.size?.(sha256)
  if (size !== undefined && size !== null && size > CAPTURE_MAX_ARTIFACT_BYTES) return null
  const bytes = await host.read(sha256)
  if (!bytes || bytes.byteLength > CAPTURE_MAX_ARTIFACT_BYTES) return null
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * An artifact's bytes, after checking its stored size: over `max`, or not `exact` when that is
 * given, and it is not read at all. A store that cannot report sizes is read and checked after.
 */
async function readBounded(
  host: CaptureArtifactHost,
  sha256: string,
  limit: { max?: number; exact?: number },
): Promise<Uint8Array | null> {
  const ok = (size: number) =>
    (limit.exact === undefined || size === limit.exact) &&
    (limit.max === undefined || size <= limit.max)
  const size = await host.size?.(sha256)
  if (size !== undefined && size !== null && !ok(size)) return null
  const bytes = await host.read(sha256)
  return bytes && ok(bytes.byteLength) ? bytes : null
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

async function loadManifest(
  host: CaptureArtifactHost,
  node: ScanNode,
): Promise<CaptureSessionDescriptor> {
  const manifestUrl = node.captureSession?.manifestUrl
  if (!manifestUrl) {
    refuse('scan_has_no_capture', `Scan ${node.id} has no capture session manifest to read.`)
  }
  const sha256 = shaFromReference({ uri: manifestUrl })
  if (!sha256) {
    refuse('scan_manifest_invalid', `Scan ${node.id}: the manifest URL names no artifact hash.`)
  }
  let raw: unknown
  try {
    raw = await readJson(host, sha256)
  } catch {
    refuse('scan_manifest_invalid', `Scan ${node.id}: the manifest is not valid JSON.`)
  }
  if (raw === null) {
    refuse(
      'scan_manifest_missing',
      `Scan ${node.id}: the manifest ${sha256} is not in this server's artifact store.`,
    )
  }
  try {
    return normalizeCaptureSessionManifest(raw)
  } catch {
    refuse(
      'scan_manifest_invalid',
      `Scan ${node.id}: the manifest does not match the capture contract.`,
    )
  }
}

async function readStream<Schema extends z.ZodType>(
  host: CaptureArtifactHost,
  manifest: CaptureSessionDescriptor,
  kind: string,
  schema: Schema,
  problems: string[],
): Promise<z.infer<Schema> | null> {
  const stream = manifest.streams.find((candidate) => candidate.kind === kind)
  if (!stream) return null
  try {
    let value: unknown = stream.inline
    if (value === undefined && stream.artifact) {
      const sha256 = shaFromReference(stream.artifact)
      value = sha256 ? await readJson(host, sha256) : null
      if (value === null) {
        problems.push(`${kind}: artifact not in the store`)
        return null
      }
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

/** A stream's frame transform into the capture world, as read_scan resolves it. */
function frameOf(manifest: CaptureSessionDescriptor, kind: string, notes: string[]) {
  const frameId = manifest.streams.find((stream) => stream.kind === kind)?.frameId
  const { matrix, unresolved } = resolveFrameTransform(manifest.coordinateFrames, frameId)
  if (unresolved) notes.push(`${kind}: its coordinate frame is not usable, read as capture world.`)
  return matrix
}

function drawLine(
  rgb: Uint8Array,
  width: number,
  height: number,
  from: readonly [number, number],
  to: readonly [number, number],
) {
  let x0 = Math.round(from[0])
  let y0 = Math.round(from[1])
  const x1 = Math.round(to[0])
  const y1 = Math.round(to[1])
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let error = dx + dy
  for (let guard = 0; guard < 100_000; guard += 1) {
    if (x0 >= 0 && y0 >= 0 && x0 < width && y0 < height) {
      rgb.set(OUTLINE_COLOUR, (y0 * width + x0) * 3)
    }
    if (x0 === x1 && y0 === y1) break
    const doubled = 2 * error
    if (doubled >= dy) {
      error += dy
      x0 += sx
    }
    if (doubled <= dx) {
      error += dx
      y0 += sy
    }
  }
}

/** The map on a dark background, with the outline drawn when given, as packed RGB. */
function flatten(map: Orthomap, outline: ReadonlyArray<readonly [number, number]> | null) {
  const rgb = new Uint8Array(map.width * map.height * 3)
  for (let i = 0; i < map.width * map.height; i += 1) {
    const alpha = map.rgba[i * 4 + 3]!
    if (alpha === 255) {
      for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = map.rgba[i * 4 + c]!
    } else if (alpha === 128) {
      // Surface seen but no photo colour: a diagonal hatch of two dark tones, not a real colour.
      const hatch = ((i % map.width) + Math.floor(i / map.width)) % 4 < 2 ? 78 : 62
      rgb.fill(hatch, i * 3, i * 3 + 3)
    } else {
      rgb.fill(BACKGROUND, i * 3, i * 3 + 3)
    }
  }
  if (outline && outline.length >= 2) {
    const pixels = outline.map(
      ([x, z]) =>
        [
          (x - map.origin[0]) / map.metresPerPixel,
          (z - map.origin[1]) / map.metresPerPixel,
        ] as const,
    )
    for (let i = 0; i < pixels.length; i += 1) {
      drawLine(rgb, map.width, map.height, pixels[i]!, pixels[(i + 1) % pixels.length]!)
    }
  }
  return rgb
}

type Loaded = {
  frames: DenseCloudFrame[]
  depthFramesRead: number
  imagesDecoded: number
  imagesFailed: number
}

async function viewScanMap(
  operations: SceneOperations,
  host: CaptureArtifactHost,
  input: { scanId: string; layer?: 'top' | 'floor'; outline?: boolean; minConfidence?: number },
) {
  const started = Date.now()
  const node = (operations.getNodes() as Record<string, { type?: string } | undefined>)[
    input.scanId
  ]
  if (node?.type !== 'scan') {
    refuse(
      'scan_not_found',
      `No scan node ${input.scanId} in this scene. Call list_scans for the ids.`,
    )
  }
  const scan = node as ScanNode
  const manifest = await loadManifest(host, scan)
  const problems: string[] = []
  const notes: string[] = []
  const [rgbIndex, depthIndex, planeSet, measurements, motion] = await Promise.all([
    readStream(host, manifest, 'rgb-keyframes', RgbKeyframeIndexSchema, problems),
    readStream(host, manifest, 'depth-keyframes', DepthKeyframeIndexSchema, problems),
    readStream(host, manifest, 'plane-set', CapturePlaneSetSchema, problems),
    readStream(host, manifest, 'manual-measurements', ManualMeasurementsSchema, problems),
    readStream(host, manifest, 'device-motion', DeviceMotionTrajectorySchema, problems),
  ])
  if (!depthIndex?.frames.length || !rgbIndex?.frames.length) {
    refuse(
      'no_depth',
      `Scan ${scan.id} has no depth keyframes with photo keyframes, so no map can be built.`,
    )
  }
  const transform: ScanTransform = {
    position: scan.position,
    rotation: scan.rotation,
    scale: scan.scale,
  }
  const rgbFrame = frameOf(manifest, 'rgb-keyframes', notes)
  const planeFrame = planeSet ? frameOf(manifest, 'plane-set', notes) : null
  const motionFrame = motion ? frameOf(manifest, 'device-motion', notes) : null
  const keyframes = new Map<string, RgbKeyframe>()
  for (const frame of rgbIndex.frames) {
    if (frame.trackingState !== 'tracking' || !frame.pose) continue
    keyframes.set(frame.id, {
      ...frame,
      pose: rgbFrame ? multiplyMatrix4(rgbFrame, frame.pose) : frame.pose,
    })
  }

  const loaded: Loaded = {
    frames: [],
    depthFramesRead: 0,
    imagesDecoded: 0,
    imagesFailed: 0,
  }
  const entries = evenSample(depthIndex.frames, MAX_CLOUD_FRAMES)
  let unreadable = 0
  for (const entry of entries) {
    if (Date.now() - started > TOTAL_MILLIS / 2) {
      notes.push('Reading stopped at the time budget; later keyframes were left out.')
      break
    }
    const keyframe = keyframes.get(entry.rgbKeyframeId)
    const depthSha = shaFromReference(entry.depth)
    const expected = entry.width * entry.height
    if (!keyframe?.pose || !depthSha || expected > 1_000_000) {
      unreadable += 1
      continue
    }
    await yieldToLoop()
    const bytes = await readBounded(host, depthSha, { exact: expected * 2 })
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
      const raw = await readBounded(host, confidenceSha, { exact: expected })
      if (raw) confidence = Uint8Array.from(raw)
    }
    loaded.depthFramesRead += 1
    const base = {
      id: entry.id,
      width: entry.width,
      height: entry.height,
      intrinsics: entry.intrinsics,
      pose: keyframe.pose,
      depth,
      confidence,
    }
    let image: DenseCloudFrame['image'] = null
    const imageSha = shaFromReference(keyframe.image)
    const jpeg = imageSha ? await readBounded(host, imageSha, { max: MAX_JPEG_BYTES }) : null
    // The file's own header must match the keyframe's declared size, or it is not used.
    const decoded = jpeg
      ? decodeJpegDc(jpeg, { width: keyframe.width, height: keyframe.height })
      : null
    if (decoded) {
      // Intrinsics are for the keyframe size; the decoded image has one pixel per 8x8 block.
      const sx = decoded.sourceWidth / keyframe.width / 8
      const sy = decoded.sourceHeight / keyframe.height / 8
      image = {
        width: decoded.width,
        height: decoded.height,
        channels: 3,
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
      loaded.imagesDecoded += 1
    } else {
      loaded.imagesFailed += 1
    }
    loaded.frames.push({ ...base, image })
  }
  if (unreadable) {
    problems.push(
      `depth-keyframes: ${unreadable} frame(s) unreadable, not tracked, or without a pose`,
    )
  }
  if (loaded.frames.length === 0) {
    refuse('no_depth', `Scan ${scan.id}: no depth frame could be read with a tracked pose.`)
  }
  if (loaded.imagesFailed > 0) {
    notes.push(
      `${loaded.imagesFailed} photo(s) could not be read (missing, over the size cap, a different size from the keyframe, or not baseline JPEG); those frames add shape but no colour.`,
    )
  }

  const remaining = Math.max(2_000, TOTAL_MILLIS - (Date.now() - started) - 5_000)
  const cloud = buildDenseCloud(loaded.frames, {
    maxFrames: MAX_CLOUD_FRAMES,
    minConfidence: input.minConfidence ?? 128,
    maxMillis: Math.min(FUSE_MILLIS, remaining),
  })
  if (cloud.count === 0) {
    refuse(
      'no_map',
      `Scan ${scan.id}: no surface was seen in two or more depth frames, so no map can be made.`,
    )
  }
  if (cloud.stats.timedOut) {
    notes.push(`Fusing stopped at the time budget after ${cloud.stats.framesUsed} frame(s).`)
  }

  // The outline: the same proposal propose_room_from_scan would give, on the frames read here.
  let proposal: RoomProposal | null = null
  if (Date.now() - started > TOTAL_MILLIS * 0.6) {
    notes.push('The room outline was skipped at the time budget.')
  } else {
    try {
      const planes: CapturePlane[] | null =
        planeSet?.planes.map((plane) =>
          planeFrame
            ? { ...plane, centerPose: multiplyMatrix4(planeFrame, plane.centerPose) }
            : plane,
        ) ?? null
      const walked = motion ? pathPositions(motion.samples, motionFrame) : null
      proposal = proposeRoom({
        planes,
        measurements: measurements as ManualMeasurements | null,
        transform,
        depthFrames: evenSample(loaded.frames, MAX_OUTLINE_FRAMES),
        walkedPath: walked as Array<readonly [number, number, number]> | null,
      })
    } catch {
      notes.push('The room outline could not be computed, so none is shown.')
    }
  }

  const floorY = proposal?.floorY ?? null
  const ceilingY =
    proposal?.depth?.ceilingY ??
    (floorY !== null && proposal?.height ? floorY + proposal.height.value : null)
  const layer = input.layer ?? 'top'
  const full = buildOrthomap(cloud, { floorY, ceilingY, transform, layer, maxPixels: 2048 })
  if (full.width === 0) refuse('no_map', `Scan ${scan.id}: ${full.notes.join(' ')}`)
  const outline =
    input.outline === false || !proposal?.polygon
      ? null
      : (proposal.polygon as Array<readonly [number, number]>)

  // Shrink until the PNG fits the byte cap.
  let side = MAP_MAX_SIDE
  let map = downscaleOrthomap(full, side)
  let png = encodePng(map.width, map.height, flatten(map, outline))
  while (png.byteLength > MAP_MAX_BYTES && side > 128 && Date.now() - started < TOTAL_MILLIS) {
    side = Math.floor(side * 0.7)
    map = downscaleOrthomap(full, side)
    png = encodePng(map.width, map.height, flatten(map, outline))
  }

  const text = {
    scanId: scan.id,
    levelId: scan.parentId,
    layer,
    image: {
      width: map.width,
      height: map.height,
      bytes: png.byteLength,
      metresPerPixel: round(map.metresPerPixel, 4),
      axes: 'Column increases with +x, row increases with +z, as a plan seen from above. Flat dark grey (48, 48, 48) marks cells nothing reached; a diagonal hatch of slightly lighter greys marks surface that was seen but has no photo colour.',
      topLeftLevel: { x: round(map.origin[0]), z: round(map.origin[1]) },
      pixelToLevel:
        'x = topLeftLevel.x + column * metresPerPixel; z = topLeftLevel.z + row * metresPerPixel (the pixel corner).',
    },
    heights: {
      floorY: round(full.floorY),
      floorBasis: floorY === null ? 'cloud-percentile' : 'room-proposal',
      clipY: full.clipY === null ? null : round(full.clipY),
    },
    cloud: {
      framesFused: cloud.stats.framesUsed,
      voxels: cloud.count,
      voxelSizeM: cloud.voxelSize,
      uncolouredVoxels: cloud.stats.uncoloured,
      photosDecoded: loaded.imagesDecoded,
    },
    outline: outline
      ? {
          method: proposal?.method ?? null,
          corners: outline.map(([x, z]) => [round(x), round(z)]),
          note: 'Drawn in magenta (255, 0, 255). From propose_room_from_scan on the frames read here; an estimate, not a measured wall.',
        }
      : null,
    notes: [...full.notes, ...notes],
    note: 'Colours come from the phone photos along the depth rays, with per-keyframe exposure normalised. Mirrors and glass may show what is behind or in front of them. Nothing was written.',
    ...(problems.length ? { unreadableStreams: problems } : {}),
  }
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(text) },
      { type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
    ],
  }
}

type MapResult = Awaited<ReturnType<typeof viewScanMap>>

/** `view_scan_map`; registered beside the scan tools when the host can read capture artifacts. */
export function registerScanMapTool(
  server: McpServer,
  operations: SceneOperations,
  host: CaptureArtifactHost,
): void {
  const contract = viewScanMapTool
  // One run per scan and setting at a time; a repeated call within a minute reuses the result.
  const inFlight = new Map<string, Promise<MapResult>>()
  const memo = new Map<string, { at: number; result: MapResult }>()
  const keyOf = (input: Parameters<typeof viewScanMap>[2]): string | null => {
    const node = (
      operations.getNodes() as Record<
        string,
        | {
            type?: string
            captureSession?: { manifestUrl?: string }
            position?: unknown
            rotation?: unknown
            scale?: unknown
          }
        | undefined
      >
    )[input.scanId]
    if (node?.type !== 'scan') return null
    return JSON.stringify([
      input.scanId,
      node.captureSession?.manifestUrl,
      node.position,
      node.rotation,
      node.scale,
      input.layer ?? 'top',
      input.outline !== false,
      input.minConfidence ?? 128,
    ])
  }
  server.registerTool(
    contract.name,
    {
      title: contract.title,
      description: surfaceDescription(contract, 'mcp'),
      inputSchema: z.object(contract.input),
      annotations: contract.annotations ?? READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (rawInput) => {
      const input = rawInput as Parameters<typeof viewScanMap>[2]
      try {
        const key = keyOf(input)
        if (key === null) return await viewScanMap(operations, host, input)
        const cached = memo.get(key)
        if (cached && Date.now() - cached.at < MEMO_MILLIS) return cached.result
        let running = inFlight.get(key)
        if (!running) {
          running = viewScanMap(operations, host, input)
          inFlight.set(key, running)
          running
            .then((result) => {
              memo.set(key, { at: Date.now(), result })
              while (memo.size > MEMO_ENTRIES) memo.delete(memo.keys().next().value as string)
            })
            .catch(() => {})
            .finally(() => inFlight.delete(key))
        }
        return await running
      } catch (error) {
        return refusalResult(error)
      }
    },
  )
}
