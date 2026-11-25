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
  /** Intrinsics of the RGB image, in its own pixels. Boxes are mapped to depth through these. */
  rgbIntrinsics: CameraIntrinsics
  /** The depth frame with the pose of that keyframe; its own intrinsics may differ in field of view. */
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
const MIN_SAMPLES = 12
/** A box whose valid depth share is below this sits over a depth hole. */
const MIN_VALID_FRACTION = 0.3
/** Wall evidence thresholds: past these an opening is flagged doubtful. */
const MAX_WALL_OFFSET = 0.15
const MIN_RING_SUPPORT = 0.6
/** Least a furniture box may be refused as a whole-frame or runaway box. */
const MAX_BOX_AREA_FRACTION = 0.6
/** Furniture boxes lifted per frame; the rest are refused. */
const MAX_FURNITURE_PER_FRAME = 20
const MAX_BOX_PIXELS = 2500
const FIT_POINTS = 600
/** Two views confirm each other only from this far apart or this much turned. */
const MIN_BASELINE = 0.5
/** Padding added to furniture footprints when comparing views, metres. */
const MATCH_PAD = 0.4
const MIN_TURN = (15 * Math.PI) / 180
/** Points further than this from a wall plane do not belong to it. */
const WALL_SNAP_METRES = 0.3
const WALL_SUPPORT_FRACTION = 0.4
/** Furniture points this close to a wall plane or the floor are surface, not furniture. */
const SURFACE_MARGIN = 0.06
/** A base within this of the floor stands on it; higher is flagged floating. */
const FLOOR_CONTACT = 0.15
/** Depth behind the nearest part of a box that still counts as the object. */
const OBJECT_DEPTH_SLACK = 0.6
const MAX_POINTS = 600
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
  /** Shift of the plane along the wall normal, metres: where depth says the wall really is. */
  offset = 0,
): { s: number; y: number } | null {
  const denom = ray.dir[0] * frame.n[0] + ray.dir[2] * frame.n[1]
  const norm = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2])
  if (Math.abs(denom) / norm < 0.12) return null
  const t =
    ((frame.wall.a[0] - ray.origin[0]) * frame.n[0] +
      (frame.wall.a[1] - ray.origin[2]) * frame.n[1] +
      offset) /
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
  | 'box_too_large'
  | 'too_many_boxes_in_frame'
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
  /** Median signed offset of the depth points beside the box from the plan wall line, metres. Rays are cast at the offset plane. */
  wallOffset: number
  /** Share of the usable depth points beside the box that lie on the wall. */
  ringSupport: number
  /** Share of the depth pixels around the box edges that were usable. */
  validFraction: number
  ringSamples: number
  /** Reasons to trust it less; any one keeps a result `uncertain`. */
  doubts: string[]
}

export type LiftedBox = {
  /** Footprint centre `[x, z]` in level metres. */
  centre: Vec2
  /** Lowest seen surface, level Y; snapped to the floor when within 0.15 m of it. */
  baseY: number
  topY: number
  /** Radians about +Y of the width axis, measured from +X toward +Z, in `[0, pi)`. */
  yaw: number
  width: number
  depth: number
  /** Top minus base. */
  height: number
  /** True when the lowest seen surface is well above the floor (wall-mounted, or its legs unseen). */
  floating: boolean
  yawSnappedToWall: string | null
  pointCount: number
  validFraction: number
  doubts: string[]
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

export type LiftedDetection = {
  index: number
  detection: SemanticDetection
  /** Where the camera stood and which way it looked (level `[x, z]`, radians). */
  view?: { position: Vec2; heading: number }
} & LiftOutcome

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
type RgbBox = { left: number; top: number; right: number; bottom: number; truncated: boolean }

/** The box clamped to the image, and whether it touched the image edge. */
function clampRgbBox(frame: LiftFrame, box: SemanticDetection['box2d']): RgbBox | null {
  const raw = {
    left: Math.min(box[0], box[2]),
    right: Math.max(box[0], box[2]),
    top: Math.min(box[1], box[3]),
    bottom: Math.max(box[1], box[3]),
  }
  const left = Math.max(0, raw.left)
  const right = Math.min(frame.imageWidth, raw.right)
  const top = Math.max(0, raw.top)
  const bottom = Math.min(frame.imageHeight, raw.bottom)
  if (!(right - left >= 2) || !(bottom - top >= 2)) return null
  const edge = 2
  return {
    left,
    right,
    top,
    bottom,
    truncated:
      raw.left <= edge ||
      raw.top <= edge ||
      raw.right >= frame.imageWidth - edge ||
      raw.bottom >= frame.imageHeight - edge,
  }
}

/**
 * The depth pixels a box covers. RGB and depth can have different fields of view, so corners go
 * through normalised rays: u_d = cx_d + fx_d * (u - cx_rgb) / fx_rgb, not a plain size ratio.
 */
function depthBox(frame: LiftFrame, box: RgbBox): DepthBox | null {
  const k = frame.rgbIntrinsics
  const d = frame.depth.intrinsics
  const toU = (u: number) => d.cx + (d.fx * (u - k.cx)) / k.fx
  const toV = (v: number) => d.cy + (d.fy * (v - k.cy)) / k.fy
  const u0 = toU(box.left)
  const u1 = toU(box.right)
  const v0 = toV(box.top)
  const v1 = toV(box.bottom)
  const w = frame.depth.width
  const h = frame.depth.height
  if (u1 <= 0 || v1 <= 0 || u0 >= w || v0 >= h) return null
  const x0 = Math.max(0, Math.floor(u0))
  const y0 = Math.max(0, Math.floor(v0))
  const x1 = Math.min(w - 1, Math.max(x0, Math.ceil(u1) - 1))
  const y1 = Math.min(h - 1, Math.max(y0, Math.ceil(v1) - 1))
  return { x0, y0, x1, y1 }
}

function boxPixels(box: DepthBox): Array<[number, number]> {
  const count = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1)
  const step = Math.max(1, Math.ceil(Math.sqrt(count / MAX_BOX_PIXELS)))
  const out: Array<[number, number]> = []
  for (let y = box.y0; y <= box.y1; y += step)
    for (let x = box.x0; x <= box.x1; x += step) out.push([x, y])
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
  rgb: RgbBox,
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
      detail: `Only ${ring.points.length} of ${ring.total} depth pixels around the box edges are usable (at least ${MIN_SAMPLES} needed), so the wall beside it was not seen.`,
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
  const basis = cameraBasis(frame.depth.pose, options.transform)
  // Rays use the RGB intrinsics the box was drawn in, and meet the plane depth puts the wall on.
  const cast = (u: number, v: number) =>
    rayHitsWall(best!.wall, rayThrough(basis, frame.rgbIntrinsics, u, v), best!.offset)
  // Corners and edge midpoints, so a photo in sensor orientation (rolled a quarter turn) works too:
  // width is the extent along the wall and height the extent in Y, whichever way the image runs.
  const { left, right, top, bottom } = rgb
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
  const validFraction = ring.points.length / ring.total
  const doubts: string[] = []
  if (Math.abs(best.offset) > MAX_WALL_OFFSET) {
    doubts.push(
      `depth puts the wall ${round(Math.abs(best.offset), 2)} m from the plan wall, so the plan wall may have drifted`,
    )
  }
  if (best.support < MIN_RING_SUPPORT) {
    doubts.push(
      `only ${Math.round(best.support * 100)}% of the depth beside the box lies on the wall`,
    )
  }
  if (validFraction < MIN_VALID_FRACTION) {
    doubts.push(`only ${Math.round(validFraction * 100)}% of the pixels around the box had depth`)
  }
  if (rgb.truncated) doubts.push('the box touches the image edge, so the opening may be cut off')
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
      ringSupport: round(best.support, 2),
      validFraction: round(validFraction, 2),
      ringSamples: ring.points.length,
      doubts,
    },
  }
}

/**
 * Smallest-area yawed rectangle around the footprint, on trimmed extents (3rd to 97th percentile)
 * so stray points do not stretch it. A coarse 5 degree search is refined to 1 degree; points are
 * thinned first, so cost does not grow with the box. Yaw snaps to a wall within ten degrees.
 */
export function fitOrientedBox(
  input: readonly Vec3[],
  walls: readonly SemanticWall[],
  floorY = DEFAULT_FLOOR_Y,
): LiftedBox | null {
  if (input.length < MIN_SAMPLES) return null
  const points = thin(input, FIT_POINTS)
  const extent = (yaw: number) => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const along = Float64Array.from(points, (p) => p[0] * c + p[2] * s).sort()
    const across = Float64Array.from(points, (p) => -p[0] * s + p[2] * c).sort()
    const a0 = percentile(along as unknown as number[], 0.03)
    const a1 = percentile(along as unknown as number[], 0.97)
    const b0 = percentile(across as unknown as number[], 0.03)
    const b1 = percentile(across as unknown as number[], 0.97)
    return { a0, a1, b0, b1, area: (a1 - a0) * (b1 - b0) }
  }
  let yaw = 0
  let fit = extent(0)
  const consider = (degrees: number) => {
    const candidate = extent((degrees * Math.PI) / 180)
    if (candidate.area < fit.area - 1e-9) {
      fit = candidate
      yaw = (degrees * Math.PI) / 180
    }
  }
  for (let degrees = 5; degrees < 90; degrees += 5) consider(degrees)
  const coarse = Math.round((yaw * 180) / Math.PI)
  for (let degrees = coarse - 4; degrees <= coarse + 4; degrees += 1) {
    if (degrees !== coarse) consider(degrees)
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
  const heights = sortNumbers(points.map((p) => p[1]))
  const top = percentile(heights, 0.97)
  let base = percentile(heights, 0.03)
  const floating = base - floorY > FLOOR_CONTACT
  if (!floating) base = floorY
  return {
    centre: [round(centre[0]), round(centre[1])],
    baseY: round(base),
    topY: round(top),
    yaw: round(yaw, 4),
    width: round(width),
    depth: round(depth),
    height: round(Math.max(0.05, top - base)),
    floating,
    yawSnappedToWall: snapped,
    pointCount: input.length,
    validFraction: 1,
    doubts: [],
  }
}

/** The nearest depth that a real share of the samples sit at, so stray near pixels do not set it. */
function nearDepth(depths: readonly number[]): number {
  const bins = new Map<number, number>()
  for (const d of depths) bins.set(Math.floor(d * 10), (bins.get(Math.floor(d * 10)) ?? 0) + 1)
  const need = 0.12 * depths.length
  for (const bin of [...bins.keys()].sort((a, b) => a - b)) {
    if ((bins.get(bin) ?? 0) + (bins.get(bin + 1) ?? 0) >= need) return bin / 10
  }
  return percentile(sortNumbers(depths), 0.2)
}

function liftFurniture(
  frame: LiftFrame,
  rgb: RgbBox,
  box: DepthBox,
  walls: WallFrame[],
  options: SemanticsOptions,
): LiftOutcome {
  const floorY = options.floorY ?? DEFAULT_FLOOR_Y
  const samples = depthPoints(frame, options, boxPixels(box))
  const validFraction = samples.total === 0 ? 0 : samples.points.length / samples.total
  if (samples.points.length < MIN_SAMPLES || validFraction < MIN_VALID_FRACTION) {
    return {
      ok: false,
      reason: 'no_depth',
      detail: `${samples.points.length} of ${samples.total} depth pixels in the box are usable (at least ${MIN_SAMPLES} and ${Math.round(MIN_VALID_FRACTION * 100)}% needed): the box sits over a depth hole (dark, shiny or glass surface, or out of range).`,
    }
  }
  // The dominant near depth cluster is the object; drop floor and wall surface.
  const near = nearDepth(samples.depths)
  const kept = samples.points.filter((point, index) => {
    const d = samples.depths[index]!
    if (d > near + OBJECT_DEPTH_SLACK || d < near - 0.15) return false
    if (point[1] < floorY + SURFACE_MARGIN) return false
    return !walls.some((wall) => Math.abs(inWallFrame(wall, point[0], point[2]).d) < SURFACE_MARGIN)
  })
  if (kept.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: 'no_object_points',
      detail: 'Too few points were left after dropping floor, wall surface and far background.',
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
  fit.validFraction = round(validFraction, 2)
  if (rgb.truncated) fit.doubts.push('the box touches the image edge, so the object may be cut off')
  return { ok: true, box: fit, points: thin(kept, MAX_POINTS) }
}

/**
 * Lifts each detection with its keyframe's raw depth. Doors and windows snap to the wall most of
 * the depth points around the box edges lie on, and take their extent from the viewing rays at the
 * box edges meeting the plane depth puts that wall on; furniture gets an oriented box from the
 * depth points inside the box. A detection that cannot be lifted says why instead of guessing.
 */
export function liftDetections(
  detections: readonly SemanticDetection[],
  frames: readonly LiftFrame[],
  walls: readonly SemanticWall[],
  options: SemanticsOptions,
): LiftedDetection[] {
  const byId = new Map(frames.map((frame) => [frame.id, frame]))
  const wallFrames = walls.map(wallFrame).filter((frame): frame is WallFrame => frame !== null)
  const furnitureInFrame = new Map<string, number>()
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
    const basis = cameraBasis(frame.depth.pose, options.transform)
    const heading = Math.atan2(-basis.back[2], -basis.back[0])
    const view = { position: [basis.origin[0], basis.origin[2]] as Vec2, heading }
    const fail = (reason: UnliftReason, detail: string) => ({
      ...base,
      view,
      ok: false as const,
      reason,
      detail,
    })
    const rgb = clampRgbBox(frame, detection.box2d)
    const box = rgb ? depthBox(frame, rgb) : null
    if (!rgb || !box) return fail('box_outside_image', 'The box is empty or outside the image.')
    if (detection.kind !== 'furniture' && wallFrames.length === 0) {
      return fail('no_walls', 'Doors and windows need walls to snap to.')
    }
    if (detection.kind === 'furniture') {
      const area =
        ((rgb.right - rgb.left) * (rgb.bottom - rgb.top)) / (frame.imageWidth * frame.imageHeight)
      if (area > MAX_BOX_AREA_FRACTION) {
        return fail(
          'box_too_large',
          `The box covers ${Math.round(area * 100)}% of the image; a piece of furniture is boxed tighter than that.`,
        )
      }
      const used = (furnitureInFrame.get(frame.id) ?? 0) + 1
      furnitureInFrame.set(frame.id, used)
      if (used > MAX_FURNITURE_PER_FRAME) {
        return fail(
          'too_many_boxes_in_frame',
          `At most ${MAX_FURNITURE_PER_FRAME} furniture boxes are lifted per keyframe.`,
        )
      }
    }
    const lifted =
      detection.kind === 'furniture'
        ? liftFurniture(frame, rgb, box, wallFrames, options)
        : liftOpening(detection, frame, rgb, box, wallFrames, options)
    return { ...base, view, ...lifted } as LiftedDetection
  })
}

// ---------------------------------------------------------------------------------------------
// (c) Clustering across views
// ---------------------------------------------------------------------------------------------

export type SemanticStatus = 'confirmed' | 'uncertain'

type Common = {
  id: string
  label: string
  /** Distinct keyframes that saw it. */
  viewCount: number
  /** `confirmed` needs two sound views from different positions or headings; else `uncertain`. */
  status: SemanticStatus
  /** Mean detection confidence, weighted by usable depth, times 0.6 unless confirmed. Not an accuracy in metres. */
  confidence: number
  evidenceFrameIds: string[]
  /** Why it is less trustworthy, from every member. */
  doubts: string[]
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
  /** Median offset of depth from the plan wall, metres. */
  wallOffset: number
}

export type SemanticFurniture = Common & {
  kind: 'furniture'
  centre: Vec2
  /** Lowest seen surface, level Y. */
  baseY: number
  topY: number
  /** True when the lowest seen surface is well above the floor. */
  floatingBase: boolean
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

const SYNONYMS: Record<string, string> = {
  couch: 'sofa',
  settee: 'sofa',
  television: 'tv',
  'tv screen': 'tv',
  armchair: 'armchair',
  'arm chair': 'armchair',
}
const normalise = (label: string) => {
  const clean = label.trim().toLowerCase().replace(/\s+/g, ' ')
  return SYNONYMS[clean] ?? clean
}
/** A door and a leafless opening at the same spot are one thing. */
const openingFamily = (kind: SemanticKind) =>
  kind === 'door' || kind === 'opening' ? 'door' : kind

type Cluster = { members: Array<LiftedDetection & { ok: true }> }

function corners(box: LiftedBox): Vec2[] {
  const c = Math.cos(box.yaw)
  const s = Math.sin(box.yaw)
  const hw = box.width / 2
  const hd = box.depth / 2
  return (
    [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as Vec2[]
  ).map(([a, b]) => [box.centre[0] + a * c - b * s, box.centre[1] + a * s + b * c])
}

function polygonArea(points: readonly Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const [x1, z1] = points[i]!
    const [x2, z2] = points[(i + 1) % points.length]!
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

/** Convex polygon clip (Sutherland-Hodgman) for two counter-clockwise or clockwise rectangles. */
function clip(subject: Vec2[], clipper: Vec2[]): Vec2[] {
  const orient = (() => {
    let sum = 0
    for (let i = 0; i < clipper.length; i += 1) {
      const [x1, z1] = clipper[i]!
      const [x2, z2] = clipper[(i + 1) % clipper.length]!
      sum += x1 * z2 - x2 * z1
    }
    return sum >= 0 ? 1 : -1
  })()
  let out = subject
  for (let i = 0; i < clipper.length && out.length > 0; i += 1) {
    const a = clipper[i]!
    const b = clipper[(i + 1) % clipper.length]!
    const inside = (p: Vec2) =>
      orient * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0
    const input = out
    out = []
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j]!
      const q = input[(j + 1) % input.length]!
      const pin = inside(p)
      const qin = inside(q)
      if (pin !== qin) {
        const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        const d2 = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])
        const t = d1 / (d1 - d2)
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
      }
      if (qin) out.push(q)
    }
  }
  return out
}

/** Footprint overlap: intersection over union, and over the smaller box (containment). */
function footprintOverlap(a: LiftedBox, b: LiftedBox): { iou: number; containment: number } {
  const ca = corners(a)
  const cb = corners(b)
  const overlap = clip(ca, cb)
  const inter = overlap.length >= 3 ? polygonArea(overlap) : 0
  const areaA = polygonArea(ca)
  const areaB = polygonArea(cb)
  return {
    iou: inter / (areaA + areaB - inter || 1),
    containment: inter / (Math.min(areaA, areaB) || 1),
  }
}

function memberMatches(
  member: LiftedDetection & { ok: true },
  candidate: LiftedDetection & { ok: true },
): boolean {
  if (member.opening && candidate.opening) {
    if (openingFamily(member.detection.kind) !== openingFamily(candidate.detection.kind))
      return false
    if (member.opening.wallId !== candidate.opening.wallId) return false
    const a = member.opening
    const b = candidate.opening
    const gap = Math.abs(a.positionAlongWall - b.positionAlongWall)
    const ratio = a.width / (b.width || 1)
    return gap < Math.max(0.3, 0.5 * Math.min(a.width, b.width)) && ratio > 0.6 && ratio < 1.67
  }
  if (member.box && candidate.box) {
    if (normalise(member.detection.label) !== normalise(candidate.detection.label)) return false
    const gap = Math.hypot(
      member.box.centre[0] - candidate.box.centre[0],
      member.box.centre[1] - candidate.box.centre[1],
    )
    const small = Math.min(
      Math.max(member.box.width, member.box.depth),
      Math.max(candidate.box.width, candidate.box.depth),
    )
    // One view sees a surface, not a volume, so footprints are padded before they are compared.
    const pad = (box: LiftedBox): LiftedBox => ({
      ...box,
      width: box.width + MATCH_PAD,
      depth: box.depth + MATCH_PAD,
    })
    const { iou, containment } = footprintOverlap(pad(member.box), pad(candidate.box))
    return (iou >= 0.25 || containment >= 0.6) && gap < Math.max(0.35, 0.5 * small)
  }
  return false
}

/** A cluster takes a detection only from a frame it does not hold yet, and that matches a member. */
function matches(cluster: Cluster, candidate: LiftedDetection & { ok: true }): boolean {
  if (cluster.members.some((member) => member.detection.frameId === candidate.detection.frameId)) {
    return false
  }
  return cluster.members.some((member) => memberMatches(member, candidate))
}

const doubtsOf = (member: LiftedDetection & { ok: true }): string[] =>
  member.opening?.doubts ?? member.box?.doubts ?? []
const validOf = (member: LiftedDetection & { ok: true }): number =>
  member.opening?.validFraction ?? member.box?.validFraction ?? 1

function hasBaseline(a: LiftedDetection, b: LiftedDetection): boolean {
  if (!a.view || !b.view) return false
  const moved = Math.hypot(
    a.view.position[0] - b.view.position[0],
    a.view.position[1] - b.view.position[1],
  )
  let turn = Math.abs(a.view.heading - b.view.heading)
  if (turn > Math.PI) turn = 2 * Math.PI - turn
  return moved >= MIN_BASELINE || turn >= MIN_TURN
}

function commonOf(id: string, members: Array<LiftedDetection & { ok: true }>): Common {
  const frames = [...new Set(members.map((member) => member.detection.frameId))]
  const labels = new Map<string, number>()
  for (const member of members) {
    const label = member.detection.label.trim()
    labels.set(label, (labels.get(label) ?? 0) + 1)
  }
  const label = [...labels.entries()].sort((l, r) => r[1] - l[1])[0]![0]
  const sound = members.filter((member) => doubtsOf(member).length === 0)
  const confirmed = sound.some((a, i) =>
    sound.some((b, j) => j > i && a.detection.frameId !== b.detection.frameId && hasBaseline(a, b)),
  )
  const doubts = [...new Set(members.flatMap(doubtsOf))]
  if (!confirmed && frames.length >= 2 && sound.length < 2) {
    doubts.push('fewer than two sound views from different positions')
  } else if (!confirmed && frames.length >= 2) {
    doubts.push('the views were taken from nearly the same position and heading')
  }
  const weighted =
    members.reduce(
      (sum, member) =>
        sum + member.detection.confidence * (0.5 + 0.5 * Math.min(1, validOf(member) / 0.6)),
      0,
    ) / members.length
  return {
    id,
    label,
    viewCount: frames.length,
    status: confirmed ? 'confirmed' : 'uncertain',
    confidence: round(Math.min(1, Math.max(0, weighted * (confirmed ? 1 : 0.6))), 2),
    evidenceFrameIds: frames,
    doubts,
    basis: 'estimate',
  }
}

/**
 * Merges lifted detections of the same thing seen in several keyframes: openings on the same wall
 * at nearly the same position and width, furniture with the same label and an overlapping
 * footprint. A cluster never takes two detections from one frame, so two chairs in one photo stay
 * two. Two sound views from different positions or headings make a cluster `confirmed`.
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
    if (first.opening) {
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
        wallOffset: round(median(parts.map((part) => part.wallOffset))),
      })
    } else if (first.box) {
      counters.furniture += 1
      const points = cluster.members.flatMap((member) => member.points ?? [])
      const merged =
        cluster.members.length > 1
          ? (fitOrientedBox(points, walls, floorY) ?? first.box)
          : first.box
      furniture.push({
        ...commonOf(`furniture_${counters.furniture}`, cluster.members),
        kind: 'furniture',
        centre: merged.centre,
        baseY: merged.baseY,
        topY: merged.topY,
        floatingBase: merged.floating,
        yawDegrees: round((merged.yaw * 180) / Math.PI, 1),
        size: { width: merged.width, depth: merged.depth, height: merged.height },
        yawSnappedToWall: merged.yawSnappedToWall,
      })
    }
  }
  return { openings, furniture, unlifted }
}
