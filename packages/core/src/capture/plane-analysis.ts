import type { CapturePlane } from './streams'

/**
 * Reads a capture's `plane-set` as floor and ceiling heights and wall lines.
 *
 * Capture world is the provider's gravity-aligned frame (ARCore `arcore-world`, ARKit
 * `arkit-world`): right-handed, Y up, metres. The viewer draws a capture layer unchanged inside the
 * scan node's group, so a captured point reaches level coordinates as
 * `position + R(rotation) * (scale * point)` with the node's Euler angles in three.js `XYZ` order.
 * `arcore-world` and `arkit-world` share that frame, so one transform serves both.
 */

export type ScanTransform = {
  position: readonly [number, number, number]
  /** Euler angles in radians, three.js `XYZ` order, as stored on the scan node. */
  rotation: readonly [number, number, number]
  scale: number
}

export const IDENTITY_SCAN_TRANSFORM: ScanTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
}

export type Vec3 = readonly [number, number, number]
export type Vec2 = readonly [number, number]

/** A vertical plane seen from above: a straight line in the XZ plane. */
export type WallSegment = {
  planeId: string
  /** End points [x, z] in metres. */
  a: Vec2
  b: Vec2
  length: number
  /** Lowest and highest Y of the plane, metres. */
  bottom: number
  top: number
}

export type HorizontalPlaneSummary = {
  planeId: string
  y: number
  /** Polygon area in square metres. */
  area: number
}

export type PlaneAnalysis = {
  floor: HorizontalPlaneSummary | null
  ceiling: HorizontalPlaneSummary | null
  /** Distance from floor to ceiling, when both were seen. */
  height: number | null
  walls: WallSegment[]
  /** Plane ids left out, with the reason. */
  skipped: Array<{ planeId: string; reason: string }>
  horizontalUp: number
  horizontalDown: number
  vertical: number
  /** Floor level the tall walls stand on (median of their bottoms), when any wall was seen. */
  wallFloorY: number | null
  /** Level the tall walls reach (median of their tops). */
  wallTopY: number | null
  /** Why the floor, ceiling or height is missing or doubtful, worded for the person. */
  notes: string[]
}

/** Vertical planes shorter than this are clutter, not walls. */
export const MIN_WALL_LENGTH = 0.4
/** Floor candidates below this fraction of the largest upward plane are tabletops or steps. */
const FLOOR_AREA_FRACTION = 0.25
/** Plausible floor-to-ceiling range in metres; anything outside is a table underside or a ghost. */
export const MIN_CEILING_HEIGHT = 2
export const MAX_CEILING_HEIGHT = 6
/** Vertical planes shorter than this are furniture (cabinet, sofa back), not room walls. */
export const MIN_WALL_HEIGHT = 1.2
/** A wall whose bottom floats this far above the floor is a mirror, shelf or ghost. */
const MAX_WALL_BOTTOM_ABOVE_FLOOR = 0.5
/** A floor plane must sit this close to where the walls stand. */
const FLOOR_WALL_TOLERANCE = 0.25
const SMALL_FLOOR_AREA = 2
const MAX_TILT = 0.2

/** The 3D point of a plane-local `[x, z]` polygon point, through the plane's column-major pose. */
export function planePointToWorld(pose: readonly number[], x: number, z: number): Vec3 {
  return [
    pose[12]! + pose[0]! * x + pose[8]! * z,
    pose[13]! + pose[1]! * x + pose[9]! * z,
    pose[14]! + pose[2]! * x + pose[10]! * z,
  ]
}

function rotate([rx, ry, rz]: Vec3, [x, y, z]: Vec3): Vec3 {
  // three.js Euler 'XYZ': matrix = Rx * Ry * Rz, so the vector meets Rz first.
  const cz = Math.cos(rz)
  const sz = Math.sin(rz)
  const x1 = x * cz - y * sz
  const y1 = x * sz + y * cz
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const x2 = x1 * cy + z * sy
  const z2 = -x1 * sy + z * cy
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  return [x2, y1 * cx - z2 * sx, y1 * sx + z2 * cx]
}

/** A capture-world point in level coordinates through the scan node's transform. */
export function captureToLevel(transform: ScanTransform, point: Vec3): Vec3 {
  const scaled: Vec3 = [
    point[0] * transform.scale,
    point[1] * transform.scale,
    point[2] * transform.scale,
  ]
  const [x, y, z] = rotate(transform.rotation, scaled)
  return [x + transform.position[0], y + transform.position[1], z + transform.position[2]]
}

/** A capture-world direction in level coordinates: rotated, not scaled or moved. */
export function captureDirectionToLevel(transform: ScanTransform, direction: Vec3): Vec3 {
  return rotate(transform.rotation, direction)
}

export function isIdentityTransform(transform: ScanTransform): boolean {
  return (
    transform.scale === 1 &&
    transform.position.every((value) => value === 0) &&
    transform.rotation.every((value) => value === 0)
  )
}

function polygonArea(points: ReadonlyArray<Vec2>): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const [x1, z1] = points[index]!
    const [x2, z2] = points[(index + 1) % points.length]!
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * Walls, floor and ceiling of a plane set, in the frame `transform` maps to. Pass the scan node's
 * transform for level coordinates, or `IDENTITY_SCAN_TRANSFORM` for the capture's own frame.
 * Planes ARCore folded into another (`subsumedBy`) are left out.
 */
export function analysePlanes(
  planes: readonly CapturePlane[],
  transform: ScanTransform = IDENTITY_SCAN_TRANSFORM,
): PlaneAnalysis {
  const skipped: PlaneAnalysis['skipped'] = []
  const walls: WallSegment[] = []
  const floors: HorizontalPlaneSummary[] = []
  const ceilings: HorizontalPlaneSummary[] = []
  let horizontalUp = 0
  let horizontalDown = 0
  let vertical = 0

  for (const plane of planes) {
    if (plane.subsumedBy) {
      skipped.push({ planeId: plane.id, reason: `merged into ${plane.subsumedBy}` })
      continue
    }
    const points = plane.polygon.map(([x, z]) =>
      captureToLevel(transform, planePointToWorld(plane.centerPose, x, z)),
    )
    if (plane.orientation === 'vertical') {
      vertical += 1
      const wall = wallSegment(plane, points, transform)
      if ('reason' in wall) skipped.push({ planeId: plane.id, reason: wall.reason })
      else walls.push(wall)
      continue
    }
    if (plane.orientation === 'horizontal-up') horizontalUp += 1
    else horizontalDown += 1
    const y = points.reduce((sum, point) => sum + point[1], 0) / points.length
    const spread =
      Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1]))
    if (spread > 0.3) {
      skipped.push({ planeId: plane.id, reason: 'tilted horizontal plane' })
      continue
    }
    const summary = {
      planeId: plane.id,
      y: round(y),
      area: round(polygonArea(points.map((point): Vec2 => [point[0], point[2]]))),
    }
    ;(plane.orientation === 'horizontal-up' ? floors : ceilings).push(summary)
  }

  const notes: string[] = []
  const tall = walls.filter((wall) => wall.top - wall.bottom >= MIN_WALL_HEIGHT)
  const lowest = Math.min(...tall.map((wall) => wall.bottom))
  const wallFloorY = tall.length
    ? round(median(tall.filter((wall) => wall.bottom - lowest <= 0.3).map((wall) => wall.bottom)))
    : null
  const wallTopY = tall.length ? round(median(tall.map((wall) => wall.top))) : null

  const largestFloor = Math.max(0, ...floors.map((candidate) => candidate.area))
  const sizable = floors.filter((candidate) => candidate.area >= largestFloor * FLOOR_AREA_FRACTION)
  let floor: HorizontalPlaneSummary | null = null
  if (wallFloorY !== null) {
    // The walls say where the floor is, so a floor plane smaller than a tabletop still counts.
    floor =
      floors
        .filter((candidate) => Math.abs(candidate.y - wallFloorY) <= FLOOR_WALL_TOLERANCE)
        .sort((left, right) => right.area - left.area)[0] ?? null
    if (!floor) {
      notes.push(
        floors.length
          ? `No upward plane sits at the foot of the walls (walls stand at y ${wallFloorY} m; upward planes at ${floors.map((candidate) => candidate.y).join(', ')} m), so the floor level is unknown.`
          : 'No upward plane was seen, so the floor level is unknown.',
      )
    }
  } else {
    floor = sizable.sort((left, right) => left.y - right.y)[0] ?? null
    notes.push(
      floor
        ? 'The floor plane was not checked against wall bottoms because no wall plane was usable; it may be a table or a step.'
        : 'No upward plane was seen, so the floor level is unknown.',
    )
  }
  if (floor && floor.area < SMALL_FLOOR_AREA) {
    notes.push(`The floor plane covers only ${floor.area} m2; its level may be wrong.`)
  }

  const reference = floor?.y ?? null
  let ceiling: HorizontalPlaneSummary | null = null
  if (reference === null) {
    notes.push('No confirmed floor level, so no ceiling height could be measured.')
  } else {
    const inRange = ceilings.filter((candidate) => {
      const height = candidate.y - reference
      return height >= MIN_CEILING_HEIGHT && height <= MAX_CEILING_HEIGHT
    })
    const nearTops =
      wallTopY === null
        ? []
        : inRange.filter((candidate) => Math.abs(candidate.y - wallTopY) <= 0.4)
    ceiling =
      (nearTops.length ? nearTops : inRange).sort((left, right) => right.area - left.area)[0] ??
      null
    if (!ceiling) {
      notes.push(
        ceilings.length
          ? `Downward planes at ${ceilings.map((candidate) => candidate.y).join(', ')} m are outside ${MIN_CEILING_HEIGHT} to ${MAX_CEILING_HEIGHT} m above the floor, so the ceiling was not seen.`
          : 'No downward plane was seen, so the ceiling was not seen.',
      )
    } else if (wallTopY !== null && Math.abs(ceiling.y - wallTopY) > 0.5) {
      notes.push(
        `The ceiling plane (y ${ceiling.y} m) is not where the wall planes end (y ${wallTopY} m); check the height.`,
      )
    }
  }

  return {
    floor,
    ceiling,
    height: floor && ceiling ? round(ceiling.y - floor.y) : null,
    walls,
    skipped,
    horizontalUp,
    horizontalDown,
    vertical,
    wallFloorY,
    wallTopY,
    notes,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * The vertical planes that can be room walls: tall enough and standing on the floor. Furniture
 * fronts, mirror ghosts and floating panels come back in `rejected` with the reason.
 */
export function selectRoomWalls(analysis: PlaneAnalysis): {
  walls: WallSegment[]
  rejected: Array<{ planeId: string; reason: string }>
} {
  const reference = analysis.floor?.y ?? analysis.wallFloorY
  const walls: WallSegment[] = []
  const rejected: Array<{ planeId: string; reason: string }> = []
  for (const wall of analysis.walls) {
    const height = wall.top - wall.bottom
    if (height < MIN_WALL_HEIGHT) {
      rejected.push({
        planeId: wall.planeId,
        reason: `a ${round(height, 2)} m tall vertical plane: furniture, not a room wall`,
      })
    } else if (reference !== null && wall.bottom - reference > MAX_WALL_BOTTOM_ABOVE_FLOOR) {
      rejected.push({
        planeId: wall.planeId,
        reason: `a vertical plane ${round(wall.bottom - reference, 2)} m above the floor: a mirror, shelf or ghost`,
      })
    } else walls.push(wall)
  }
  return { walls, rejected }
}

function wallSegment(
  plane: CapturePlane,
  points: ReadonlyArray<Vec3>,
  transform: ScanTransform,
): WallSegment | { reason: string } {
  // The plane's local Y is its normal. After the node transform a wall must stay upright.
  const normal = rotate(transform.rotation, [
    plane.centerPose[4]!,
    plane.centerPose[5]!,
    plane.centerPose[6]!,
  ])
  const horizontal = Math.hypot(normal[0], normal[2])
  if (Math.abs(normal[1]) > MAX_TILT * Math.hypot(...normal) || horizontal === 0) {
    return { reason: 'vertical plane is tilted' }
  }
  const nx = normal[0] / horizontal
  const nz = normal[2] / horizontal
  // Direction along the wall, perpendicular to the normal.
  const dx = -nz
  const dz = nx
  let tMin = Number.POSITIVE_INFINITY
  let tMax = Number.NEGATIVE_INFINITY
  let offset = 0
  let bottom = Number.POSITIVE_INFINITY
  let top = Number.NEGATIVE_INFINITY
  for (const [x, y, z] of points) {
    const t = x * dx + z * dz
    tMin = Math.min(tMin, t)
    tMax = Math.max(tMax, t)
    offset += x * nx + z * nz
    bottom = Math.min(bottom, y)
    top = Math.max(top, y)
  }
  offset /= points.length
  const length = tMax - tMin
  if (length < MIN_WALL_LENGTH) return { reason: `too short to be a wall (${round(length, 2)} m)` }
  return {
    planeId: plane.id,
    a: [round(dx * tMin + nx * offset), round(dz * tMin + nz * offset)],
    b: [round(dx * tMax + nx * offset), round(dz * tMax + nz * offset)],
    length: round(length),
    bottom: round(bottom),
    top: round(top),
  }
}
