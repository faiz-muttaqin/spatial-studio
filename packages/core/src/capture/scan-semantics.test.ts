import { describe, expect, test } from 'bun:test'
import type { DepthFrameInput } from './depth-walls'
import { IDENTITY_SCAN_TRANSFORM, type Vec3 } from './plane-analysis'
import {
  clusterDetections,
  fitOrientedBox,
  type LiftFrame,
  liftDetections,
  type PlanFrame,
  pickKeyframesForWalls,
  type SemanticDetection,
  type SemanticWall,
} from './scan-semantics'

// Synthetic only: a ray caster over a room with a door, a window and a box-shaped sofa.

const DEPTH_W = 160
const DEPTH_H = 90
const IMAGE_W = 1920
const IMAGE_H = 1080
const DEPTH_INTRINSICS = { fx: 105, fy: 105, cx: 80, cy: 45 }
const IMAGE_INTRINSICS = { fx: 1260, fy: 1260, cx: 960, cy: 540 }
const CAMERA_HEIGHT = 1.4

// The room is x 0..5, z 0..4. The wall under test is the north wall at z = 0, from (0,0) to (5,0).
const NORTH: SemanticWall = { id: 'wall_north', a: [0, 0], b: [5, 0], height: 2.6 }
const WALLS: SemanticWall[] = [
  NORTH,
  { id: 'wall_east', a: [5, 0], b: [5, 4], height: 2.6 },
  { id: 'wall_south', a: [5, 4], b: [0, 4], height: 2.6 },
  { id: 'wall_west', a: [0, 4], b: [0, 0], height: 2.6 },
]

type Aabb = { min: Vec3; max: Vec3 }
type Scene = {
  /** Axis-aligned boxes; the walls, floor and ceiling are thin ones. */
  boxes: Aabb[]
  /** Rays through these return no depth: glass, dark surfaces, out of range. */
  holes: Aabb[]
}

const thin = 0.05
/** The north wall with a door (x 1.0..1.9, to 2.1 m) and a window (x 3.0..4.2, sill 0.9, top 2.1). */
function room(options: { sofa?: Aabb; extra?: Aabb[] } = {}): Scene {
  const boxes: Aabb[] = [
    { min: [-0.5, -0.1, -0.5], max: [5.5, 0, 4.5] },
    { min: [-0.5, 2.6, -0.5], max: [5.5, 2.7, 4.5] },
    // North wall pieces around the door and the window.
    { min: [-0.5, 0, -thin], max: [1.0, 2.6, 0] },
    { min: [1.9, 0, -thin], max: [3.0, 2.6, 0] },
    { min: [4.2, 0, -thin], max: [5.5, 2.6, 0] },
    { min: [1.0, 2.1, -thin], max: [1.9, 2.6, 0] },
    { min: [3.0, 0, -thin], max: [4.2, 0.9, 0] },
    { min: [3.0, 2.1, -thin], max: [4.2, 2.6, 0] },
    // The other walls.
    { min: [5, 0, -0.5], max: [5 + thin, 2.6, 4.5] },
    { min: [-0.5, 0, 4], max: [5.5, 2.6, 4 + thin] },
    { min: [-thin, 0, -0.5], max: [0, 2.6, 4.5] },
  ]
  if (options.sofa) boxes.push(options.sofa)
  if (options.extra) boxes.push(...options.extra)
  return { boxes, holes: [] }
}

function rayBox(origin: Vec3, dir: Vec3, box: Aabb): number | null {
  let near = 0
  let far = Number.POSITIVE_INFINITY
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(dir[axis]!) < 1e-12) {
      if (origin[axis]! < box.min[axis]! || origin[axis]! > box.max[axis]!) return null
      continue
    }
    let t0 = (box.min[axis]! - origin[axis]!) / dir[axis]!
    let t1 = (box.max[axis]! - origin[axis]!) / dir[axis]!
    if (t0 > t1) [t0, t1] = [t1, t0]
    near = Math.max(near, t0)
    far = Math.min(far, t1)
    if (near > far) return null
  }
  return near > 1e-6 ? near : null
}

/** OpenGL camera-to-world, column-major, looking along `yaw` in XZ (0 = +X, pi/2 = +Z). */
function pose(x: number, z: number, yaw: number, roll = 0, height = CAMERA_HEIGHT): number[] {
  const forward = [Math.cos(yaw), 0, Math.sin(yaw)]
  const right0 = [-Math.sin(yaw), 0, Math.cos(yaw)]
  // Rolling about the viewing axis turns the image, as a phone's sensor-orientation readout does.
  const right = right0.map(
    (value, axis) => value * Math.cos(roll) + [0, 1, 0][axis]! * Math.sin(roll),
  )
  const up = right0.map(
    (value, axis) => -value * Math.sin(roll) + [0, 1, 0][axis]! * Math.cos(roll),
  )
  return [...right, 0, ...up, 0, ...forward.map((value) => -value), 0, x, height, z, 1]
}

function render(id: string, scene: Scene, matrix: number[], k = DEPTH_INTRINSICS): DepthFrameInput {
  const depth = new Uint16Array(DEPTH_W * DEPTH_H)
  const confidence = new Uint8Array(DEPTH_W * DEPTH_H).fill(255)
  const origin: Vec3 = [matrix[12]!, matrix[13]!, matrix[14]!]
  for (let py = 0; py < DEPTH_H; py += 1) {
    for (let px = 0; px < DEPTH_W; px += 1) {
      const x = (px + 0.5 - k.cx) / k.fx
      const y = (k.cy - (py + 0.5)) / k.fy
      // Camera-space direction (x, y, -1) through the pose rotation.
      const dir: Vec3 = [
        matrix[0]! * x + matrix[4]! * y - matrix[8]!,
        matrix[1]! * x + matrix[5]! * y - matrix[9]!,
        matrix[2]! * x + matrix[6]! * y - matrix[10]!,
      ]
      let hit = Number.POSITIVE_INFINITY
      for (const box of scene.boxes) {
        const t = rayBox(origin, dir, box)
        if (t !== null && t < hit) hit = t
      }
      const swallowed = scene.holes.some((box) => rayBox(origin, dir, box) !== null)
      // Camera-space depth is the distance along -Z, which is t because dir has z = -1 in camera space.
      if (swallowed || !Number.isFinite(hit)) continue
      depth[py * DEPTH_W + px] = Math.round(hit * 1000)
    }
  }
  return {
    id,
    width: DEPTH_W,
    height: DEPTH_H,
    intrinsics: k,
    pose: matrix,
    depth,
    confidence,
  }
}

function liftFrame(
  id: string,
  scene: Scene,
  matrix: number[],
  depthK = DEPTH_INTRINSICS,
): LiftFrame {
  return {
    id,
    imageWidth: IMAGE_W,
    imageHeight: IMAGE_H,
    rgbIntrinsics: IMAGE_INTRINSICS,
    depth: render(id, scene, matrix, depthK),
  }
}

/** Image pixel of a world point, as the agent would box it. */
function project(matrix: number[], point: Vec3): [number, number] {
  const rel = [point[0] - matrix[12]!, point[1] - matrix[13]!, point[2] - matrix[14]!]
  const along = (axis: number) =>
    rel[0]! * matrix[axis]! + rel[1]! * matrix[axis + 1]! + rel[2]! * matrix[axis + 2]!
  const depth = -along(8)
  return [
    IMAGE_INTRINSICS.cx + (IMAGE_INTRINSICS.fx * along(0)) / depth,
    IMAGE_INTRINSICS.cy - (IMAGE_INTRINSICS.fy * along(4)) / depth,
  ]
}

function boxAround(matrix: number[], corners: Vec3[]): [number, number, number, number] {
  const pixels = corners.map((corner) => project(matrix, corner))
  return [
    Math.min(...pixels.map((p) => p[0])),
    Math.min(...pixels.map((p) => p[1])),
    Math.max(...pixels.map((p) => p[0])),
    Math.max(...pixels.map((p) => p[1])),
  ]
}

const options = { transform: IDENTITY_SCAN_TRANSFORM, floorY: 0 }
const facingNorth = -Math.PI / 2

function detection(
  frameId: string,
  kind: SemanticDetection['kind'],
  label: string,
  box2d: SemanticDetection['box2d'],
  confidence = 0.9,
): SemanticDetection {
  return { frameId, kind, label, box2d, confidence }
}

describe('pickKeyframesForWalls', () => {
  const planFrame = (id: string, x: number, z: number, yaw: number): PlanFrame => ({
    id,
    imageWidth: IMAGE_W,
    imageHeight: IMAGE_H,
    intrinsics: IMAGE_INTRINSICS,
    pose: pose(x, z, yaw),
  })

  test('prefers square-on frames at a good distance and drops the rest', () => {
    const frames = [
      planFrame('square-2m', 2.5, 2, facingNorth),
      planFrame('square-3m', 3, 3, facingNorth),
      planFrame('too-far', 2.5, 3.9, facingNorth),
      planFrame('too-close', 2.5, 0.5, facingNorth),
      planFrame('oblique', 0.5, 2.5, -0.2),
      planFrame('looking-away', 2.5, 2, Math.PI / 2),
    ]
    const [plan] = pickKeyframesForWalls([NORTH], frames, { ...options, perWall: 3 })
    const ids = plan!.frames.map((frame) => frame.frameId)
    expect(ids).toContain('square-2m')
    expect(ids).not.toContain('too-close')
    expect(ids).not.toContain('looking-away')
    expect(ids).not.toContain('oblique')
    const best = plan!.frames[0]!
    expect(best.angleDeg).toBeLessThan(1)
    expect(best.distance).toBeGreaterThanOrEqual(1)
    expect(best.distance).toBeLessThanOrEqual(4)
  })

  test('skips a near-duplicate view and says so when nothing qualifies', () => {
    const frames = [
      planFrame('a', 2.5, 2, facingNorth),
      planFrame('a-again', 2.52, 2.01, facingNorth),
      planFrame('elsewhere', 4.5, 2.5, facingNorth),
    ]
    const [plan] = pickKeyframesForWalls([NORTH], frames, options)
    expect(plan!.frames.map((frame) => frame.frameId)).not.toContain('a-again')
    expect(plan!.frames.length).toBe(2)
    const [none] = pickKeyframesForWalls([NORTH], [planFrame('away', 2.5, 2, Math.PI / 2)], options)
    expect(none!.frames).toEqual([])
    expect(none!.reason).toBeDefined()
  })
})

describe('liftDetections', () => {
  const shot = pose(1.5, 3.8, facingNorth)

  test('lifts a door on a known wall to a position along the wall, width, height and sill', () => {
    const frame = liftFrame('f1', room(), shot)
    const door = detection(
      'f1',
      'door',
      'door',
      boxAround(shot, [
        [1.0, 0, 0],
        [1.9, 2.1, 0],
      ]),
    )
    const [lifted] = liftDetections([door], [frame], WALLS, options)
    expect(lifted!.ok).toBe(true)
    const opening = lifted!.opening!
    expect(opening.wallId).toBe('wall_north')
    expect(opening.positionAlongWall).toBeCloseTo(1.45, 1)
    expect(opening.width).toBeCloseTo(0.9, 1)
    expect(opening.height).toBeCloseTo(2.1, 1)
    expect(opening.sill).toBe(0)
  })

  test('lifts a door from a photo in sensor orientation, rolled a quarter turn', () => {
    const rolled = pose(1.5, 3.8, facingNorth, Math.PI / 2)
    const frame = liftFrame('r1', room(), rolled)
    const door = detection(
      'r1',
      'door',
      'door',
      boxAround(rolled, [
        [1.0, 0, 0],
        [1.9, 2.1, 0],
      ]),
    )
    const [lifted] = liftDetections([door], [frame], WALLS, options)
    expect(lifted!.ok).toBe(true)
    expect(lifted!.opening!.positionAlongWall).toBeCloseTo(1.45, 1)
    expect(lifted!.opening!.width).toBeCloseTo(0.9, 1)
    expect(lifted!.opening!.height).toBeCloseTo(2.1, 1)
  })

  test('lifts a window with its sill height', () => {
    const view = pose(3.6, 2.5, facingNorth)
    const frame = liftFrame('f2', room(), view)
    const window = detection(
      'f2',
      'window',
      'window',
      boxAround(view, [
        [3.0, 0.9, 0],
        [4.2, 2.1, 0],
      ]),
    )
    const [lifted] = liftDetections([window], [frame], WALLS, options)
    expect(lifted!.ok).toBe(true)
    const opening = lifted!.opening!
    expect(opening.positionAlongWall).toBeCloseTo(3.6, 1)
    expect(opening.width).toBeCloseTo(1.2, 1)
    expect(opening.height).toBeCloseTo(1.2, 1)
    expect(opening.sill).toBeCloseTo(0.9, 1)
  })

  test('fits a yawed box to a box-shaped sofa', () => {
    // 1.8 m wide, 0.9 m deep, 0.8 m high, against the south wall, turned 90 degrees to the walls.
    const sofa = { min: [1.5, 0, 0.4] as Vec3, max: [3.3, 0.8, 1.3] as Vec3 }
    const scene = room({ sofa })
    const views = [
      pose(2.4, 3.9, facingNorth, 0, 1.0),
      pose(0.5, 3.4, -1.1, 0, 1.0),
      pose(4.5, 3.4, -2.05, 0, 1.0),
    ]
    const frames = views.map((view, index) => liftFrame(`s${index}`, scene, view))
    const detections = views.map((view, index) =>
      detection(
        `s${index}`,
        'furniture',
        'sofa',
        boxAround(view, [
          [1.5, 0, 0.4],
          [3.3, 0.8, 0.4],
          [1.5, 0, 1.3],
          [3.3, 0.8, 1.3],
          [1.5, 0.8, 1.3],
          [3.3, 0.8, 0.4],
        ]),
      ),
    )
    const lifted = liftDetections(detections, frames, WALLS, options)
    expect(lifted.every((item) => item.ok)).toBe(true)
    const result = clusterDetections(lifted, WALLS, options)
    expect(result.furniture).toHaveLength(1)
    const sofaOut = result.furniture[0]!
    expect(sofaOut.status).toBe('confirmed')
    expect(sofaOut.viewCount).toBe(3)
    expect(sofaOut.centre[0]).toBeCloseTo(2.4, 0)
    expect(sofaOut.centre[1]).toBeCloseTo(0.85, 0)
    expect(Math.abs(sofaOut.size.width - 1.8)).toBeLessThan(0.25)
    // One view sees surfaces, not volumes, so depth is a lower bound.
    expect(sofaOut.size.depth).toBeGreaterThan(0.35)
    expect(sofaOut.size.depth).toBeLessThan(1.1)
    expect(Math.abs(sofaOut.size.height - 0.8)).toBeLessThan(0.15)
    expect(sofaOut.yawSnappedToWall).not.toBeNull()
    expect(sofaOut.basis).toBe('estimate')
  })

  test('refuses a box over a depth hole instead of inventing a position', () => {
    const scene = room()
    scene.holes.push({ min: [3, 0, 1.2], max: [4.2, 2.6, 1.8] })
    const view = pose(3.6, 2.5, facingNorth)
    const frame = liftFrame('h1', scene, view)
    const over = detection(
      'h1',
      'furniture',
      'cabinet',
      boxAround(view, [
        [3.55, 0, 1],
        [3.95, 1.8, 1],
      ]),
    )
    const [lifted] = liftDetections([over], [frame], WALLS, options)
    expect(lifted!.ok).toBe(false)
    expect(lifted!.reason).toBe('no_depth')
    const result = clusterDetections([lifted!], WALLS, options)
    expect(result.furniture).toEqual([])
    expect(result.unlifted[0]!.reason).toBe('no_depth')
  })

  test('says why a detection could not be lifted for an unknown frame or an empty box', () => {
    const frame = liftFrame('f1', room(), shot)
    const lifted = liftDetections(
      [
        detection('nope', 'door', 'door', [0, 0, 100, 100]),
        detection('f1', 'door', 'door', [500, 500, 500, 500]),
        detection('f1', 'door', 'door', [100, 100, 300, 400]),
      ],
      [frame],
      [],
      options,
    )
    expect(lifted.map((item) => (item.ok ? 'ok' : item.reason))).toEqual([
      'frame_not_found',
      'box_outside_image',
      'no_walls',
    ])
  })
})

describe('clusterDetections', () => {
  test('flags a door seen in one view as uncertain and confirms one seen in two', () => {
    const scene = room()
    const first = pose(1.5, 3.8, facingNorth)
    const second = pose(2.7, 3.8, facingNorth)
    const third = pose(3.6, 2.5, facingNorth)
    const frames = [
      liftFrame('a', scene, first),
      liftFrame('b', scene, second),
      liftFrame('c', scene, third),
    ]
    const doorBox = (view: number[]) =>
      boxAround(view, [
        [1.0, 0, 0],
        [1.9, 2.1, 0],
      ])
    const windowBox = boxAround(third, [
      [3.0, 0.9, 0],
      [4.2, 2.1, 0],
    ])
    const lifted = liftDetections(
      [
        detection('a', 'door', 'door', doorBox(first), 0.9),
        detection('b', 'door', 'Door', doorBox(second), 0.8),
        detection('c', 'window', 'window', windowBox, 0.8),
      ],
      frames,
      WALLS,
      options,
    )
    const result = clusterDetections(lifted, WALLS, options)
    const doors = result.openings.filter((opening) => opening.kind === 'door')
    const windows = result.openings.filter((opening) => opening.kind === 'window')
    expect(doors).toHaveLength(1)
    expect(doors[0]!.status).toBe('confirmed')
    expect(doors[0]!.viewCount).toBe(2)
    expect(doors[0]!.evidenceFrameIds).toEqual(['a', 'b'])
    expect(doors[0]!.t).toBeCloseTo(1.45 / 5, 1)
    expect(windows).toHaveLength(1)
    expect(windows[0]!.status).toBe('uncertain')
    expect(windows[0]!.viewCount).toBe(1)
    expect(windows[0]!.confidence).toBeLessThan(0.8)
  })

  test('keeps different openings on one wall apart', () => {
    const scene = room()
    const view = pose(2.5, 3.9, facingNorth)
    const frame = liftFrame('d', scene, view)
    const lifted = liftDetections(
      [
        detection(
          'd',
          'door',
          'door',
          boxAround(view, [
            [1.0, 0, 0],
            [1.9, 2.1, 0],
          ]),
        ),
        detection(
          'd',
          'door',
          'door',
          boxAround(view, [
            [3.0, 0.9, 0],
            [4.2, 2.1, 0],
          ]),
        ),
      ],
      [frame],
      WALLS,
      options,
    )
    expect(clusterDetections(lifted, WALLS, options).openings).toHaveLength(2)
  })
})

describe('review fixes', () => {
  const doorCorners: Vec3[] = [
    [1.0, 0, 0],
    [1.9, 2.1, 0],
  ]

  test('an off-centre camera against an asymmetric opening is not mirrored', () => {
    // Window at x 3.0..4.2 seen from the far left, turned toward it; a mirror would put it near x 1.4.
    const view = pose(0.8, 3.9, -1.0)
    const frame = liftFrame('o1', room(), view)
    const window = detection(
      'o1',
      'window',
      'window',
      boxAround(view, [
        [3.0, 0.9, 0],
        [4.2, 2.1, 0],
      ]),
    )
    const [lifted] = liftDetections([window], [frame], WALLS, options)
    expect(lifted!.ok).toBe(true)
    expect(lifted!.opening!.positionAlongWall).toBeCloseTo(3.6, 1)
    expect(lifted!.opening!.width).toBeCloseTo(1.2, 1)
    // An axis-aligned box around an obliquely seen window is a little taller than the window.
    expect(Math.abs(lifted!.opening!.sill - 0.9)).toBeLessThan(0.12)
  })

  test('a camera whose depth field of view differs from the photo still gives the right width', () => {
    const wideDepth = { fx: 84, fy: 84, cx: 80, cy: 45 }
    const view = pose(1.5, 3.8, facingNorth)
    const frame = liftFrame('w1', room(), view, wideDepth)
    const [lifted] = liftDetections(
      [detection('w1', 'door', 'door', boxAround(view, doorCorners))],
      [frame],
      WALLS,
      options,
    )
    expect(lifted!.ok).toBe(true)
    expect(lifted!.opening!.width).toBeCloseTo(0.9, 1)
    expect(lifted!.opening!.height).toBeCloseTo(2.1, 1)
    expect(lifted!.opening!.positionAlongWall).toBeCloseTo(1.45, 1)
  })

  test('wall drift is measured from depth, re-cast, and keeps the opening uncertain', () => {
    const drifted: SemanticWall[] = [{ ...NORTH, a: [0, 0.25], b: [5, 0.25] }, ...WALLS.slice(1)]
    const views = [pose(1.5, 3.8, facingNorth), pose(2.7, 3.8, facingNorth)]
    const scene = room()
    const frames = views.map((view, i) => liftFrame(`dr${i}`, scene, view))
    const lifted = liftDetections(
      views.map((view, i) => detection(`dr${i}`, 'door', 'door', boxAround(view, doorCorners))),
      frames,
      drifted,
      options,
    )
    expect(lifted.every((item) => item.ok)).toBe(true)
    expect(lifted[0]!.opening!.wallOffset).toBeCloseTo(-0.25, 1)
    expect(lifted[0]!.opening!.width).toBeCloseTo(0.9, 1)
    const door = clusterDetections(lifted, drifted, options).openings[0]!
    expect(door.status).toBe('uncertain')
    expect(door.doubts.join(' ')).toContain('drifted')
  })

  test('two views from the same spot do not confirm each other', () => {
    const view = pose(1.5, 3.8, facingNorth)
    const frames = [
      liftFrame('s1', room(), view),
      liftFrame('s2', room(), pose(1.52, 3.8, facingNorth)),
    ]
    const lifted = liftDetections(
      [
        detection('s1', 'door', 'door', boxAround(view, doorCorners)),
        detection('s2', 'door', 'door', boxAround(view, doorCorners)),
      ],
      frames,
      WALLS,
      options,
    )
    const door = clusterDetections(lifted, WALLS, options).openings[0]!
    expect(door.viewCount).toBe(2)
    expect(door.status).toBe('uncertain')
  })

  test('a box touching the image edge is truncated and uncertain', () => {
    const view = pose(1.5, 2.5, facingNorth)
    const frame = liftFrame('t1', room(), view)
    const [lifted] = liftDetections(
      [detection('t1', 'door', 'door', boxAround(view, doorCorners))],
      [frame],
      WALLS,
      options,
    )
    expect(lifted!.ok).toBe(true)
    expect(lifted!.opening!.doubts.join(' ')).toContain('image edge')
  })

  test('a yawed footprint gets its yaw and size, with the real base', () => {
    const yaw = (30 * Math.PI) / 180
    const points: Vec3[] = []
    for (let i = 0; i <= 20; i += 1) {
      for (let j = 0; j <= 8; j += 1) {
        const a = -0.9 + (1.8 * i) / 20
        const b = -0.45 + (0.9 * j) / 8
        points.push([
          2 + a * Math.cos(yaw) - b * Math.sin(yaw),
          0.4 + (i % 3) * 0.2,
          1 + a * Math.sin(yaw) + b * Math.cos(yaw),
        ])
      }
    }
    const fit = fitOrientedBox(points, [], 0)!
    expect((fit.yaw * 180) / Math.PI).toBeCloseTo(30, -1)
    expect(Math.abs((fit.yaw * 180) / Math.PI - 30)).toBeLessThan(4)
    expect(fit.width).toBeGreaterThan(1.6)
    expect(fit.width).toBeLessThan(1.95)
    expect(fit.depth).toBeGreaterThan(0.75)
    expect(fit.depth).toBeLessThan(1.0)
    expect(fit.floating).toBe(true)
    expect(fit.baseY).toBeCloseTo(0.4, 1)
  })

  test('two chairs half a metre apart in one photo stay two, and different labels stay apart', () => {
    const chairA: Aabb = { min: [1.6, 0, 1.0], max: [2.0, 0.9, 1.4] }
    const chairB: Aabb = { min: [2.1, 0, 1.0], max: [2.5, 0.9, 1.4] }
    const scene = room({ extra: [chairA, chairB] })
    const views = [pose(1.8, 3.9, facingNorth, 0, 0.9), pose(2.9, 3.9, facingNorth - 0.2, 0, 0.9)]
    const frames = views.map((view, i) => liftFrame(`c${i}`, scene, view))
    const boxes = (view: number[], chair: Aabb) =>
      boxAround(view, [
        [chair.min[0], 0, chair.min[2]],
        [chair.max[0], 0.9, chair.max[2]],
      ])
    const lifted = liftDetections(
      [
        detection('c0', 'furniture', 'chair', boxes(views[0]!, chairA)),
        detection('c0', 'furniture', 'chair', boxes(views[0]!, chairB)),
        detection('c1', 'furniture', 'chair', boxes(views[1]!, chairA)),
        detection('c1', 'furniture', 'chair', boxes(views[1]!, chairB)),
      ],
      frames,
      WALLS,
      options,
    )
    expect(lifted.every((item) => item.ok)).toBe(true)
    expect(clusterDetections(lifted, WALLS, options).furniture).toHaveLength(2)
    const relabelled = lifted.map((item, i) =>
      i === 2 ? { ...item, detection: { ...item.detection, label: 'bookcase' } } : item,
    )
    expect(clusterDetections(relabelled, WALLS, options).furniture.length).toBeGreaterThan(2)
    const synonyms = lifted.map((item, i) =>
      i === 2 ? { ...item, detection: { ...item.detection, label: 'Chair ' } } : item,
    )
    expect(clusterDetections(synonyms, WALLS, options).furniture).toHaveLength(2)
  })

  test('worst case: 200 large furniture boxes are bounded in time and per frame', () => {
    const view = pose(2.5, 3.9, facingNorth)
    const frames = Array.from({ length: 10 }, (_, i) => liftFrame(`z${i}`, room(), view))
    const started = performance.now()
    const detections = Array.from({ length: 200 }, (_, i) =>
      detection(`z${i % 10}`, 'furniture', 'cabinet', [100, 100, 1500, 800]),
    )
    const lifted = liftDetections(detections, frames, WALLS, options)
    clusterDetections(lifted, WALLS, options)
    expect(performance.now() - started).toBeLessThan(3000)
    const refused = lifted.filter((item) => !item.ok)
    expect(refused.some((item) => !item.ok && item.reason === 'too_many_boxes_in_frame')).toBe(
      false,
    )
    expect(lifted.filter((item) => item.ok).length).toBeLessThanOrEqual(200)
    const full = liftDetections(
      [detection('z0', 'furniture', 'cabinet', [0, 0, 1920, 1080])],
      frames,
      WALLS,
      options,
    )
    expect(full[0]!.ok === false && full[0]!.reason).toBe('box_too_large')
    const many = liftDetections(
      Array.from({ length: 200 }, () =>
        detection('z0', 'furniture', 'cabinet', [300, 300, 900, 800]),
      ),
      frames,
      WALLS,
      options,
    )
    expect(many.filter((item) => item.ok).length).toBeLessThanOrEqual(20)
    expect(many.some((item) => !item.ok && item.reason === 'too_many_boxes_in_frame')).toBe(true)
  })
})
