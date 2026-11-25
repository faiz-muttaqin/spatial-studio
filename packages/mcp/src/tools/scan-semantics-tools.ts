import type { McpServer } from '@modelcontextprotocol/server'
import {
  liftScanSemanticsTool,
  planScanSemanticsTool,
  refuse,
  SEMANTICS_MAX_DETECTIONS,
  SEMANTICS_MAX_FRAMES,
} from '@pascal-app/core/agent-tools'
import {
  analysePlanes,
  clusterDetections,
  type LiftFrame,
  liftDetections,
  type PlanFrame,
  pickKeyframesForWalls,
  proposeRoom,
  type SemanticDetection,
  type SemanticsResult,
  type SemanticWall,
} from '@pascal-app/core/capture'
import type { ScanNode } from '@pascal-app/core/schema'
import type { SceneOperations } from '../operations'
import {
  type CaptureArtifactHost,
  findScan,
  loadBundle,
  readDepthFrames,
  register,
  round,
  type ScanBundle,
  shaFromReference,
} from './scan-tools'

/** Walls the semantics snap to, with where they came from and the floor they stand on. */
type WallSource = {
  walls: SemanticWall[]
  source: 'scene-walls' | 'room-proposal' | 'none'
  floorY: number
  floorBasis: string
  notes: string[]
}

type SceneWall = {
  id: string
  type: 'wall'
  parentId?: string | null
  start: [number, number]
  end: [number, number]
  height?: number
  curveOffset?: number
}

function sceneWalls(
  operations: SceneOperations,
  levelId: string | null | undefined,
): SemanticWall[] {
  return (Object.values(operations.getNodes()) as Array<{ type?: string }>)
    .filter(
      (node): node is SceneWall =>
        node.type === 'wall' &&
        (node as SceneWall).parentId === levelId &&
        !(node as SceneWall).curveOffset,
    )
    .map((wall) => ({
      id: wall.id,
      a: wall.start,
      b: wall.end,
      ...(wall.height ? { height: wall.height } : {}),
    }))
}

/**
 * The box yaw is measured from +X toward +Z; a positive three.js rotation about Y turns +X toward
 * -Z, so the item rotation is the negated yaw, kept in (-180, 180].
 */
export function placeRotation(yawDegrees: number): number {
  let rotation = -yawDegrees
  while (rotation > 180) rotation -= 360
  while (rotation <= -180) rotation += 360
  return Math.round(rotation * 10) / 10 || 0
}

const MEMO_MILLIS = 60_000
const MEMO_ENTRIES = 8
const memo = new Map<string, { at: number; value: Promise<unknown> }>()

/** Repeated plan and lift calls on one scan reuse its bundle and room proposal for a minute. */
function memoised<T>(key: string, make: () => Promise<T>): Promise<T> {
  const now = Date.now()
  for (const [k, entry] of memo) if (now - entry.at > MEMO_MILLIS) memo.delete(k)
  const hit = memo.get(key)
  if (hit) return hit.value as Promise<T>
  const value = make()
  value.catch(() => memo.delete(key))
  memo.set(key, { at: now, value })
  while (memo.size > MEMO_ENTRIES) memo.delete(memo.keys().next().value!)
  return value
}

const scanKey = (node: ScanNode) =>
  JSON.stringify([
    node.id,
    node.captureSession?.manifestUrl,
    node.position,
    node.rotation,
    node.scale,
  ])

const SEMANTICS_WANT = { rgb: true, depth: true, planes: true, measurements: true, motion: true }

function loadSemanticsBundle(host: CaptureArtifactHost, node: ScanNode): Promise<ScanBundle> {
  return memoised(`bundle:${scanKey(node)}`, () => loadBundle(host, node, SEMANTICS_WANT))
}

function proposalFor(host: CaptureArtifactHost, bundle: ScanBundle, node: ScanNode) {
  return memoised(`proposal:${scanKey(node)}`, async () =>
    proposeRoom({
      planes: bundle.planes,
      measurements: bundle.measurements,
      transform: bundle.transform,
      depthFrames: await readDepthFrames(host, bundle, bundle.problems),
      walkedPath: bundle.walked,
    }),
  )
}

/** The floor height in level metres: the plane set's floor, else the room proposal's from depth. */
async function floorFor(
  host: CaptureArtifactHost,
  bundle: ScanBundle,
  node: ScanNode,
): Promise<{ y: number; basis: string }> {
  const planeFloor = bundle.planes ? analysePlanes(bundle.planes, bundle.transform).floor : null
  if (planeFloor) return { y: planeFloor.y, basis: 'plane-set floor, in level coordinates' }
  const proposal = await proposalFor(host, bundle, node)
  return proposal.floorY !== null
    ? {
        y: proposal.floorY,
        basis: 'floor height from the room proposal (depth), in level coordinates',
      }
    : { y: 0, basis: 'assumed 0 (level floor); no floor was seen, so heights are unreliable' }
}

async function wallsFor(
  operations: SceneOperations,
  host: CaptureArtifactHost,
  bundle: ScanBundle,
  node: ScanNode,
): Promise<WallSource> {
  const notes: string[] = []
  const planeFloor = bundle.planes ? analysePlanes(bundle.planes, bundle.transform).floor : null
  const scene = sceneWalls(operations, node.parentId)
  if (scene.length > 0) {
    const floor = await floorFor(host, bundle, node)
    return {
      walls: scene,
      source: 'scene-walls',
      floorY: floor.y,
      floorBasis: floor.basis,
      notes: [`Snapped to the ${scene.length} straight wall(s) on this scan's level.`],
    }
  }
  const proposal = await proposalFor(host, bundle, node)
  if (!proposal.polygon) {
    return {
      walls: [],
      source: 'none',
      floorY: planeFloor?.y ?? 0,
      floorBasis: 'assumed 0 (level floor)',
      notes: ['The scene has no walls on this level and the scan gave no room outline.'],
    }
  }
  const polygon = proposal.polygon
  notes.push(
    'No walls exist on this level yet, so these are the edges of the room proposal (an estimate). Create the room first, then call this again to get real wall ids.',
  )
  return {
    walls: polygon.map((from, index) => ({
      id: `proposal-edge-${index}`,
      a: from,
      b: polygon[(index + 1) % polygon.length]!,
      ...(proposal.height ? { height: proposal.height.value } : {}),
    })),
    source: 'room-proposal',
    floorY: proposal.floorY ?? planeFloor?.y ?? 0,
    floorBasis:
      proposal.floorY !== null
        ? 'room proposal floor'
        : planeFloor
          ? 'plane-set floor'
          : 'assumed 0',
    notes,
  }
}

function requireOpengl(bundle: ScanBundle, scanId: string) {
  if (bundle.info?.camera?.convention !== 'opengl') {
    refuse(
      'camera_convention_unknown',
      `Scan ${scanId}: the camera axis convention is not known to be OpenGL, so photo poses cannot be used to lift boxes.`,
    )
  }
}

async function planScanSemantics(
  operations: SceneOperations,
  host: CaptureArtifactHost,
  input: { scanId: string; perWall?: number },
) {
  const node = findScan(operations, input.scanId)
  const bundle = await loadSemanticsBundle(host, node)
  const frames = bundle.rgb ?? []
  if (frames.length === 0) refuse('no_keyframes', `Scan ${node.id} has no photo keyframes.`)
  requireOpengl(bundle, node.id)
  const withDepth = new Set((bundle.depthIndex ?? []).map((entry) => entry.rgbKeyframeId))
  const usable: PlanFrame[] = frames.flatMap((frame): PlanFrame[] =>
    frame.trackingState === 'tracking' && frame.pose && frame.intrinsics && withDepth.has(frame.id)
      ? [
          {
            id: frame.id,
            imageWidth: frame.width,
            imageHeight: frame.height,
            intrinsics: frame.intrinsics,
            pose: frame.pose,
          },
        ]
      : [],
  )
  const source = await wallsFor(operations, host, bundle, node)
  if (source.walls.length === 0) {
    refuse(
      'no_walls',
      `Scan ${node.id}: ${source.notes.join(' ')} Create the room, then try again.`,
    )
  }
  const plans = pickKeyframesForWalls(source.walls, usable, {
    transform: bundle.transform,
    floorY: source.floorY,
    perWall: input.perWall,
  })
  const chosen = [...new Set(plans.flatMap((plan) => plan.frames.map((frame) => frame.frameId)))]
  const sizes = new Map(
    frames.map((frame) => [frame.id, { width: frame.width, height: frame.height }]),
  )
  return {
    scanId: node.id,
    levelId: node.parentId,
    coordinates: 'Level coordinates: [x, z] in metres, through the scan node transform.',
    wallSource: source.source,
    floorY: round(source.floorY),
    floorBasis: source.floorBasis,
    walls: plans.map((plan) => {
      const wall = source.walls.find((candidate) => candidate.id === plan.wallId)!
      return {
        wallId: plan.wallId,
        from: wall.a.map((value) => round(value)),
        to: wall.b.map((value) => round(value)),
        length: plan.length,
        keyframes: plan.frames,
        ...(plan.reason ? { reason: plan.reason } : {}),
      }
    }),
    keyframeIds: chosen,
    keyframeSizes: Object.fromEntries(chosen.map((id) => [id, sizes.get(id)])),
    usableKeyframes: usable.length,
    instructions: [
      'For each wall, call view_scan_photos with its keyframe ids (4 per call at most) and look at the photos.',
      'Mark doors (kind door), doorways with no leaf (opening), windows (window) and furniture or large fixtures (furniture) you can actually see, each with a tight box [x0, y0, x1, y1] in pixels of the full-size keyframe exactly as returned, even when the photo looks sideways (phones save the sensor orientation; do not turn it) (its size is in keyframeSizes and beside each photo; origin top left; scale up if you read a smaller view).',
      'Box a door or window by its frame or opening, not the wall around it. Box furniture by its visible extent. Do not mark what you cannot see.',
      `Give each a short label and a confidence from 0 to 1. Mark the same thing in every photo where it shows: two or more photos confirm it. Then call lift_scan_semantics with at most ${SEMANTICS_MAX_DETECTIONS} detections on at most ${SEMANTICS_MAX_FRAMES} keyframes.`,
    ],
    notes: source.notes,
    next: 'Nothing was written. Look at the photos, then call lift_scan_semantics with your detections.',
    ...(bundle.problems.length ? { unreadableStreams: bundle.problems } : {}),
  }
}

/** The depth frame of each wanted keyframe, with that keyframe's pose, from the artifact store. */
async function readLiftFrames(
  host: CaptureArtifactHost,
  bundle: ScanBundle,
  frameIds: readonly string[],
  problems: string[],
): Promise<LiftFrame[]> {
  const rgb = new Map((bundle.rgb ?? []).map((frame) => [frame.id, frame]))
  const depthByRgb = new Map((bundle.depthIndex ?? []).map((entry) => [entry.rgbKeyframeId, entry]))
  const out: LiftFrame[] = []
  for (const id of frameIds) {
    const frame = rgb.get(id)
    const entry = depthByRgb.get(id)
    if (!frame || !entry) {
      problems.push(`${id}: no photo keyframe with depth`)
      continue
    }
    if (frame.trackingState !== 'tracking' || !frame.pose || !frame.intrinsics) {
      problems.push(`${id}: the tracker had no usable pose for this keyframe`)
      continue
    }
    const sha256 = shaFromReference(entry.depth)
    const expected = entry.width * entry.height
    if (!sha256 || expected > 1_000_000) {
      problems.push(`${id}: depth artifact unreadable`)
      continue
    }
    const bytes = await host.read(sha256)
    if (!bytes || bytes.byteLength !== expected * 2) {
      problems.push(`${id}: depth artifact missing or wrongly sized`)
      continue
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const depth = new Uint16Array(expected)
    for (let pixel = 0; pixel < expected; pixel += 1) depth[pixel] = view.getUint16(pixel * 2, true)
    let confidence: Uint8Array | null = null
    const confidenceSha = entry.confidence ? shaFromReference(entry.confidence) : null
    if (confidenceSha) {
      const raw = await host.read(confidenceSha)
      if (raw && raw.byteLength === expected) confidence = Uint8Array.from(raw)
    }
    out.push({
      id,
      imageWidth: frame.width,
      imageHeight: frame.height,
      rgbIntrinsics: frame.intrinsics,
      depth: {
        id: entry.id,
        width: entry.width,
        height: entry.height,
        intrinsics: entry.intrinsics,
        pose: frame.pose,
        depth,
        confidence,
      },
    })
  }
  return out
}

function suggestedCalls(
  result: SemanticsResult,
  source: WallSource,
  levelId: string | null | undefined,
) {
  const real = source.source === 'scene-walls'
  const openings = result.openings.map((opening) => ({
    id: opening.id,
    status: opening.status,
    ...(real
      ? {
          call: {
            tool: opening.kind === 'window' ? 'add_window' : 'add_door',
            input: {
              wallId: opening.wallId,
              t: opening.t,
              width: opening.width,
              height: opening.height,
              ...(opening.sill > 0 || opening.kind === 'window'
                ? { sillHeight: opening.sill }
                : {}),
              ...(opening.kind === 'opening' ? { openingKind: 'opening' } : {}),
            },
          },
        }
      : {
          call: null,
          why: 'The wall is an edge of the room proposal. Create the room first, then call plan_scan_semantics and lift_scan_semantics again for real wall ids.',
        }),
  }))
  const furniture = result.furniture.map((item) => ({
    id: item.id,
    status: item.status,
    ...(item.floatingBase
      ? {
          floatingBase: `Its lowest seen surface is ${item.baseY} m (level Y); it may be wall-mounted or its legs were not seen. Place it at the floor only if it stands there.`,
        }
      : {}),
    steps: [
      {
        tool: 'search_assets',
        input: { queries: [{ query: item.label }] },
        note: 'Pick an asset whose size is close to size below; never guess an asset id.',
      },
      {
        tool: 'place_items',
        input: {
          items: [
            {
              assetId: '<an id from search_assets>',
              x: item.centre[0],
              z: item.centre[1],
              rotation: placeRotation(item.yawDegrees),
            },
          ],
          ...(levelId ? { levelId } : {}),
        },
        note: 'rotation turns the item about Y the way the editor does (positive turns +X toward -Z), set so its width axis lies along the box; the box width axis has no front, so check which way the item faces after placing it.',
      },
    ],
  }))
  return { openings, furniture }
}

async function liftScanSemantics(
  operations: SceneOperations,
  host: CaptureArtifactHost,
  input: { scanId: string; detections: SemanticDetection[] },
) {
  const frameIds = [...new Set(input.detections.map((detection) => detection.frameId))]
  if (frameIds.length > SEMANTICS_MAX_FRAMES) {
    refuse(
      'too_many_frames',
      `${frameIds.length} frames named; at most ${SEMANTICS_MAX_FRAMES} per call. Split the detections by frame.`,
    )
  }
  const node = findScan(operations, input.scanId)
  const bundle = await loadSemanticsBundle(host, node)
  if (!bundle.rgb?.length) refuse('no_keyframes', `Scan ${node.id} has no photo keyframes.`)
  if (!bundle.depthIndex?.length) refuse('no_depth', `Scan ${node.id} has no depth keyframes.`)
  requireOpengl(bundle, node.id)
  // Frame ids are checked first, so a call naming no real keyframe does no wall or floor work.
  const known = new Set(bundle.rgb.map((frame) => frame.id))
  const real = input.detections.filter((detection) => known.has(detection.frameId))
  const needsWalls = real.some((detection) => detection.kind !== 'furniture')
  const source: WallSource =
    real.length === 0
      ? {
          walls: [],
          source: 'none',
          floorY: 0,
          floorBasis: 'not computed: none of the named keyframes exists in this scan',
          notes: [],
        }
      : needsWalls
        ? await wallsFor(operations, host, bundle, node)
        : await (async (): Promise<WallSource> => {
            const floor = await floorFor(host, bundle, node)
            return {
              walls: sceneWalls(operations, node.parentId),
              source: 'scene-walls',
              floorY: floor.y,
              floorBasis: floor.basis,
              notes: [],
            }
          })()
  const problems = [...bundle.problems]
  const frames = await readLiftFrames(host, bundle, frameIds, problems)
  const options = { transform: bundle.transform, floorY: source.floorY }
  const lifted = liftDetections(input.detections, frames, source.walls, options)
  const result = clusterDetections(lifted, source.walls, options)
  const calls = suggestedCalls(result, source, node.parentId)
  const uncertain =
    result.openings.filter((item) => item.status === 'uncertain').length +
    result.furniture.filter((item) => item.status === 'uncertain').length
  return {
    scanId: node.id,
    levelId: node.parentId,
    coordinates:
      'Level metres through the scan node transform. Opening positions are metres from the wall start (from) along the wall; furniture centre is [x, z], yawDegrees turns the width axis from +x toward +z.',
    wallSource: source.source,
    floorY: round(source.floorY),
    floorBasis: source.floorBasis,
    doorsAndWindows: result.openings,
    furniture: result.furniture,
    unlifted: result.unlifted,
    summary: {
      detections: input.detections.length,
      confirmed: result.openings.length + result.furniture.length - uncertain,
      uncertain,
      unlifted: result.unlifted.length,
    },
    suggestedCalls: calls,
    notes: [
      ...source.notes,
      'Every value is an estimate from 160x90 phone depth and your boxes, not a measurement. Furniture size covers only the surfaces the camera saw, so depth and width are often small.',
      'Confirmed needs two sound views from different positions or headings. Anything with doubts (wall drift, little wall support, a box at the image edge, sparse depth) stays uncertain. Confidence is your detection confidence weighted by usable depth and scaled down unless confirmed; it is not an accuracy in metres.',
      ...(problems.length ? [`Frames not read: ${problems.join('; ')}`] : []),
    ],
    needsVerification: true,
    next: 'Nothing was written. Show the person each door, window and piece of furniture (confirmed and uncertain, with the evidence frames), let them correct or drop items, then create the confirmed ones with the suggested calls.',
  }
}

/** `plan_scan_semantics` and `lift_scan_semantics`; offered beside the scan tools. */
export function registerScanSemanticsTools(
  server: McpServer,
  operations: SceneOperations,
  host: CaptureArtifactHost,
): void {
  register(server, planScanSemanticsTool, (input) => planScanSemantics(operations, host, input))
  register(server, liftScanSemanticsTool, (input) => liftScanSemantics(operations, host, input))
}
