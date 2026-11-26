import { type DepthWallEvidence, floorSeenAlongEdge, pointInPolygon } from './depth-walls'
import type { CarvedOutline } from './free-space-carving'
import type { PartialWallCandidate, Vec2, WallSegment } from './plane-analysis'

/**
 * Which vertical planes that cover only part of a wall's height are wall evidence.
 *
 * ARCore usually finds a plane on the lower or middle part of a plain wall, so a height threshold
 * alone throws real walls away, yet a cabinet, bed or sofa front standing on the floor looks the
 * same as a plane. A partial plane (see `selectRoomWalls`) is therefore furniture when the scan
 * shows space or a wall behind it: walked-path points, floor seen by depth or a floor plane, free
 * space the depth rays crossed, or a wall plane or depth line 0.25 to 1.5 m behind it (a cabinet
 * or bed in front of the wall). Otherwise it is wall evidence when another source agrees with its
 * position and direction (within 0.15 m and 10 degrees, or 0.3 m for a floor plane's edge):
 *
 * - a full-height wall plane on the same line, the carved outline's boundary (traced from the wall
 *   band 1.5 m above the floor) or a floor plane's edge: independent of the plane, so an edge
 *   resting on it is rated medium at most;
 * - only a line fitted to depth points: it may be fitted to the same furniture face as the plane,
 *   so the edge is rated low;
 * - nothing: it counts, rated low, only when it is at least 1.5 m wide and outside the walked area.
 *
 * A plane that floats more than 0.5 m above the floor and reaches the ceiling was a mirror or ghost
 * under the full-height rule and stays one unless an independent source agrees.
 *
 * "Behind" is the side away from the room: the side with fewer walked-path points along the
 * plane, else the side without floor, else the side away from the centre of the vertical planes.
 */

export type PartialWall = WallSegment & {
  /** Highest confidence an edge resting only on partial planes may get. */
  cap: 'medium' | 'low'
  /** Why it was taken as wall evidence, worded for the person. */
  reason: string
  /** Unit normal towards the room, or null when no side could be told. */
  front: Vec2 | null
}

export type PartialWallSources = {
  /** Full-height wall planes. */
  walls: readonly WallSegment[]
  depth: DepthWallEvidence | null
  carved: CarvedOutline | null
  /** Floor plane outlines in level coordinates. */
  floorPolygons: ReadonlyArray<ReadonlyArray<Vec2>>
  /** Walked path as x, z pairs in level coordinates. */
  path: Float32Array
}

/** Sine of the largest angle between two lines on the same wall. */
const PARALLEL_SINE = Math.sin((10 * Math.PI) / 180)
/** Another line this close to the plane along its normal lies on the same wall. */
const AGREE_OFFSET = 0.15
/** Lines on the same wall agree when they overlap or their ends are this close, metres. */
const AGREE_GAP = 0.75
/**
 * A wall this far behind a plane makes the plane furniture standing in front of it. The gap above
 * `AGREE_OFFSET` leaves room for depth noise. 1.5 m reaches past wardrobes, kitchen runs, sofas and
 * a double bed's side; a king bed or deeper piece is caught by the free space carved over it
 * instead. Reaching further would start to take a plane of the next room, seen through a doorway,
 * as a wall behind a real wall.
 */
const BEHIND_MIN = 0.25
const BEHIND_MAX = 1.5
/** A floor plane ending within this distance either side of the plane agrees with it. */
const EDGE_REACH = 0.3
/** Floor or free space this far behind a plane means it stands in the room. */
const FREE_BEHIND = 0.4
/** Share of the plane's length that must show a sign before it counts. */
const SAMPLE_SHARE = 0.5
const SAMPLE_STEP = 0.1
/** Walked-path points count on a side past this distance, within the plane's run plus this margin. */
const PATH_SIDE = 0.15
const PATH_RUN_MARGIN = 0.2
/** This many walked-path points behind a plane mean the phone walked behind it. */
const PATH_BEHIND = 3
const MAX_PATH_POINTS = 400
/** A partial plane that nothing else agrees with must be at least this wide. */
const MIN_LONE_PARTIAL_WIDTH = 1.5

type Line = { id: string; a: Vec2; b: Vec2; label: string }

type Frame = {
  plane: WallSegment
  d: Vec2
  /** Unit normal towards the room, or null when no side could be told. */
  front: Vec2 | null
  samples: Vec2[]
  /** Walked-path points on the side with fewer of them, along the plane's run. */
  pathBehind: number
}

export function confirmPartialWalls(
  candidates: readonly PartialWallCandidate[],
  sources: PartialWallSources,
): { partial: PartialWall[]; rejected: Array<{ planeId: string; reason: string }> } {
  const partial: PartialWall[] = []
  const rejected: Array<{ planeId: string; reason: string }> = []
  if (candidates.length === 0) return { partial, rejected }
  const path = pathSamples(sources.path)
  const hull = path.length >= 3 ? convexHull(path) : null
  const carvedPolygon = sources.carved?.polygon ?? null
  const inFloor = (point: Vec2) =>
    sources.floorPolygons.some((polygon) => pointInPolygon(point, polygon))
  const inCarved = (point: Vec2) => carvedPolygon !== null && pointInPolygon(point, carvedPolygon)
  const midpoints = [...sources.walls, ...candidates].map(midpoint)
  const centre: Vec2 = [
    midpoints.reduce((sum, point) => sum + point[0], 0) / midpoints.length,
    midpoints.reduce((sum, point) => sum + point[1], 0) / midpoints.length,
  ]

  const agreeing: Line[] = [
    ...sources.walls.map((wall) => ({
      id: wall.planeId,
      a: wall.a,
      b: wall.b,
      label: `the full-height wall plane ${wall.planeId}`,
    })),
    ...(sources.depth?.candidates ?? [])
      .filter((candidate) => candidate.basis === 'depth-fit')
      .map((candidate) => ({
        id: candidate.id,
        a: candidate.a,
        b: candidate.b,
        label: `the line fitted to depth points ${candidate.id}`,
      })),
    ...(sources.carved?.polygon ? sources.carved.edges : []).map((edge) => ({
      id: `carved:${edge.index}`,
      a: edge.from,
      b: edge.to,
      label: `the carved free-space boundary carved:${edge.index}`,
    })),
  ]

  for (const plane of candidates) {
    const frame = frameOf(plane, path, inFloor, inCarved, centre)
    const height = round(plane.top - plane.bottom)
    // Carved edges are left out: free space behind the plane is the carving's sign, and a carved
    // edge a few tenths of a metre off a real wall is common noise.
    const behindLines = [
      ...agreeing.filter((line) => !line.id.startsWith('carved:')),
      ...candidates
        .filter((other) => other !== plane)
        .map((other) => ({
          id: other.planeId,
          a: other.a,
          b: other.b,
          label: `the vertical plane ${other.planeId}`,
        })),
    ]
    const signs = furnitureSigns(frame, behindLines, sources.depth, inFloor, inCarved)
    if (signs.length > 0) {
      rejected.push({
        planeId: plane.planeId,
        reason: `a ${height} m tall vertical plane with ${list(signs)}: furniture, not a room wall`,
      })
      continue
    }
    const agree = agreeing.filter((line) => onSameWall(frame, line))
    const independent = agree
      .filter((line) => !line.id.startsWith('depth-fit:'))
      .map((line) => line.label)
    const depthLines = agree
      .filter((line) => line.id.startsWith('depth-fit:'))
      .map((line) => line.label)
    if (
      frame.front &&
      share(frame.samples, (sample) => floorEndsAt(sample, frame.front!, inFloor)) >= SAMPLE_SHARE
    ) {
      independent.push('the edge of the floor plane')
    }
    const accept = (cap: PartialWall['cap'], reason: string) =>
      partial.push({ ...withoutFloating(plane), cap, reason, front: frame.front })
    if (independent.length > 0) {
      const all = [...independent, ...depthLines]
      accept(
        'medium',
        `${plane.planeId}, ${height} m tall: ${list(all)} ${all.length === 1 ? 'agrees' : 'agree'} with it`,
      )
      continue
    }
    if (plane.floating !== null) {
      rejected.push({
        planeId: plane.planeId,
        reason: `a vertical plane ${plane.floating} m above the floor: a mirror, shelf or ghost; it reaches the ceiling, but no wall plane, carved boundary or floor-plane edge agrees with it`,
      })
      continue
    }
    if (depthLines.length > 0) {
      accept(
        'low',
        `${plane.planeId}, ${height} m tall: only ${list(depthLines)} ${depthLines.length === 1 ? 'agrees' : 'agree'} with it, and a depth line may be fitted to the same furniture face`,
      )
      continue
    }
    const width = round(plane.length)
    const outside =
      hull !== null && share(frame.samples, (sample) => pointInPolygon(sample, hull)) < SAMPLE_SHARE
    if (width >= MIN_LONE_PARTIAL_WIDTH && outside) {
      accept(
        'low',
        `${plane.planeId}, ${height} m tall: no other source agrees with it, but it is ${width} m wide and outside the walked area`,
      )
      continue
    }
    const why =
      width < MIN_LONE_PARTIAL_WIDTH
        ? `at ${width} m it is too narrow to stand alone (under ${MIN_LONE_PARTIAL_WIDTH} m)`
        : hull === null
          ? 'no walked path shows it lies outside the walked area'
          : 'it lies inside the walked area'
    rejected.push({
      planeId: plane.planeId,
      reason: `a ${height} m tall vertical plane that no wall plane, depth line, carved boundary or floor-plane edge agrees with, and ${why}: furniture or an unconfirmed part of a wall`,
    })
  }
  return { partial, rejected }
}

function frameOf(
  plane: WallSegment,
  path: readonly Vec2[],
  inFloor: (point: Vec2) => boolean,
  inCarved: (point: Vec2) => boolean,
  centre: Vec2,
): Frame {
  const d: Vec2 = [
    (plane.b[0] - plane.a[0]) / plane.length,
    (plane.b[1] - plane.a[1]) / plane.length,
  ]
  const normal: Vec2 = [-d[1], d[0]]
  const count = Math.max(3, Math.ceil(plane.length / SAMPLE_STEP) + 1)
  const samples = Array.from({ length: count }, (_, index): Vec2 => {
    const t = (plane.length * index) / (count - 1)
    return [plane.a[0] + d[0] * t, plane.a[1] + d[1] * t]
  })
  let plus = 0
  let minus = 0
  for (const point of path) {
    const px = point[0] - plane.a[0]
    const pz = point[1] - plane.a[1]
    const t = px * d[0] + pz * d[1]
    if (t < -PATH_RUN_MARGIN || t > plane.length + PATH_RUN_MARGIN) continue
    const s = px * normal[0] + pz * normal[1]
    if (s > PATH_SIDE) plus += 1
    else if (s < -PATH_SIDE) minus += 1
  }
  const toward = (sign: number): Vec2 => [normal[0] * sign, normal[1] * sign]
  const pathBehind = Math.min(plus, minus)
  if (plus !== minus) return { plane, d, front: toward(plus > minus ? 1 : -1), samples, pathBehind }
  // Without the path, the room is the side where the floor or the carved free space is.
  for (const inside of [inFloor, inCarved]) {
    const vote = samples.reduce((sum, sample) => {
      const ahead = inside(offset(sample, normal, FREE_BEHIND))
      const back = inside(offset(sample, normal, -FREE_BEHIND))
      return sum + (ahead === back ? 0 : ahead ? 1 : -1)
    }, 0)
    if (vote !== 0) return { plane, d, front: toward(Math.sign(vote)), samples, pathBehind }
  }
  const mid = midpoint(plane)
  const side = (centre[0] - mid[0]) * normal[0] + (centre[1] - mid[1]) * normal[1]
  return {
    plane,
    d,
    front: Math.abs(side) > 0.1 ? toward(Math.sign(side)) : null,
    samples,
    pathBehind,
  }
}

/** Why the scan says this plane stands in the room or against a wall; empty when nothing does. */
function furnitureSigns(
  frame: Frame,
  lines: readonly Line[],
  depth: DepthWallEvidence | null,
  inFloor: (point: Vec2) => boolean,
  inCarved: (point: Vec2) => boolean,
): string[] {
  const signs: string[] = []
  if (frame.pathBehind >= PATH_BEHIND) {
    signs.push(`${frame.pathBehind} walked-path points behind it`)
  }
  const front = frame.front
  if (!front) return signs
  const back: Vec2 = [-front[0], -front[1]]
  if (
    share(frame.samples, (sample) => inFloor(offset(sample, back, FREE_BEHIND))) >= SAMPLE_SHARE
  ) {
    signs.push('a floor plane continuing behind it')
  }
  if (depth && floorSeenAlongEdge(depth, frame.plane.a, frame.plane.b, back) >= SAMPLE_SHARE) {
    signs.push('floor seen by depth behind it')
  }
  if (
    share(frame.samples, (sample) => inCarved(offset(sample, back, FREE_BEHIND))) >= SAMPLE_SHARE
  ) {
    signs.push('free space the depth rays crossed behind it')
  }
  let nearest: { line: Line; gap: number } | null = null
  for (const line of lines) {
    const fit = relate(frame, line)
    if (!fit || fit.overlap < 0.5 * frame.plane.length) continue
    const gap = -fit.offset
    if (gap >= BEHIND_MIN && gap <= BEHIND_MAX && (!nearest || gap < nearest.gap)) {
      nearest = { line, gap }
    }
  }
  if (nearest) signs.push(`${nearest.line.label} ${round(nearest.gap, 2)} m behind it`)
  return signs
}

function onSameWall(frame: Frame, line: Line): boolean {
  const fit = relate(frame, line)
  return fit !== null && Math.abs(fit.offset) <= AGREE_OFFSET && fit.overlap >= -AGREE_GAP
}

/**
 * How a near-parallel line sits against the plane: its signed distance from the plane's midpoint
 * along the front normal (negative behind), and how much the two runs overlap (negative is a gap).
 * Null when the line is not near-parallel.
 */
function relate(frame: Frame, line: Line): { offset: number; overlap: number } | null {
  const length = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1])
  if (length === 0) return null
  const e: Vec2 = [(line.b[0] - line.a[0]) / length, (line.b[1] - line.a[1]) / length]
  if (Math.abs(frame.d[0] * e[1] - frame.d[1] * e[0]) > PARALLEL_SINE) return null
  const mid = midpoint(frame.plane)
  const t = (mid[0] - line.a[0]) * e[0] + (mid[1] - line.a[1]) * e[1]
  const foot: Vec2 = [line.a[0] + e[0] * t, line.a[1] + e[1] * t]
  const normal = frame.front ?? [-frame.d[1], frame.d[0]]
  const offset = (foot[0] - mid[0]) * normal[0] + (foot[1] - mid[1]) * normal[1]
  const ta = (frame.plane.a[0] - line.a[0]) * e[0] + (frame.plane.a[1] - line.a[1]) * e[1]
  const tb = (frame.plane.b[0] - line.a[0]) * e[0] + (frame.plane.b[1] - line.a[1]) * e[1]
  const overlap = Math.min(length, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb))
  return { offset, overlap }
}

/** True where the floor reaches the plane from the front and stops before reaching behind it. */
function floorEndsAt(sample: Vec2, front: Vec2, inFloor: (point: Vec2) => boolean): boolean {
  return inFloor(offset(sample, front, EDGE_REACH)) && !inFloor(offset(sample, front, -EDGE_REACH))
}

function withoutFloating({ floating: _, ...wall }: PartialWallCandidate): WallSegment {
  return wall
}

function list(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function share(samples: readonly Vec2[], test: (sample: Vec2) => boolean): number {
  return samples.filter(test).length / samples.length
}

function offset(point: Vec2, direction: Vec2, distance: number): Vec2 {
  return [point[0] + direction[0] * distance, point[1] + direction[1] * distance]
}

function midpoint(wall: WallSegment): Vec2 {
  return [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2]
}

function pathSamples(path: Float32Array): Vec2[] {
  const total = path.length / 2
  const stride = Math.max(1, Math.ceil(total / MAX_PATH_POINTS))
  const out: Vec2[] = []
  for (let i = 0; i < total; i += stride) out.push([path[i * 2]!, path[i * 2 + 1]!])
  return out
}

/** Convex hull, counter-clockwise (monotone chain). */
function convexHull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Vec2[] = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: Vec2[] = []
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop()
    upper.push(point)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
