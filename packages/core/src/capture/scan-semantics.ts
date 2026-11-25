import type { DepthFrameInput } from './depth-walls'
import {
  captureDirectionToLevel,
  captureToLevel,
  type ScanTransform,
  type Vec2,
  type Vec3,
} from './plane-analysis'
import type { CameraIntrinsics } from './streams'

/**
 * Agent-driven semantics for a scan: doors, windows and furniture marked in photos, lifted to level
 * metres with the raw depth, and merged across views.
 *
 * Everything here is an estimate from phone depth at 160x90, never a measurement. The structured
 * output follows SpatialLM's grammar (`Door/Window(wall, centre, width, height)` and
 * `Bbox(class, centre, yaw, size)`): openings are positions along a wall, furniture is a yawed box.
 */

export type SemanticKind = 'door' | 'window' | 'opening' | 'furniture'

export type SemanticDetection = {
  frameId: string
  label: string
  kind: SemanticKind
  /** `[x0, y0, x1, y1]` in pixels of the RGB keyframe, origin top left. */
  box2d: readonly [number, number, number, number]
  /** The agent's confidence, 0 to 1. */
  confidence: number
}

/** A straight wall in level coordinates. */
export type SemanticWall = {
  id: string
  a: Vec2
  b: Vec2
  /** Metres; used to judge whether an opening fits. */
  height?: number
}

export type PlanFrame = {
  id: string
  imageWidth: number
  imageHeight: number
  /** Intrinsics of the RGB image, in its own pixels. */
  intrinsics: CameraIntrinsics
  /** Column-major OpenGL camera-to-world matrix in the capture world. */
  pose: readonly number[]
}

export type LiftFrame = {
  /** The RGB keyframe id the agent's boxes refer to. */
  id: string
  imageWidth: number
  imageHeight: number
  /** The depth frame with the pose of that keyframe. */
  depth: DepthFrameInput
}

export type SemanticsOptions = {
  transform: ScanTransform
  /** Level height of the floor the walls stand on, metres. Default 0. */
  floorY?: number
  /** Lowest raw-depth confidence kept, 0 to 255. Default 64. */
  minDepthConfidence?: number
}

type Basis = { origin: Vec3; right: Vec3; up: Vec3; back: Vec3 }

const DEFAULT_FLOOR_Y = 0
const DEFAULT_MIN_CONFIDENCE = 64
const MAX_DEPTH_MM = 10_000
/** Fewer valid depth pixels than this in a box (or its ring) cannot place anything. */
const MIN_SAMPLES = 4
/** A box whose valid depth share is below this sits over a depth hole. */
const MIN_VALID_FRACTION = 0.1
/** Points further than this from a wall plane do not belong to it. */
const WALL_SNAP_METRES = 0.3
const WALL_SUPPORT_FRACTION = 0.4
/** Furniture points this close to a wall plane or the floor are surface, not furniture. */
const SURFACE_MARGIN = 0.08
/** Depth behind the nearest part of a box that still counts as the object. */
const OBJECT_DEPTH_SLACK = 1.2
const MAX_POINTS = 1500
const WALL_YAW_SNAP = (10 * Math.PI) / 180

const round = (value: number, places = 3): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[index]!
}

const sortNumbers = (values: readonly number[]) => [...values].sort((a, b) => a - b)
const median = (values: readonly number[]) => percentile(sortNumbers(values), 0.5)

function cameraBasis(pose: readonly number[], transform: ScanTransform): Basis {
  return {
    origin: captureToLevel(transform, [pose[12]!, pose[13]!, pose[14]!]),
    right: captureDirectionToLevel(transform, [pose[0]!, pose[1]!, pose[2]!]),
    up: captureDirectionToLevel(transform, [pose[4]!, pose[5]!, pose[6]!]),
    back: captureDirectionToLevel(transform, [pose[8]!, pose[9]!, pose[10]!]),
  }
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The viewing ray of an image-plane position `(u, v)`, in level coordinates. */
function rayThrough(
  basis: Basis,
  intrinsics: CameraIntrinsics,
  u: number,
  v: number,
): { origin: Vec3; dir: Vec3 } {
  const x = (u - intrinsics.cx) / intrinsics.fx
  const y = (intrinsics.cy - v) / intrinsics.fy
  const dir: Vec3 = [
    basis.right[0] * x + basis.up[0] * y - basis.back[0],
    basis.right[1] * x + basis.up[1] * y - basis.back[1],
    basis.right[2] * x + basis.up[2] * y - basis.back[2],
  ]
  return { origin: basis.origin, dir }
}

type WallFrame = { wall: SemanticWall; length: number; u: Vec2; n: Vec2 }

function wallFrame(wall: SemanticWall): WallFrame | null {
  const dx = wall.b[0] - wall.a[0]
  const dz = wall.b[1] - wall.a[1]
  const length = Math.hypot(dx, dz)
  if (length < 1e-6) return null
  const u: Vec2 = [dx / length, dz / length]
  return { wall, length, u, n: [-u[1], u[0]] }
}

/** Signed distance to the wall plane, and distance along it from the wall start. */
function inWallFrame(frame: WallFrame, x: number, z: number): { d: number; s: number } {
  const px = x - frame.wall.a[0]
  const pz = z - frame.wall.a[1]
  return { d: px * frame.n[0] + pz * frame.n[1], s: px * frame.u[0] + pz * frame.u[1] }
}

function rayHitsWall(
  frame: WallFrame,
  ray: { origin: Vec3; dir: Vec3 },
): { s: number; y: number } | null {
  const denom = ray.dir[0] * frame.n[0] + ray.dir[2] * frame.n[1]
  const norm = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2])
  if (Math.abs(denom) / norm < 0.12) return null
  const t =
    ((frame.wall.a[0] - ray.origin[0]) * frame.n[0] +
      (frame.wall.a[1] - ray.origin[2]) * frame.n[1]) /
    denom
  if (t <= 0) return null
  const x = ray.origin[0] + t * ray.dir[0]
  const z = ray.origin[2] + t * ray.dir[2]
  return { s: inWallFrame(frame, x, z).s, y: ray.origin[1] + t * ray.dir[1] }
}

// ---------------------------------------------------------------------------------------------
// (a) Which keyframes to look at, per wall
// ---------------------------------------------------------------------------------------------

export type WallKeyframeChoice = {
  frameId: string
  /** 0 to 1: coverage x distance x frontal angle. */
  score: number
  /** Metres from the camera to the wall plane. */
  distance: number
  /** Degrees between the viewing direction and the wall normal; 0 is square on. */
  angleDeg: number
  /** Wall length in frame against the 3 m a frame can usefully hold, 0 to 1. */
  coverage: number
}

export type WallKeyframePlan = {
  wallId: string
  length: number
  frames: WallKeyframeChoice[]
  /** Set when no frame qualified. */
  reason?: string
}

const MIN_VIEW_DISTANCE = 1
const MAX_VIEW_DISTANCE = 4
const MIN_COVERAGE = 0.3
const MIN_FRONTAL_COS = 0.5

function distanceScore(distance: number): number {
  if (distance < MIN_VIEW_DISTANCE || distance > MAX_VIEW_DISTANCE) return 0
  if (distance < 1.5) return 0.4 + (0.6 * (distance - MIN_VIEW_DISTANCE)) / 0.5
  if (distance <= 3) return 1
  return 1 - (0.6 * (distance - 3)) / (MAX_VIEW_DISTANCE - 3)
}

/**
 * A few frontal keyframes per wall: close enough (1 to 4 m) to read, square on, and with the wall
 * inside the frame. Chosen cameras differ in position or heading so the views are not duplicates.
 */
export function pickKeyframesForWalls(
  walls: readonly SemanticWall[],
  frames: readonly PlanFrame[],
  options: SemanticsOptions & { perWall?: number },
): WallKeyframePlan[] {
  const floorY = options.floorY ?? DEFAULT_FLOOR_Y
  const perWall = options.perWall ?? 3
  const bases = frames.map((frame) => cameraBasis(frame.pose, options.transform))
  return walls.map((wall) => {
    const frame = wallFrame(wall)
    if (!frame) return { wallId: wall.id, length: 0, frames: [], reason: 'zero-length wall' }
    const heights = [0.5, 1.2, 2].map((offset) => floorY + offset)
    // Columns every half metre along the wall, three heights each. A frame cannot hold a long wall,
    // so coverage counts the columns it sees against at most six (3 m of wall).
    const columnCount = Math.min(24, Math.max(4, Math.round(frame.length / 0.5)))
    const columns: Vec3[][] = Array.from({ length: columnCount }, (_, column) => {
      const s = (frame.length * (column + 0.5)) / columnCount
      return heights.map((y): Vec3 => [wall.a[0] + frame.u[0] * s, y, wall.a[1] + frame.u[1] * s])
    })
    const needed = Math.min(columnCount, 6)
    const scored: Array<WallKeyframeChoice & { s: number; heading: number }> = []
    frames.forEach((camera, index) => {
      const basis = bases[index]!
      const { d, s } = inWallFrame(frame, basis.origin[0], basis.origin[2])
      const distance = Math.abs(d)
      const forwardLen = Math.hypot(basis.back[0], basis.back[2])
      if (forwardLen < 1e-6) return
      const forward: Vec2 = [-basis.back[0] / forwardLen, -basis.back[2] / forwardLen]
      const facing = forward[0] * frame.n[0] + forward[1] * frame.n[1]
      // The camera must stand on one side and look toward the wall.
      if (d * facing >= 0) return
      const cosAngle = Math.abs(facing)
      const range = distanceScore(distance)
      if (cosAngle < MIN_FRONTAL_COS || range === 0) return
      let seen = 0
      for (const column of columns) {
        let inside = 0
        for (const point of column) {
          const rel: Vec3 = [
            point[0] - basis.origin[0],
            point[1] - basis.origin[1],
            point[2] - basis.origin[2],
          ]
          const depth = -dot3(rel, basis.back)
          if (depth <= 0.05) continue
          const u = camera.intrinsics.cx + (camera.intrinsics.fx * dot3(rel, basis.right)) / depth
          const v = camera.intrinsics.cy - (camera.intrinsics.fy * dot3(rel, basis.up)) / depth
          const margin = 0.02
          if (
            u >= margin * camera.imageWidth &&
            u <= (1 - margin) * camera.imageWidth &&
            v >= margin * camera.imageHeight &&
            v <= (1 - margin) * camera.imageHeight
          ) {
            inside += 1
          }
        }
        if (inside >= 2) seen += 1
      }
      const coverage = Math.min(1, seen / needed)
      if (coverage < MIN_COVERAGE) return
      scored.push({
        frameId: camera.id,
        score: round(coverage * range * cosAngle),
        distance: round(distance, 2),
        angleDeg: round((Math.acos(Math.min(1, cosAngle)) * 180) / Math.PI, 1),
        coverage: round(coverage, 2),
        s,
        heading: Math.atan2(forward[1], forward[0]),
      })
    })
    scored.sort((left, right) => right.score - left.score)
    const chosen: typeof scored = []
    for (const candidate of scored) {
      if (chosen.length >= perWall) break
      const redundant = chosen.some((kept) => {
        let turn = Math.abs(candidate.heading - kept.heading)
        if (turn > Math.PI) turn = 2 * Math.PI - turn
        return Math.abs(candidate.s - kept.s) < 0.5 && turn < (20 * Math.PI) / 180
      })
      if (!redundant) chosen.push(candidate)
    }
    return {
      wallId: wall.id,
      length: round(frame.length, 2),
      frames: chosen.map(({ s: _s, heading: _heading, ...choice }) => choice),
      ...(chosen.length === 0
        ? {
            reason:
              'no keyframe stood 1 to 4 m from this wall, looked at it within 60 degrees of square on, and had it in frame',
          }
        : {}),
    }
  })
}

// ---------------------------------------------------------------------------------------------
// (b) Lifting one detection
// ---------------------------------------------------------------------------------------------

export type UnliftReason =
  | 'frame_not_found'
  | 'no_walls'
  | 'box_outside_image'
  | 'no_depth'
  | 'no_wall_near'
  | 'no_object_points'
  | 'wall_view_too_oblique'

export type LiftedOpening = {
  wallId: string
  /** Metres from the wall start (`a`) to the opening's centre along the wall. */
  positionAlongWall: number
  width: number
  height: number
  /** Height of the opening's bottom above the floor, metres. */
  sill: number
  /** True when the opening would reach past either end of the wall. */
  beyondWallEnds: boolean
  /** Median signed offset of the depth points beside the box from the wall line, metres. */
  wallOffset: number
  ringSamples: number
}

export type LiftedBox = {
  /** Footprint centre `[x, z]` in level metres. */
  centre: Vec2
  baseY: number
  /** Radians about +Y of the width axis, measured from +X toward +Z, in `[0, pi)`. */
  yaw: number
  width: number
  depth: number
  height: number
  yawSnappedToWall: string | null
  pointCount: number
}

export type LiftOutcome =
  | { ok: true; opening: LiftedOpening; box?: undefined; points?: undefined }
  | { ok: true; box: LiftedBox; points: Vec3[]; opening?: undefined }
  | {
      ok: false
      reason: UnliftReason
      detail: string
      opening?: undefined
      box?: undefined
      points?: undefined
    }

export type LiftedDetection = { index: number; detection: SemanticDetection } & LiftOutcome

type DepthSamples = {
  points: Vec3[]
  depths: number[]
  total: number
}

function depthPoints(
  frame: LiftFrame,
  options: SemanticsOptions,
  pixels: Array<[number, number]>,
): DepthSamples {
  const { depth } = frame
  const minConfidence = options.minDepthConfidence ?? DEFAULT_MIN_CONFIDENCE
  const pose = depth.pose
  const points: Vec3[] = []
  const depths: number[] = []
  for (const [px, py] of pixels) {
    const index = py * depth.width + px
    const mm = depth.depth[index]!
    if (mm === 0 || mm > MAX_DEPTH_MM) continue
    if (depth.confidence && depth.confidence[index]! < minConfidence) continue
    const d = mm / 1000
    // ARCore sample convention: X = d(x - cx)/fx, Y = d(cy - y)/fy, Z = -d, at the pixel centre.
    const x = (d * (px + 0.5 - depth.intrinsics.cx)) / depth.intrinsics.fx
    const y = (d * (depth.intrinsics.cy - (py + 0.5))) / depth.intrinsics.fy
    const z = -d
    const world: Vec3 = [
      pose[0]! * x + pose[4]! * y + pose[8]! * z + pose[12]!,
      pose[1]! * x + pose[5]! * y + pose[9]! * z + pose[13]!,
      pose[2]! * x + pose[6]! * y + pose[10]! * z + pose[14]!,
    ]
    points.push(captureToLevel(options.transform, world))
    depths.push(d)
  }
  return { points, depths, total: pixels.length }
}

type DepthBox = { x0: number; y0: number; x1: number; y1: number }

function depthBox(frame: LiftFrame, box: SemanticDetection['box2d']): DepthBox | null {
  const sx = frame.depth.width / frame.imageWidth
  const sy = frame.depth.height / frame.imageHeight
  const left = Math.max(0, Math.min(box[0], box[2]))
  const right = Math.min(frame.imageWidth, Math.max(box[0], box[2]))
  const top = Math.max(0, Math.min(box[1], box[3]))
  const bottom = Math.min(frame.imageHeight, Math.max(box[1], box[3]))
  if (right - left < 2 || bottom - top < 2) return null
  const x0 = Math.min(frame.depth.width - 1, Math.floor(left * sx))
  const y0 = Math.min(frame.depth.height - 1, Math.floor(top * sy))
  const x1 = Math.max(x0, Math.min(frame.depth.width - 1, Math.ceil(right * sx) - 1))
  const y1 = Math.max(y0, Math.min(frame.depth.height - 1, Math.ceil(bottom * sy) - 1))
  return { x0, y0, x1, y1 }
}

function boxPixels(box: DepthBox): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let y = box.y0; y <= box.y1; y += 1)
    for (let x = box.x0; x <= box.x1; x += 1) out.push([x, y])
  return out
}

/** One depth pixel just inside the box edge and one just outside it: the wall around an opening. */
function ringPixels(box: DepthBox, width: number, height: number): Array<[number, number]> {
  const seen = new Set<number>()
  const out: Array<[number, number]> = []
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const key = y * width + x
    if (seen.has(key)) return
    seen.add(key)
    out.push([x, y])
  }
  for (const margin of [0, 1]) {
    const x0 = box.x0 - margin
    const x1 = box.x1 + margin
    const y0 = box.y0 - margin
    const y1 = box.y1 + margin
    for (let x = x0; x <= x1; x += 1) {
      add(x, y0)
      add(x, y1)
    }
    for (let y = y0; y <= y1; y += 1) {
      add(x0, y)
      add(x1, y)
    }
  }
  return out
}

function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items]
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]!)
}

function liftOpening(
  detection: SemanticDetection,
  frame: LiftFrame,
  box: DepthBox,
  walls: WallFrame[],
  options: SemanticsOptions,
): LiftOutcome {
  const floorY = options.floorY ?? DEFAULT_FLOOR_Y
  const ring = depthPoints(frame, options, ringPixels(box, frame.depth.width, frame.depth.height))
  if (ring.points.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: 'no_depth',
      detail: `Only ${ring.points.length} of ${ring.total} depth pixels around the box edges are usable, so the wall beside it was not seen.`,
    }
  }
  // The wall that most of the edge points lie on.
  let best: { wall: WallFrame; support: number; offset: number } | null = null
  for (const wall of walls) {
    const near: number[] = []
    for (const point of ring.points) {
      const { d, s } = inWallFrame(wall, point[0], point[2])
      if (Math.abs(d) <= WALL_SNAP_METRES && s >= -0.2 && s <= wall.length + 0.2) near.push(d)
    }
    const support = near.length / ring.points.length
    if (!best || support > best.support) {
      best = { wall, support, offset: near.length ? median(near) : 0 }
    }
  }
  if (!best || best.support < WALL_SUPPORT_FRACTION) {
    return {
      ok: false,
      reason: 'no_wall_near',
      detail: `No known wall lies within ${WALL_SNAP_METRES} m of the depth points beside the box (best support ${round(best?.support ?? 0, 2)}).`,
    }
  }
  const sx = frame.depth.width / frame.imageWidth
  const sy = frame.depth.height / frame.imageHeight
  const left = Math.min(detection.box2d[0], detection.box2d[2])
  const right = Math.max(detection.box2d[0], detection.box2d[2])
  const top = Math.min(detection.box2d[1], detection.box2d[3])
  const bottom = Math.max(detection.box2d[1], detection.box2d[3])
  const basis = cameraBasis(frame.depth.pose, options.transform)
  const cast = (u: number, v: number) =>
    rayHitsWall(best!.wall, rayThrough(basis, frame.depth.intrinsics, u * sx, v * sy))
  // Corners and edge midpoints, so a photo in sensor orientation (rolled a quarter turn) works too:
  // width is the extent along the wall and height the extent in Y, whichever way the image runs.
  const midU = (left + right) / 2
  const midV = (top + bottom) / 2
  const hits = [
    cast(left, top),
    cast(right, top),
    cast(left, bottom),
    cast(right, bottom),
    cast(left, midV),
    cast(right, midV),
    cast(midU, top),
    cast(midU, bottom),
  ]
  if (hits.some((hit) => hit === null)) {
    return {
      ok: false,
      reason: 'wall_view_too_oblique',
      detail:
        'The viewing rays at the box edges meet the wall at too shallow an angle to place them.',
    }
  }
  const along = hits.map((hit) => hit!.s)
  const up = hits.map((hit) => hit!.y)
  const width = Math.max(...along) - Math.min(...along)
  const centre = (Math.max(...along) + Math.min(...along)) / 2
  const height = Math.max(...up) - Math.min(...up)
  let sill = Math.min(...up) - floorY
  // A door whose bottom edge is within a few centimetres of the floor stands on it.
  if (detection.kind !== 'window' && sill < 0.1) sill = 0
  return {
    ok: true,
    opening: {
      wallId: best.wall.wall.id,
      positionAlongWall: round(centre),
      width: round(width),
      height: round(height),
      sill: round(Math.max(0, sill)),
      beyondWallEnds: centre - width / 2 < -0.05 || centre + width / 2 > best.wall.length + 0.05,
      wallOffset: round(best.offset),
      ringSamples: ring.points.length,
    },
  }
}

/**
 * Smallest-area yawed rectangle around the footprint, on trimmed extents (3rd to 97th percentile)
 * so stray points do not stretch it. Yaw snaps to a wall direction when within ten degrees.
 */
export function fitOrientedBox(
  points: readonly Vec3[],
  walls: readonly SemanticWall[],
  floorY = DEFAULT_FLOOR_Y,
): LiftedBox | null {
  if (points.length < MIN_SAMPLES) return null
  const extent = (yaw: number) => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const along = sortNumbers(points.map((p) => p[0] * c + p[2] * s))
    const across = sortNumbers(points.map((p) => -p[0] * s + p[2] * c))
    const a0 = percentile(along, 0.03)
    const a1 = percentile(along, 0.97)
    const b0 = percentile(across, 0.03)
    const b1 = percentile(across, 0.97)
    return { a0, a1, b0, b1, area: (a1 - a0) * (b1 - b0) }
  }
  let yaw = 0
  let fit = extent(0)
  for (let degrees = 1; degrees < 90; degrees += 1) {
    const candidate = extent((degrees * Math.PI) / 180)
    if (candidate.area < fit.area - 1e-9) {
      fit = candidate
      yaw = (degrees * Math.PI) / 180
    }
  }
  let snapped: string | null = null
  let bestTurn = WALL_YAW_SNAP
  for (const wall of walls) {
    const direction = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0])
    // Wall directions and the box axes both repeat every quarter turn.
    let turn = (((direction - yaw) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
    if (turn > Math.PI / 4) turn -= Math.PI / 2
    if (Math.abs(turn) < bestTurn) {
      bestTurn = Math.abs(turn)
      snapped = wall.id
      yaw = yaw + turn
    }
  }
  if (snapped) fit = extent(yaw)
  let width = fit.a1 - fit.a0
  let depth = fit.b1 - fit.b0
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const ca = (fit.a0 + fit.a1) / 2
  const cb = (fit.b0 + fit.b1) / 2
  const centre: Vec2 = [ca * c - cb * s, ca * s + cb * c]
  if (depth > width) {
    ;[width, depth] = [depth, width]
    yaw += Math.PI / 2
  }
  yaw = ((yaw % Math.PI) + Math.PI) % Math.PI
  const top = percentile(sortNumbers(points.map((p) => p[1])), 0.97)
  return {
    centre: [round(centre[0]), round(centre[1])],
    baseY: round(floorY),
    yaw: round(yaw, 4),
    width: round(width),
    depth: round(depth),
    height: round(Math.max(0.05, top - floorY)),
    yawSnappedToWall: snapped,
    pointCount: points.length,
  }
}

function liftFurniture(
  frame: LiftFrame,
  box: DepthBox,
  walls: WallFrame[],
  options: SemanticsOptions,
): LiftOutcome {
  const floorY = options.floorY ?? DEFAULT_FLOOR_Y
  const samples = depthPoints(frame, options, boxPixels(box))
  if (
    samples.points.length < MIN_SAMPLES ||
    samples.points.length / samples.total < MIN_VALID_FRACTION
  ) {
    return {
      ok: false,
      reason: 'no_depth',
      detail: `${samples.points.length} of ${samples.total} depth pixels in the box are usable: the box sits over a depth hole (dark, shiny or glass surface, or out of range).`,
    }
  }
  // Keep what is near the camera end of the box, then drop wall and floor surface.
  const nearest = percentile(sortNumbers(samples.depths), 0.2)
  const kept = samples.points.filter((point, index) => {
    if (samples.depths[index]! > nearest + OBJECT_DEPTH_SLACK) return false
    if (point[1] < floorY + SURFACE_MARGIN) return false
    return !walls.some((wall) => Math.abs(inWallFrame(wall, point[0], point[2]).d) < SURFACE_MARGIN)
  })
  if (kept.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: 'no_object_points',
      detail: 'Everything in the box was floor, wall surface or far behind the object.',
    }
  }
  const fit = fitOrientedBox(
    kept,
    walls.map((wall) => wall.wall),
    floorY,
  )
  if (!fit) {
    return { ok: false, reason: 'no_object_points', detail: 'Too few points to fit a box.' }
  }
  return { ok: true, box: fit, points: thin(kept, MAX_POINTS) }
}

/**
 * Lifts each detection with its keyframe's raw depth. Doors and windows snap to the wall most of
 * the depth points around the box edges lie on, and take their extent from the viewing rays at the
 * box edges meeting that wall; furniture gets an oriented box from the depth points inside the box.
 * A detection that cannot be lifted says why instead of guessing.
 */
export function liftDetections(
  detections: readonly SemanticDetection[],
  frames: readonly LiftFrame[],
  walls: readonly SemanticWall[],
  options: SemanticsOptions,
): LiftedDetection[] {
  const byId = new Map(frames.map((frame) => [frame.id, frame]))
  const wallFrames = walls.map(wallFrame).filter((frame): frame is WallFrame => frame !== null)
  return detections.map((detection, index) => {
    const base = { index, detection }
    const frame = byId.get(detection.frameId)
    if (!frame) {
      return {
        ...base,
        ok: false as const,
        reason: 'frame_not_found' as const,
        detail: `No depth for keyframe ${detection.frameId}.`,
      }
    }
    const box = depthBox(frame, detection.box2d)
    if (!box) {
      return {
        ...base,
        ok: false as const,
        reason: 'box_outside_image' as const,
        detail: 'The box is empty or outside the image.',
      }
    }
    if (detection.kind !== 'furniture' && wallFrames.length === 0) {
      return {
        ...base,
        ok: false as const,
        reason: 'no_walls' as const,
        detail: 'Doors and windows need walls to snap to.',
      }
    }
    const lifted =
      detection.kind === 'furniture'
        ? liftFurniture(frame, box, wallFrames, options)
        : liftOpening(detection, frame, box, wallFrames, options)
    return { ...base, ...lifted } as LiftedDetection
  })
}

// ---------------------------------------------------------------------------------------------
// (c) Clustering across views
// ---------------------------------------------------------------------------------------------

export type SemanticStatus = 'confirmed' | 'uncertain'

type Common = {
  id: string
  label: string
  /** Distinct keyframes that saw it. Two or more is `confirmed`. */
  viewCount: number
  status: SemanticStatus
  /** Mean detection confidence, times 0.6 when only one view saw it. Not an accuracy in metres. */
  confidence: number
  evidenceFrameIds: string[]
  /** Always `estimate`: a draft for a person to verify on site. */
  basis: 'estimate'
}

export type SemanticOpening = Common & {
  kind: 'door' | 'window' | 'opening'
  wallId: string
  positionAlongWall: number
  /** Position as a fraction of the wall length, for `add_door` and `add_window`. */
  t: number
  width: number
  height: number
  sill: number
  centre: Vec3
  beyondWallEnds: boolean
}

export type SemanticFurniture = Common & {
  kind: 'furniture'
  centre: Vec2
  baseY: number
  yawDegrees: number
  size: { width: number; depth: number; height: number }
  yawSnappedToWall: string | null
}

export type SemanticsResult = {
  openings: SemanticOpening[]
  furniture: SemanticFurniture[]
  unlifted: Array<{
    index: number
    frameId: string
    label: string
    kind: SemanticKind
    reason: UnliftReason
    detail: string
  }>
}

const normalise = (label: string) => label.trim().toLowerCase().replace(/\s+/g, ' ')

type Cluster = {
  members: LiftedDetection[]
}

function matches(cluster: Cluster, candidate: LiftedDetection & { ok: true }): boolean {
  const seed = cluster.members[0]!
  if (!seed.ok || seed.detection.kind !== candidate.detection.kind) return false
  if (seed.opening && candidate.opening) {
    if (seed.opening.wallId !== candidate.opening.wallId) return false
    const gap = Math.abs(seed.opening.positionAlongWall - candidate.opening.positionAlongWall)
    return gap < Math.max(0.4, 0.5 * Math.min(seed.opening.width, candidate.opening.width))
  }
  if (seed.box && candidate.box) {
    if (normalise(seed.detection.label) !== normalise(candidate.detection.label)) return false
    const gap = Math.hypot(
      seed.box.centre[0] - candidate.box.centre[0],
      seed.box.centre[1] - candidate.box.centre[1],
    )
    const size = Math.min(
      Math.max(seed.box.width, seed.box.depth),
      Math.max(candidate.box.width, candidate.box.depth),
    )
    return gap < Math.max(0.5, 0.6 * size)
  }
  return false
}

function meanConfidence(members: readonly LiftedDetection[]): number {
  return members.reduce((sum, member) => sum + member.detection.confidence, 0) / members.length
}

function commonOf(id: string, members: LiftedDetection[]): Common {
  const frames = [...new Set(members.map((member) => member.detection.frameId))]
  const viewCount = frames.length
  const labels = new Map<string, number>()
  for (const member of members) {
    const label = member.detection.label.trim()
    labels.set(label, (labels.get(label) ?? 0) + 1)
  }
  const label = [...labels.entries()].sort((l, r) => r[1] - l[1])[0]![0]
  const confirmed = viewCount >= 2
  return {
    id,
    label,
    viewCount,
    status: confirmed ? 'confirmed' : 'uncertain',
    confidence: round(Math.min(1, Math.max(0, meanConfidence(members) * (confirmed ? 1 : 0.6))), 2),
    evidenceFrameIds: frames,
    basis: 'estimate',
  }
}

/**
 * Merges lifted detections of the same thing seen in several keyframes: openings on the same wall
 * at nearly the same position, furniture with the same label and a nearby centre. Two or more
 * distinct keyframes make a cluster `confirmed`; one leaves it `uncertain`.
 */
export function clusterDetections(
  lifted: readonly LiftedDetection[],
  walls: readonly SemanticWall[],
  options: Pick<SemanticsOptions, 'floorY'> = {},
): SemanticsResult {
  const floorY = options.floorY ?? DEFAULT_FLOOR_Y
  const wallLengths = new Map(
    walls.map((wall) => [wall.id, Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1])]),
  )
  const wallById = new Map(walls.map((wall) => [wall.id, wall]))
  const clusters: Cluster[] = []
  const unlifted: SemanticsResult['unlifted'] = []
  const ordered = [...lifted].sort(
    (left, right) => right.detection.confidence - left.detection.confidence,
  )
  for (const item of ordered) {
    if (!item.ok) {
      unlifted.push({
        index: item.index,
        frameId: item.detection.frameId,
        label: item.detection.label,
        kind: item.detection.kind,
        reason: item.reason,
        detail: item.detail,
      })
      continue
    }
    const home = clusters.find((cluster) => matches(cluster, item))
    if (home) home.members.push(item)
    else clusters.push({ members: [item] })
  }
  const counters = { door: 0, window: 0, opening: 0, furniture: 0 }
  const openings: SemanticOpening[] = []
  const furniture: SemanticFurniture[] = []
  const sorted = [...clusters].sort((left, right) => {
    const a = left.members[0]!
    const b = right.members[0]!
    if (a.opening && b.opening) {
      return (
        a.opening.wallId.localeCompare(b.opening.wallId) ||
        a.opening.positionAlongWall - b.opening.positionAlongWall
      )
    }
    return (a.box?.centre[0] ?? 0) - (b.box?.centre[0] ?? 0)
  })
  for (const cluster of sorted) {
    const first = cluster.members[0]!
    if (first.ok && first.opening) {
      const kind = first.detection.kind as 'door' | 'window' | 'opening'
      counters[kind] += 1
      const parts = cluster.members.map((member) => member.opening!)
      const wall = wallById.get(first.opening.wallId)!
      const length = wallLengths.get(first.opening.wallId) ?? 1
      const position = median(parts.map((part) => part.positionAlongWall))
      const sill = median(parts.map((part) => part.sill))
      const height = median(parts.map((part) => part.height))
      const unit: Vec2 = [(wall.b[0] - wall.a[0]) / length, (wall.b[1] - wall.a[1]) / length]
      openings.push({
        ...commonOf(`${kind}_${counters[kind]}`, cluster.members),
        kind,
        wallId: first.opening.wallId,
        positionAlongWall: round(position),
        t: round(Math.min(1, Math.max(0, position / length)), 4),
        width: round(median(parts.map((part) => part.width))),
        height: round(height),
        sill: round(sill),
        centre: [
          round(wall.a[0] + unit[0] * position),
          round(floorY + sill + height / 2),
          round(wall.a[1] + unit[1] * position),
        ],
        beyondWallEnds: parts.some((part) => part.beyondWallEnds),
      })
    } else if (first.ok && first.box) {
      counters.furniture += 1
      const points = cluster.members.flatMap((member) => member.points ?? [])
      const merged =
        cluster.members.length > 1
          ? (fitOrientedBox(thin(points, MAX_POINTS * 2), walls, floorY) ?? first.box)
          : first.box
      furniture.push({
        ...commonOf(`furniture_${counters.furniture}`, cluster.members),
        kind: 'furniture',
        centre: merged.centre,
        baseY: merged.baseY,
        yawDegrees: round((merged.yaw * 180) / Math.PI, 1),
        size: { width: merged.width, depth: merged.depth, height: merged.height },
        yawSnappedToWall: merged.yawSnappedToWall,
      })
    }
  }
  return { openings, furniture, unlifted }
}
