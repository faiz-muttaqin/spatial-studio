import type { McpServer } from '@modelcontextprotocol/server'
import {
  type AgentToolContract,
  listScansTool,
  proposeRoomFromScanTool,
  readScanTool,
  refuse,
  surfaceDescription,
  viewScanPhotosTool,
} from '@pascal-app/core/agent-tools'
import {
  analysePlanes,
  type CapturePlane,
  CapturePlaneSetSchema,
  type CaptureSessionDescriptor,
  type CaptureStreamDescriptor,
  captureDirectionToLevel,
  captureToLevel,
  DepthKeyframeIndexSchema,
  IDENTITY_SCAN_TRANSFORM,
  type ManualMeasurements,
  ManualMeasurementsSchema,
  normalizeCaptureSessionManifest,
  proposeRoom,
  type RgbKeyframe,
  RgbKeyframeIndexSchema,
  ScanBundleMetadataSchema,
  type ScanTransform,
} from '@pascal-app/core/capture'
import type { ScanNode } from '@pascal-app/core/schema'
import { z } from 'zod'
import type { SceneOperations } from '../operations'
import { READ_ONLY_TOOL_ANNOTATIONS } from './annotations'
import { refusalResult } from './errors'

/** Reads a stored capture artifact by its sha256; the host's content-addressed store. */
export type CaptureArtifactHost = {
  read(sha256: string): Promise<Uint8Array | null>
}

/** Most scans one list_scans call opens. */
const MAX_LISTED_SCANS = 50
/** Most walls and keyframes one read_scan returns before sampling. */
const MAX_WALLS = 40
const MAX_KEYFRAMES = 60
/** Raw image bytes one view_scan_photos call may return across all its frames. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024

type ScanBundle = {
  node: ScanNode
  manifest: CaptureSessionDescriptor
  /** Problems reading a stream: the bundle still opens without it. */
  problems: string[]
  rgb: RgbKeyframe[] | null
  depthFrames: number | null
  planes: CapturePlane[] | null
  measurements: ManualMeasurements | null
  info: z.infer<typeof ScanBundleMetadataSchema> | null
  transform: ScanTransform
}

const SHA256_AT_END = /([0-9a-f]{64})(?:[?#].*)?$/

function shaFromReference(reference: { uri?: string; sha256?: string }): string | null {
  if (reference.sha256 && /^[0-9a-f]{64}$/.test(reference.sha256)) return reference.sha256
  return reference.uri?.match(SHA256_AT_END)?.[1] ?? null
}

function scanNodes(operations: SceneOperations): ScanNode[] {
  return Object.values(operations.getNodes() as Record<string, { type?: string }>).filter(
    (node): node is ScanNode => node.type === 'scan',
  )
}

function nodeTransform(node: ScanNode): ScanTransform {
  return { position: node.position, rotation: node.rotation, scale: node.scale }
}

async function readJson(host: CaptureArtifactHost, sha256: string): Promise<unknown | null> {
  const bytes = await host.read(sha256)
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null
}

function findScan(operations: SceneOperations, scanId: string): ScanNode {
  const node = (operations.getNodes() as Record<string, { type?: string } | undefined>)[scanId]
  if (node?.type !== 'scan') {
    refuse('scan_not_found', `No scan node ${scanId} in this scene. Call list_scans for the ids.`)
  }
  return node as ScanNode
}

async function loadManifest(
  host: CaptureArtifactHost,
  node: ScanNode,
): Promise<CaptureSessionDescriptor> {
  const reference = node.captureSession
  if (!reference?.manifestUrl) {
    refuse('scan_has_no_capture', `Scan ${node.id} has no capture session manifest to read.`)
  }
  const sha256 = shaFromReference({ uri: reference.manifestUrl })
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

function streamOfKind(
  manifest: CaptureSessionDescriptor,
  kind: string,
): CaptureStreamDescriptor | undefined {
  return manifest.streams.find((stream) => stream.kind === kind)
}

/** One stream's payload, inline or from its artifact, checked against its schema. */
async function readStream<Schema extends z.ZodType>(
  host: CaptureArtifactHost,
  manifest: CaptureSessionDescriptor,
  kind: string,
  schema: Schema,
  problems: string[],
): Promise<z.infer<Schema> | null> {
  const stream = streamOfKind(manifest, kind)
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
    if (value === undefined) {
      problems.push(`${kind}: no payload`)
      return null
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

async function loadBundle(
  host: CaptureArtifactHost,
  node: ScanNode,
  want: { rgb?: boolean; depth?: boolean; planes?: boolean; measurements?: boolean } = {
    rgb: true,
    depth: true,
    planes: true,
    measurements: true,
  },
): Promise<ScanBundle> {
  const manifest = await loadManifest(host, node)
  const problems: string[] = []
  const [rgb, depth, planes, measurements] = await Promise.all([
    want.rgb ? readStream(host, manifest, 'rgb-keyframes', RgbKeyframeIndexSchema, problems) : null,
    want.depth
      ? readStream(host, manifest, 'depth-keyframes', DepthKeyframeIndexSchema, problems)
      : null,
    want.planes ? readStream(host, manifest, 'plane-set', CapturePlaneSetSchema, problems) : null,
    want.measurements
      ? readStream(host, manifest, 'manual-measurements', ManualMeasurementsSchema, problems)
      : null,
  ])
  const parsedInfo = ScanBundleMetadataSchema.safeParse(manifest.metadata ?? {})
  return {
    node,
    manifest,
    problems,
    rgb: rgb?.frames ?? null,
    depthFrames: depth?.frames.length ?? null,
    planes: planes?.planes ?? null,
    measurements,
    info: parsedInfo.success ? parsedInfo.data : null,
    transform: nodeTransform(node),
  }
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** `count` entries spread evenly across `items`, first and last included. */
function evenSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items]
  if (count === 1) return [items[Math.floor(items.length / 2)]!]
  return Array.from(
    { length: count },
    (_, index) => items[Math.round((index * (items.length - 1)) / (count - 1))]!,
  )
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function streamKinds(manifest: CaptureSessionDescriptor): string[] {
  return [...new Set(manifest.streams.map((stream) => stream.kind))]
}

async function listScans(operations: SceneOperations, host: CaptureArtifactHost) {
  const nodes = scanNodes(operations).filter((node) => node.captureSession)
  const listed = nodes.slice(0, MAX_LISTED_SCANS)
  const scans = await Promise.all(
    listed.map(async (node) => {
      const base = {
        scanId: node.id,
        name: node.name ?? null,
        levelId: node.parentId,
        sessionId: node.captureSession!.sessionId,
      }
      try {
        const bundle = await loadBundle(host, node, { rgb: true })
        const kinds = streamKinds(bundle.manifest)
        return {
          ...base,
          provider: bundle.info?.provider ?? null,
          createdAt: bundle.info?.createdAt ?? null,
          device: bundle.info?.device ?? null,
          state: bundle.manifest.state,
          streamKinds: kinds,
          keyframeCount: bundle.rgb?.length ?? 0,
          hasMeasurements: kinds.includes('manual-measurements'),
          hasPlanes: kinds.includes('plane-set'),
        }
      } catch (error) {
        const refusal = error as { code?: string; message?: string }
        return { ...base, error: refusal.code ?? 'scan_unreadable', message: refusal.message }
      }
    }),
  )
  return {
    scans,
    total: nodes.length,
    ...(nodes.length > listed.length ? { truncated: true } : {}),
  }
}

function planeSummary(planes: CapturePlane[], transform: ScanTransform) {
  const capture = analysePlanes(planes, IDENTITY_SCAN_TRANSFORM)
  const level = analysePlanes(planes, transform)
  const levelWalls = new Map(level.walls.map((wall) => [wall.planeId, wall]))
  const walls = capture.walls
    .toSorted((left, right) => right.length - left.length)
    .slice(0, MAX_WALLS)
    .map((wall) => {
      const placed = levelWalls.get(wall.planeId)
      return {
        planeId: wall.planeId,
        captureWorld: { a: wall.a, b: wall.b, length: wall.length },
        level: placed ? { a: placed.a, b: placed.b, length: placed.length } : null,
        bottomY: wall.bottom,
        topY: wall.top,
      }
    })
  const heights = (
    pick: (analysis: ReturnType<typeof analysePlanes>) => { planeId: string; y: number } | null,
  ) => {
    const inCapture = pick(capture)
    const inLevel = pick(level)
    return inCapture
      ? { planeId: inCapture.planeId, captureWorldY: inCapture.y, levelY: inLevel?.y ?? null }
      : null
  }
  return {
    counts: {
      horizontalUp: capture.horizontalUp,
      horizontalDown: capture.horizontalDown,
      vertical: capture.vertical,
      skipped: capture.skipped.length,
    },
    floor: heights((analysis) => analysis.floor),
    ceiling: heights((analysis) => analysis.ceiling),
    floorToCeiling: capture.height,
    walls,
    ...(capture.walls.length > walls.length ? { wallsTruncated: capture.walls.length } : {}),
    skipped: capture.skipped.slice(0, 20),
    note: 'Detections from the capture provider, not measurements. Wall lines are vertical planes seen from above, [x, z] in metres.',
  }
}

async function readScan(operations: SceneOperations, host: CaptureArtifactHost, scanId: string) {
  const node = findScan(operations, scanId)
  const bundle = await loadBundle(host, node)
  const frames = bundle.rgb ?? []
  const sampled = evenSample(frames, MAX_KEYFRAMES)
  const info = bundle.info
  return {
    scanId: node.id,
    levelId: node.parentId,
    sessionId: bundle.manifest.sessionId,
    state: bundle.manifest.state,
    nodeTransform: {
      position: node.position,
      rotationRadians: node.rotation,
      scale: node.scale,
      note: 'Level coordinates = position + R(rotation, XYZ order) * (scale * capture point). Capture world is Y up, right-handed, metres, for arcore-world and arkit-world alike.',
    },
    coordinateFrames: bundle.manifest.coordinateFrames.map(({ id, convention }) => ({
      id,
      convention,
    })),
    captureMetadata: info
      ? {
          provider: info.provider,
          appVersion: info.appVersion,
          device: info.device,
          createdAt: info.createdAt,
          trackingLossCount: info.trackingLossCount,
          warnings: info.warnings,
          camera: info.camera ?? null,
        }
      : null,
    streams: bundle.manifest.streams.map((stream) => ({
      id: stream.id,
      kind: stream.kind,
      availability: stream.availability,
    })),
    measurements: bundle.measurements,
    planes: bundle.planes ? planeSummary(bundle.planes, bundle.transform) : null,
    keyframes: {
      count: frames.length,
      ...(sampled.length < frames.length ? { sampledTo: sampled.length } : {}),
      items: sampled.map((frame) => ({
        id: frame.id,
        timestamp: frame.timestamp,
        trackingState: frame.trackingState,
        width: frame.width,
        height: frame.height,
        hasPose: frame.pose !== null,
        hasIntrinsics: frame.intrinsics !== null,
      })),
    },
    depth: { present: bundle.depthFrames !== null, frameCount: bundle.depthFrames ?? 0 },
    trackingLossCount: info?.trackingLossCount ?? null,
    ...(bundle.problems.length ? { unreadableStreams: bundle.problems } : {}),
  }
}

function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  return null
}

function frameNote(frame: RgbKeyframe, bundle: ScanBundle) {
  const opengl = bundle.info?.camera?.convention === 'opengl'
  const pose = frame.pose
  const level =
    pose && opengl
      ? (() => {
          const position = captureToLevel(bundle.transform, [pose[12]!, pose[13]!, pose[14]!])
          // OpenGL camera looks down -Z.
          const forward = captureDirectionToLevel(bundle.transform, [
            -pose[8]!,
            -pose[9]!,
            -pose[10]!,
          ])
          return {
            positionLevel: position.map((value) => round(value)),
            forwardLevel: forward.map((value) => round(value)),
          }
        })()
      : null
  return {
    frameId: frame.id,
    timestamp: frame.timestamp,
    trackingState: frame.trackingState,
    size: { width: frame.width, height: frame.height },
    intrinsics: frame.intrinsics,
    poseCameraToWorld: frame.pose,
    cameraConvention: bundle.info?.camera ?? null,
    ...(level ?? {}),
  }
}

async function viewScanPhotos(
  operations: SceneOperations,
  host: CaptureArtifactHost,
  input: { scanId: string; frameIds?: string[]; count?: number },
) {
  const node = findScan(operations, input.scanId)
  const bundle = await loadBundle(host, node, { rgb: true })
  const frames = bundle.rgb ?? []
  if (frames.length === 0) refuse('no_keyframes', `Scan ${node.id} has no photo keyframes.`)
  let chosen: RgbKeyframe[]
  if (input.frameIds) {
    const byId = new Map(frames.map((frame) => [frame.id, frame]))
    const missing = input.frameIds.filter((id) => !byId.has(id))
    if (missing.length) {
      refuse(
        'frame_not_found',
        `Scan ${node.id} has no keyframe ${missing.join(', ')}. Call read_scan for the ids.`,
        {
          missing,
        },
      )
    }
    chosen = [...new Set(input.frameIds)].map((id) => byId.get(id)!)
  } else {
    chosen = evenSample(frames, input.count ?? 3)
  }

  const content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  > = []
  const omitted: Array<{ frameId: string; reason: string }> = []
  let total = 0
  for (const frame of chosen) {
    const sha256 = shaFromReference(frame.image)
    const bytes = sha256 ? await host.read(sha256) : null
    if (!bytes) {
      omitted.push({ frameId: frame.id, reason: 'image not in the artifact store' })
      continue
    }
    const mimeType = imageType(bytes)
    if (!mimeType) {
      omitted.push({ frameId: frame.id, reason: 'not a JPEG or PNG image' })
      continue
    }
    if (total + bytes.byteLength > MAX_PHOTO_BYTES) {
      omitted.push({ frameId: frame.id, reason: 'over the size cap for one call' })
      continue
    }
    total += bytes.byteLength
    content.push({ type: 'text', text: JSON.stringify(frameNote(frame, bundle)) })
    content.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType })
  }
  content.push({
    type: 'text',
    text: JSON.stringify({
      scanId: node.id,
      returned: content.filter((part) => part.type === 'image').length,
      totalKeyframes: frames.length,
      imageBytes: total,
      ...(omitted.length ? { omitted } : {}),
    }),
  })
  return { content }
}

async function proposeRoomFromScan(
  operations: SceneOperations,
  host: CaptureArtifactHost,
  scanId: string,
) {
  const node = findScan(operations, scanId)
  const bundle = await loadBundle(host, node, { planes: true, measurements: true })
  const proposal = proposeRoom({
    planes: bundle.planes,
    measurements: bundle.measurements,
    transform: bundle.transform,
  })
  return {
    scanId: node.id,
    levelId: node.parentId,
    coordinates: 'Level coordinates: [x, z] in metres, through the scan node transform.',
    ...proposal,
    next: 'Nothing was written. Show the polygon, height and unknowns to the person; after they confirm or correct them, call create_room with this polygon and levelId.',
    ...(bundle.problems.length ? { unreadableStreams: bundle.problems } : {}),
  }
}

function register<Shape extends z.ZodRawShape>(
  server: McpServer,
  contract: AgentToolContract & { input: Shape },
  handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
) {
  server.registerTool(
    contract.name,
    {
      title: contract.title,
      description: surfaceDescription(contract, 'mcp'),
      inputSchema: z.object(contract.input),
      annotations: contract.annotations ?? READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        const result = await handler(input as z.infer<z.ZodObject<Shape>>)
        return (result as { content?: unknown }).content
          ? (result as ReturnType<typeof textResult>)
          : textResult(result)
      } catch (error) {
        return refusalResult(error)
      }
    },
  )
}

/** The four read-only scan tools; registered when the host can read capture artifacts. */
export function registerScanTools(
  server: McpServer,
  operations: SceneOperations,
  host: CaptureArtifactHost,
): void {
  register(server, listScansTool, () => listScans(operations, host))
  register(server, readScanTool, (input) => readScan(operations, host, input.scanId))
  register(server, viewScanPhotosTool, (input) => viewScanPhotos(operations, host, input))
  register(server, proposeRoomFromScanTool, (input) =>
    proposeRoomFromScan(operations, host, input.scanId),
  )
}
