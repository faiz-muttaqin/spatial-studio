import type { DepthFrameInput } from './depth-walls'
import type { Vec2 } from './plane-analysis'

// Synthetic depth only: a ray caster over a vertical-wall world, no real capture data.

export type Segment = { a: Vec2; b: Vec2 }
export type World = {
  /** Solid walls: depth returns from them. */
  walls: Segment[]
  /** Clear glass: rays pass through it. */
  glass?: Segment[]
  /** Furniture: solid axis-aligned boxes standing on the floor, `top` metres high. */
  boxes?: Box[]
  height: number
  /** Floor and ceiling return depth only up to this x, like ground and sky outside a glass wall. */
  indoorUntilX?: number
  /** Sensor noise: range error as a share of distance plus a fixed term, dropout, low-confidence pixels, hand wander. */
  noise?: Noise
}
export type Box = { min: Vec2; max: Vec2; top: number }
export type Noise = {
  /** Gaussian range error as a share of distance, for example 0.04. */
  relative: number
  /** Fixed Gaussian range error, metres. */
  fixed: number
  /** Share of pixels with no depth. */
  dropout: number
  /** Share of pixels with confidence below 100. */
  lowConfidence: number
  /** Standard deviation of position (m) and heading (rad) wander between frames. */
  wander: { position: number; yaw: number }
}
export type Camera = { x: number; z: number; yaw: number; pitch: number }

export const WIDTH = 160
export const HEIGHT = 90
export const INTRINSICS = { fx: 105, fy: 105, cx: 80, cy: 45 }
export const CAMERA_HEIGHT = 1.4

export function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** OpenGL camera-to-world, column-major: +X right, +Y up, -Z forward. Yaw turns in XZ, pitch tilts up. */
export function cameraPose(camera: Camera): number[] {
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

export function raySegment(origin: Vec2, direction: Vec2, segment: Segment): number | null {
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

/** Where a ray enters a box (slab method), as a multiple of `direction`; null when it misses. */
function rayBox(origin: number[], direction: number[], box: Box): number | null {
  const lo = [box.min[0], 0, box.min[1]]
  const hi = [box.max[0], box.top, box.max[1]]
  let near = Number.NEGATIVE_INFINITY
  let far = Number.POSITIVE_INFINITY
  for (let axis = 0; axis < 3; axis += 1) {
    const o = origin[axis]!
    const d = direction[axis]!
    if (Math.abs(d) < 1e-12) {
      if (o < lo[axis]! || o > hi[axis]!) return null
      continue
    }
    const t1 = (lo[axis]! - o) / d
    const t2 = (hi[axis]! - o) / d
    near = Math.max(near, Math.min(t1, t2))
    far = Math.min(far, Math.max(t1, t2))
  }
  return near <= far && near > 1e-6 ? near : null
}

export function renderFrame(
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
      const cx = (u - INTRINSICS.cx) / INTRINSICS.fx
      const cy = -(v - INTRINSICS.cy) / INTRINSICS.fy
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
      for (const box of world.boxes ?? []) {
        const t = rayBox([camera.x, CAMERA_HEIGHT, camera.z], dir, box)
        if (t !== null) best = Math.min(best, t)
      }
      const flat = dir[1]! < 0 ? -CAMERA_HEIGHT / dir[1]! : (world.height - CAMERA_HEIGHT) / dir[1]!
      if (
        dir[1] !== 0 &&
        (world.indoorUntilX === undefined || camera.x + dir[0]! * flat <= world.indoorUntilX)
      ) {
        best = Math.min(best, flat)
      }
      if (!Number.isFinite(best)) continue
      const noise = world.noise
      if (noise) {
        if (random() < noise.dropout) continue
        const sigma = noise.relative * best + noise.fixed
        depth[v * WIDTH + u] = Math.max(1, Math.round((best + gaussian(random) * sigma) * 1000))
        if (random() < noise.lowConfidence)
          confidence[v * WIDTH + u] = 20 + Math.floor(random() * 80)
        continue
      }
      depth[v * WIDTH + u] = Math.round((best + (random() - 0.5) * 0.02) * 1000)
    }
  }
  return { id, width: WIDTH, height: HEIGHT, intrinsics: INTRINSICS, pose, depth, confidence }
}

/** A walk along `positions`, turning through `turns` headings at each stop. */
export function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())
}

export function walk(
  world: World,
  positions: Vec2[],
  turns = 10,
  yawFrom = 0,
  yawSpan = Math.PI * 2,
) {
  const random = rng(7)
  const frames: DepthFrameInput[] = []
  const path: Array<[number, number, number]> = []
  positions.forEach(([x, z], stop) => {
    for (let turn = 0; turn < turns; turn += 1) {
      const yaw = yawFrom + (yawSpan * turn) / turns
      const pitch = [-0.35, 0, 0.35][turn % 3]!
      const wander = world.noise?.wander
      const camera = wander
        ? {
            x: x + gaussian(random) * wander.position,
            z: z + gaussian(random) * wander.position,
            yaw: yaw + gaussian(random) * wander.yaw,
            pitch,
          }
        : { x, z, yaw, pitch }
      frames.push(renderFrame(`d${stop}-${turn}`, world, camera, random))
    }
    path.push([x, CAMERA_HEIGHT, z])
  })
  return { frames, path }
}

export function loop(x0: number, z0: number, x1: number, z1: number, step = 0.8): Vec2[] {
  const out: Vec2[] = []
  for (let x = x0; x < x1; x += step) out.push([x, z0])
  for (let z = z0; z < z1; z += step) out.push([x1, z])
  for (let x = x1; x > x0; x -= step) out.push([x, z1])
  for (let z = z1; z > z0; z -= step) out.push([x0, z])
  return out
}

export function polygonWalls(points: Vec2[]): Segment[] {
  return points.map((a, index) => ({ a, b: points[(index + 1) % points.length]! }))
}

export function area(points: readonly Vec2[]): number {
  let sum = 0
  points.forEach(([x1, z1], index) => {
    const [x2, z2] = points[(index + 1) % points.length]!
    sum += x1 * z2 - x2 * z1
  })
  return Math.abs(sum) / 2
}
