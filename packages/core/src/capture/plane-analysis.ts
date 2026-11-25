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
}

/** Vertical planes shorter than this are clutter, not walls. */
export const MIN_WALL_LENGTH = 0.4
/** Floor candidates below this fraction of the largest upward plane are tabletops or steps. */
const FLOOR_AREA_FRACTION = 0.25
/** A ceiling this close to the floor is a table underside, not a ceiling. */
const MIN_CEILING_HEIGHT = 1.8
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

  const largestFloor = Math.max(0, ...floors.map((floor) => floor.area))
  const floor =
    floors
      .filter((candidate) => candidate.area >= largestFloor * FLOOR_AREA_FRACTION)
      .sort((left, right) => left.y - right.y)[0] ?? null
  const ceiling =
    ceilings
      .filter((candidate) => floor === null || candidate.y - floor.y >= MIN_CEILING_HEIGHT)
      .sort((left, right) => right.area - left.area)[0] ?? null

  return {
    floor,
    ceiling,
    height: floor && ceiling ? round(ceiling.y - floor.y) : null,
    walls,
    skipped,
    horizontalUp,
    horizontalDown,
    vertical,
  }
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
