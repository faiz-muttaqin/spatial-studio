import { describe, expect, test } from 'bun:test'
import {
  type DepthFrameInput,
  deriveDepthWalls,
  estimateVerticalExtent,
  floorPolygonsFromPlanes,
} from './depth-walls'
import { IDENTITY_SCAN_TRANSFORM, type Vec2 } from './plane-analysis'
import { proposeRoom } from './room-proposal'
import type { CapturePlane } from './streams'

// Synthetic depth only: a ray caster over a vertical-wall world, no real capture data.

type Segment = { a: Vec2; b: Vec2 }
type World = {
  /** Solid walls: depth returns from them. */
  walls: Segment[]
  /** Clear glass: rays pass through it. */
  glass?: Segment[]
  height: number
}
type Camera = { x: number; z: number; yaw: number; pitch: number }

const WIDTH = 160
const HEIGHT = 90
const INTRINSICS = { fx: 105, fy: 105, cx: 80, cy: 45 }
const CAMERA_HEIGHT = 1.4

function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** OpenGL camera-to-world, column-major: +X right, +Y up, -Z forward. Yaw turns in XZ, pitch tilts up. */
function cameraPose(camera: Camera): number[] {
  const cp = Math.cos(camera.pitch)
  const sp = Math.sin(camera.pitch)
  const cy = Math.cos(camera.yaw)
  const sy = Math.sin(camera.yaw)
  const forward = [cp * cy, sp, cp * sy]
  const right = [-sy, 0, cy]
  const up = [-sp * cy, cp, -sp * sy]
  const back = forward.map((value) => -value)
  return [...right, 0, ...up, 0, ...back, 0, camera.x, CAMERA_HEIGHT, camera.z, 1]
}

function raySegment(origin: Vec2, direction: Vec2, segment: Segment): number | null {
  const sx = segment.b[0] - segment.a[0]
  const sz = segment.b[1] - segment.a[1]
  const cross = direction[0] * sz - direction[1] * sx
  if (Math.abs(cross) < 1e-9) return null
  const qx = segment.a[0] - origin[0]
  const qz = segment.a[1] - origin[1]
  const t = (qx * sz - qz * sx) / cross
  const u = (qx * direction[1] - qz * direction[0]) / cross
  return t > 1e-6 && u >= 0 && u <= 1 ? t : null
}

function renderFrame(
  id: string,
  world: World,
  camera: Camera,
  random: () => number,
): DepthFrameInput {
  const pose = cameraPose(camera)
  const depth = new Uint16Array(WIDTH * HEIGHT)
  const confidence = new Uint8Array(WIDTH * HEIGHT).fill(255)
  const right = [pose[0]!, pose[1]!, pose[2]!]
  const up = [pose[4]!, pose[5]!, pose[6]!]
  const forward = [-pose[8]!, -pose[9]!, -pose[10]!]
  for (let v = 0; v < HEIGHT; v += 1) {
    for (let u = 0; u < WIDTH; u += 1) {
      // Camera-space ray with z = -1, so the hit parameter is the depth along the optical axis.
      const cx = (u + 0.5 - INTRINSICS.cx) / INTRINSICS.fx
      const cy = -(v + 0.5 - INTRINSICS.cy) / INTRINSICS.fy
      const dir = [
        right[0]! * cx + up[0]! * cy + forward[0]!,
        right[1]! * cx + up[1]! * cy + forward[1]!,
        right[2]! * cx + up[2]! * cy + forward[2]!,
      ]
      let best = Number.POSITIVE_INFINITY
      const horizontal: Vec2 = [dir[0]!, dir[2]!]
      for (const wall of world.walls) {
        const t = raySegment([camera.x, camera.z], horizontal, wall)
        if (t === null) continue
        const y = CAMERA_HEIGHT + dir[1]! * t
        if (y >= 0 && y <= world.height) best = Math.min(best, t)
      }
      if (dir[1]! < 0) best = Math.min(best, -CAMERA_HEIGHT / dir[1]!)
      if (dir[1]! > 0) best = Math.min(best, (world.height - CAMERA_HEIGHT) / dir[1]!)
      if (!Number.isFinite(best)) continue
      depth[v * WIDTH + u] = Math.round((best + (random() - 0.5) * 0.02) * 1000)
    }
  }
  return { id, width: WIDTH, height: HEIGHT, intrinsics: INTRINSICS, pose, depth, confidence }
}

/** A walk along `positions`, turning through `turns` headings at each stop. */
function walk(world: World, positions: Vec2[], turns = 10, yawFrom = 0, yawSpan = Math.PI * 2) {
  const random = rng(7)
  const frames: DepthFrameInput[] = []
  const path: Array<[number, number, number]> = []
  positions.forEach(([x, z], stop) => {
    for (let turn = 0; turn < turns; turn += 1) {
      const yaw = yawFrom + (yawSpan * turn) / turns
      const pitch = [-0.35, 0, 0.35][turn % 3]!
      frames.push(renderFrame(`d${stop}-${turn}`, world, { x, z, yaw, pitch }, random))
    }
    path.push([x, CAMERA_HEIGHT, z])
  })
  return { frames, path }
}

function loop(x0: number, z0: number, x1: number, z1: number, step = 0.8): Vec2[] {
  const out: Vec2[] = []
  for (let x = x0; x < x1; x += step) out.push([x, z0])
  for (let z = z0; z < z1; z += step) out.push([x1, z])
  for (let x = x1; x > x0; x -= step) out.push([x, z1])
  for (let z = z1; z > z0; z -= step) out.push([x0, z])
  return out
}

function polygonWalls(points: Vec2[]): Segment[] {
  return points.map((a, index) => ({ a, b: points[(index + 1) % points.length]! }))
}

function area(points: readonly Vec2[]): number {
  let sum = 0
  points.forEach(([x1, z1], index) => {
    const [x2, z2] = points[(index + 1) % points.length]!
    sum += x1 * z2 - x2 * z1
  })
  return Math.abs(sum) / 2
}

const rectangle: Vec2[] = [
  [0, 0],
  [5, 0],
  [5, 4],
  [0, 4],
]

describe('floor and ceiling from depth', () => {
  test('finds both levels of a room from the depth heights alone', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const vertical = estimateVerticalExtent(frames, IDENTITY_SCAN_TRANSFORM)
    expect(vertical.floorY).toBeCloseTo(0, 1)
    expect(vertical.ceilingY).toBeCloseTo(2.6, 1)
  })
})

describe('depth wall candidates', () => {
  test('a rectangular room gives four fitted walls that enclose the path', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const flat = new Float32Array(path.flatMap(([x, , z]) => [x, z]))
    const evidence = deriveDepthWalls(frames, { path: flat })
    expect(evidence.vertical).toMatchObject({ floorBasis: 'depth-histogram' })
    const near = (value: number, target: number) => Math.abs(value - target) < 0.15
    const onWall = (
      candidate: (typeof evidence.candidates)[number],
      pick: (p: Vec2) => number,
      target: number,
    ) => near(pick(candidate.a), target) && near(pick(candidate.b), target)
    for (const [pick, target] of [
      [(p: Vec2) => p[1], 0],
      [(p: Vec2) => p[0], 5],
      [(p: Vec2) => p[1], 4],
      [(p: Vec2) => p[0], 0],
    ] as const) {
      expect(evidence.candidates.some((candidate) => onWall(candidate, pick, target))).toBe(true)
    }
    expect(evidence.candidates.every((candidate) => candidate.basis === 'depth-fit')).toBe(true)
    expect(evidence.candidates.every((candidate) => candidate.rmse < 0.06)).toBe(true)
  })

  test('is bounded: frames are subsampled and the work stays typed', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames } = walk(world, loop(0.8, 0.8, 4.2, 3.2, 0.3), 4)
    expect(frames.length).toBeGreaterThan(150)
    const evidence = deriveDepthWalls(frames, { maxFrames: 40, pixelStep: 4 })
    expect(evidence.stats.framesUsed).toBe(40)
    expect(evidence.cells).toBeInstanceOf(Float32Array)
  })

  test('a candidate the walked path crosses is rejected', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    // A path that runs through the east wall cannot have that wall in it.
    const through = [...path.map(([x, , z]): Vec2 => [x, z])]
    for (let x = 3; x < 7; x += 0.2) through.push([x, 2])
    const evidence = deriveDepthWalls(frames, { path: new Float32Array(through.flat()) })
    expect(evidence.rejected.some((entry) => entry.reason.includes('cuts the walked path'))).toBe(
      true,
    )
    expect(
      evidence.candidates.some(
        (candidate) => Math.abs(candidate.a[0] - 5) < 0.2 && Math.abs(candidate.b[0] - 5) < 0.2,
      ),
    ).toBe(false)
  })
})

describe('room proposal from depth', () => {
  test('rectangle: four depth-fit edges, a height, nothing presented as measured', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.method).toBe('depth')
    expect(proposal.polygon).toHaveLength(4)
    expect(area(proposal.polygon!)).toBeGreaterThan(18)
    expect(area(proposal.polygon!)).toBeLessThan(22)
    expect(proposal.height?.basis).toBe('depth-estimate')
    expect(proposal.height?.value).toBeCloseTo(2.6, 0)
    for (const edge of proposal.edges) {
      expect(edge.basis).toBe('depth-fit')
      expect(edge.confidence).not.toBe('high')
      expect(edge.evidenceIds.every((id) => id.startsWith('depth-fit:'))).toBe(true)
      expect(edge.evidencePlaneIds).toEqual([])
      expect(edge.likelyGlass).toBe(false)
    }
    expect(proposal.unknowns.join(' ')).toContain('not measured walls')
    expect(proposal.unknowns.join(' ')).toContain('not a detected plane')
    expect(proposal.unknowns.join(' ')).not.toContain('walked-path points outside')
    expect(proposal.depth?.pathChecked).toBe(true)
    expect(proposal.needsVerification).toBe(true)
  })

  test('L-shaped room: six corners and the notch', () => {
    const outline: Vec2[] = [
      [0, 0],
      [6, 0],
      [6, 2],
      [3, 2],
      [3, 4],
      [0, 4],
    ]
    const world: World = { walls: polygonWalls(outline), height: 2.6 }
    const positions: Vec2[] = [...loop(0.8, 0.8, 5.2, 1.2, 0.7), ...loop(0.8, 1.6, 2.2, 3.2, 0.7)]
    const { frames, path } = walk(world, positions)
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).not.toBeNull()
    expect(proposal.polygon!.length).toBeGreaterThanOrEqual(5)
    // True area is 18 m2; a partial or squared-off reading must not exceed the bounding box of 24.
    expect(area(proposal.polygon!)).toBeGreaterThan(12)
    expect(area(proposal.polygon!)).toBeLessThan(26)
    expect(proposal.edges.every((edge) => edge.confidence !== 'high')).toBe(true)
  })

  test('a rotated, non-orthogonal room keeps its angles', () => {
    const angle = (23 * Math.PI) / 180
    const turn = ([x, z]: Vec2): Vec2 => [
      x * Math.cos(angle) - z * Math.sin(angle),
      x * Math.sin(angle) + z * Math.cos(angle),
    ]
    const world: World = { walls: polygonWalls(rectangle.map(turn)), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2).map(turn))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).toHaveLength(4)
    const [first, second] = proposal.polygon!
    const edgeAngle = Math.atan2(second![1] - first![1], second![0] - first![0])
    const modulo = (((edgeAngle - angle) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
    expect(Math.min(modulo, Math.PI / 2 - modulo)).toBeLessThan((4 * Math.PI) / 180)
  })

  test('a glass wall with far points behind it is a flagged boundary, not a 9 m room', () => {
    // Solid walls on three sides and a far wall at x = 9; clear glass at x = 5.
    const world: World = {
      walls: [
        { a: [0, 0], b: [9, 0] },
        { a: [9, 0], b: [9, 4] },
        { a: [9, 4], b: [0, 4] },
        { a: [0, 4], b: [0, 0] },
      ],
      glass: [{ a: [5, 0], b: [5, 4] }],
      height: 2.6,
    }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    // ARCore saw floor and ceiling up to the glass only.
    const planes: CapturePlane[] = [
      flatPlane('floor', 'horizontal-up', 0, [0, 5], [0, 4]),
      flatPlane('ceiling', 'horizontal-down', 2.6, [0, 5], [0, 4]),
    ]
    const proposal = proposeRoom({
      planes,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).not.toBeNull()
    const xs = proposal.polygon!.map((point) => point[0])
    expect(Math.max(...xs)).toBeLessThan(6.5)
    const glass = proposal.edges.filter((edge) => edge.likelyGlass)
    expect(glass.length).toBeGreaterThan(0)
    expect(glass[0]!.basis === 'floor-boundary' || glass[0]!.basis === 'assumed').toBe(true)
    expect(glass[0]!.seenBeyond!.maxDistance).toBeGreaterThan(2)
    expect(proposal.unknowns.join(' ')).toContain('likely glass')
    expect(proposal.depth?.seenThrough.length ?? 0).toBeGreaterThan(0)
  })

  test('sparse coverage keeps assumed sides and never reports a high-confidence edge', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    // One stop in a corner, turning through a quarter circle: far sides are never seen.
    const { frames, path } = walk(world, [[1, 1]], 6, 0, Math.PI / 2)
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    if (proposal.polygon) {
      expect(proposal.edges.some((edge) => edge.basis === 'assumed')).toBe(true)
      expect(proposal.edges.every((edge) => edge.confidence !== 'high')).toBe(true)
      expect(proposal.unknowns.join(' ')).toContain('not measured walls')
    }
    expect(proposal.needsVerification).toBe(true)
  })

  test('no usable depth falls back to the typed measurements', () => {
    const typed = proposeRoom({
      planes: null,
      depthFrames: [],
      walkedPath: [[0, 1.4, 0]],
      measurements: {
        units: 'm',
        room: { width: 5, length: 4, height: 2.6 },
        openings: [],
        notes: '',
        source: 'manual',
      },
    })
    expect(typed.method).toBe('manual-measurements')
    expect(typed.edges.every((edge) => edge.basis === 'manual-measurement')).toBe(true)
  })

  test('without a walked path the outline is built but the checks are said to be skipped', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({ planes: null, measurements: null, depthFrames: frames })
    expect(proposal.polygon).not.toBeNull()
    expect(proposal.unknowns.join(' ')).toContain('No walked path was given')
    expect(proposal.depth?.pathChecked).toBe(false)
  })
})

describe('floor plane outlines', () => {
  test('only upward planes at the floor are used, in level coordinates', () => {
    const planes: CapturePlane[] = [
      flatPlane('floor', 'horizontal-up', 0, [0, 5], [0, 4]),
      flatPlane('table', 'horizontal-up', 0.75, [1, 2], [1, 2]),
      flatPlane('ceiling', 'horizontal-down', 2.6, [0, 5], [0, 4]),
    ]
    const polygons = floorPolygonsFromPlanes(planes, IDENTITY_SCAN_TRANSFORM, 0)
    expect(polygons).toHaveLength(1)
    const xs = polygons[0]!.map((point) => point[0])
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 5])
  })
})

/** A horizontal plane covering `[x0, x1]` by `[z0, z1]` at height `y`, as ARCore would report it. */
function flatPlane(
  id: string,
  orientation: 'horizontal-up' | 'horizontal-down',
  y: number,
  [x0, x1]: [number, number],
  [z0, z1]: [number, number],
): CapturePlane {
  const centreX = (x0 + x1) / 2
  const centreZ = (z0 + z1) / 2
  const halfX = (x1 - x0) / 2
  const halfZ = (z1 - z0) / 2
  return {
    id,
    orientation,
    // Local Y is the normal: up for a floor, down for a ceiling.
    centerPose: [
      1,
      0,
      0,
      0,
      0,
      orientation === 'horizontal-up' ? 1 : -1,
      0,
      0,
      0,
      0,
      1,
      0,
      centreX,
      y,
      centreZ,
      1,
    ],
    extent: [x1 - x0, z1 - z0],
    polygon: [
      [-halfX, -halfZ],
      [halfX, -halfZ],
      [halfX, halfZ],
      [-halfX, halfZ],
    ],
    subsumedBy: null,
  }
}
