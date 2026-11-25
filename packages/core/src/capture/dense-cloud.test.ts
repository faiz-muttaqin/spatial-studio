import { describe, expect, test } from 'bun:test'
import { buildDenseCloud, type DenseCloudFrame, sampleWeight } from './dense-cloud'
import { buildOrthomap, downscaleOrthomap } from './orthomap'
import type { ScanTransform } from './plane-analysis'

// A box room, x in [-2, 2], z in [-1.5, 1.5], y in [0, 2.5], seen by synthetic cameras that
// ray-cast it. Each wall and floor quadrant has its own colour so a mirror or a swap shows up.
const HALF_X = 2
const HALF_Z = 1.5
const ROOM_HEIGHT = 2.5

type Rgb = [number, number, number]
const RED: Rgb = [220, 30, 30] // +X wall
const BLUE: Rgb = [30, 30, 220] // -X wall
const GREEN: Rgb = [30, 200, 30] // +Z wall
const YELLOW: Rgb = [230, 220, 30] // -Z wall
const WHITE: Rgb = [235, 235, 235] // ceiling
const FLOOR_PX_PZ: Rgb = [220, 30, 220] // x > 0, z > 0 magenta
const FLOOR_PX_NZ: Rgb = [30, 210, 210] // x > 0, z < 0 cyan
const FLOOR_NX_PZ: Rgb = [240, 140, 30] // x < 0, z > 0 orange
const FLOOR_NX_NZ: Rgb = [110, 110, 110] // x < 0, z < 0 grey

function floorColour(x: number, z: number): Rgb {
  if (x > 0) return z > 0 ? FLOOR_PX_PZ : FLOOR_PX_NZ
  return z > 0 ? FLOOR_NX_PZ : FLOOR_NX_NZ
}

/** The first hit of a ray inside the room: distance along the (unnormalised) ray and the colour. */
function cast(origin: number[], dir: number[]): { t: number; colour: Rgb } | null {
  let best: { t: number; colour: Rgb } | null = null
  const consider = (t: number, colour: Rgb) => {
    if (t > 1e-6 && (!best || t < best.t)) best = { t, colour }
  }
  const [ox, oy, oz] = origin as [number, number, number]
  const [dx, dy, dz] = dir as [number, number, number]
  if (dx > 1e-9) consider((HALF_X - ox) / dx, RED)
  if (dx < -1e-9) consider((-HALF_X - ox) / dx, BLUE)
  if (dz > 1e-9) consider((HALF_Z - oz) / dz, GREEN)
  if (dz < -1e-9) consider((-HALF_Z - oz) / dz, YELLOW)
  if (dy > 1e-9) consider((ROOM_HEIGHT - oy) / dy, WHITE)
  if (dy < -1e-9) {
    const t = -oy / dy
    consider(t, floorColour(ox + t * dx, oz + t * dz))
  }
  return best
}

/** Column-major camera-to-world, OpenGL axes: yaw about Y (0 looks down -Z), then pitch down. */
function poseAt(position: [number, number, number], yaw: number, pitch: number): number[] {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  // Right, up, back as world vectors.
  const right = [cy, 0, -sy]
  const forward = [-sy * cp, -sp, -cy * cp]
  const up = [
    forward[1]! * right[2]! - forward[2]! * right[1]!,
    forward[2]! * right[0]! - forward[0]! * right[2]!,
    forward[0]! * right[1]! - forward[1]! * right[0]!,
  ].map((v) => -v)
  // up = right x (-forward) ... build it so that right x up = back (= -forward).
  const back = [-forward[0]!, -forward[1]!, -forward[2]!]
  const upVector = [
    back[1]! * right[2]! - back[2]! * right[1]!,
    back[2]! * right[0]! - back[0]! * right[2]!,
    back[0]! * right[1]! - back[1]! * right[0]!,
  ]
  void up
  return [...right, 0, ...upVector, 0, ...back, 0, ...position, 1]
}

function renderFrame(
  id: string,
  pose: number[],
  options: { gain?: number; withImage?: boolean } = {},
): DenseCloudFrame {
  const width = 160
  const height = 90
  const intrinsics = { fx: 120, fy: 120, cx: 80, cy: 45 }
  const scale = 4
  const imageW = width * scale
  const imageH = height * scale
  const imageIntrinsics = { fx: 120 * scale, fy: 120 * scale, cx: 80 * scale, cy: 45 * scale }
  const origin = [pose[12]!, pose[13]!, pose[14]!]
  const world = (cx: number, cy: number, cz: number) => [
    pose[0]! * cx + pose[4]! * cy + pose[8]! * cz,
    pose[1]! * cx + pose[5]! * cy + pose[9]! * cz,
    pose[2]! * cx + pose[6]! * cy + pose[10]! * cz,
  ]
  const depth = new Uint16Array(width * height)
  const confidence = new Uint8Array(width * height).fill(230)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const hit = cast(
        origin,
        world((x - intrinsics.cx) / intrinsics.fx, -(y - intrinsics.cy) / intrinsics.fy, -1),
      )
      depth[y * width + x] = hit ? Math.round(hit.t * 1000) : 0
    }
  }
  const data = new Uint8Array(imageW * imageH * 3)
  const gain = options.gain ?? 1
  for (let y = 0; y < imageH; y += 1) {
    for (let x = 0; x < imageW; x += 1) {
      const hit = cast(
        origin,
        world(
          (x - imageIntrinsics.cx) / imageIntrinsics.fx,
          -(y - imageIntrinsics.cy) / imageIntrinsics.fy,
          -1,
        ),
      )
      const colour = hit?.colour ?? [0, 0, 0]
      for (let c = 0; c < 3; c += 1)
        data[(y * imageW + x) * 3 + c] = Math.min(255, colour[c]! * gain)
    }
  }
  return {
    id,
    width,
    height,
    intrinsics,
    pose,
    depth,
    confidence,
    image:
      options.withImage === false
        ? null
        : { width: imageW, height: imageH, channels: 3, data, intrinsics: imageIntrinsics },
  }
}

function roomFrames(gains: number[] = []): DenseCloudFrame[] {
  const frames: DenseCloudFrame[] = []
  const spots: Array<[number, number]> = [
    [-1, -0.6],
    [1, 0.5],
    [0, 0],
    [-0.8, 0.7],
    [0.9, -0.7],
  ]
  let n = 0
  for (const [x, z] of spots) {
    for (let k = 0; k < 8; k += 1) {
      const yaw = (k * Math.PI * 2) / 8
      frames.push(renderFrame(`f${n}`, poseAt([x, 1.4, z], yaw, 0.45), { gain: gains[n] ?? 1 }))
      n += 1
    }
  }
  return frames
}

const cloudOptions = { maxFrames: 60 }

function pixelAt(
  map: ReturnType<typeof buildOrthomap>,
  x: number,
  z: number,
): [number, number, number, number] {
  const column = Math.floor((x - map.origin[0]) / map.metresPerPixel)
  const row = Math.floor((z - map.origin[1]) / map.metresPerPixel)
  const at = (row * map.width + column) * 4
  return [map.rgba[at]!, map.rgba[at + 1]!, map.rgba[at + 2]!, map.rgba[at + 3]!]
}

function near(actual: ArrayLike<number>, expected: Rgb, tolerance = 40) {
  for (let c = 0; c < 3; c += 1)
    expect(Math.abs(actual[c]! - expected[c]!)).toBeLessThanOrEqual(tolerance)
}

describe('sampleWeight', () => {
  test('is the SceneView weight: full inside 1 m, 1/d^2 beyond, scaled by confidence and cosine', () => {
    expect(sampleWeight(255, 0.8, 1)).toBeCloseTo(1, 6)
    expect(sampleWeight(255, 2, 1)).toBeCloseTo(0.25, 6)
    expect(sampleWeight(128, 1, 0.5)).toBeCloseTo((128 / 255) * 0.5, 6)
    // A point 4 m away at confidence 130 face on counts about 1/31 of one 0.8 m away at 250.
    expect(sampleWeight(130, 4, 1) / sampleWeight(250, 0.8, 1)).toBeCloseTo(1 / 31, 1)
  })
})

describe('buildDenseCloud', () => {
  const frames = roomFrames()
  const cloud = buildDenseCloud(frames, cloudOptions)

  test('fuses the box room into voxels that lie on its surfaces', () => {
    expect(cloud.count).toBeGreaterThan(5_000)
    let off = 0
    for (let i = 0; i < cloud.count; i += 1) {
      const x = cloud.positions[i * 3]!
      const y = cloud.positions[i * 3 + 1]!
      const z = cloud.positions[i * 3 + 2]!
      const onWall = Math.abs(Math.abs(x) - HALF_X) < 0.06 || Math.abs(Math.abs(z) - HALF_Z) < 0.06
      const onFloorCeiling = Math.abs(y) < 0.06 || Math.abs(y - ROOM_HEIGHT) < 0.06
      if (!onWall && !onFloorCeiling) off += 1
    }
    expect(off / cloud.count).toBeLessThan(0.01)
    expect(cloud.stats.framesUsed).toBeGreaterThan(0)
    for (let i = 0; i < cloud.count; i += 1) expect(cloud.views[i]).toBeGreaterThanOrEqual(2)
  })

  test('colours each wall with its own colour along the same ray', () => {
    const wallColour = (axis: 0 | 2, sign: number) => {
      const sums = [0, 0, 0]
      let n = 0
      const half = axis === 0 ? HALF_X : HALF_Z
      for (let i = 0; i < cloud.count; i += 1) {
        const y = cloud.positions[i * 3 + 1]!
        if (y < 0.4 || y > 2.0) continue
        if (Math.abs(cloud.positions[i * 3 + axis]! - sign * half) > 0.05) continue
        // Stay clear of the corners, where photo and depth pixels straddle two walls.
        const other = cloud.positions[i * 3 + (axis === 0 ? 2 : 0)]!
        if (Math.abs(other) > (axis === 0 ? HALF_Z : HALF_X) - 0.3) continue
        for (let c = 0; c < 3; c += 1) sums[c] += cloud.colors[i * 3 + c]!
        n += 1
      }
      expect(n).toBeGreaterThan(50)
      return sums.map((sum) => sum / n)
    }
    near(wallColour(0, 1), RED)
    near(wallColour(0, -1), BLUE)
    near(wallColour(2, 1), GREEN)
    near(wallColour(2, -1), YELLOW)
  })

  test('drops depth below the confidence gate and outside the depth gate', () => {
    const frame = renderFrame('low', poseAt([0, 1.4, 0], 0, 0.45))
    frame.confidence!.fill(100)
    expect(buildDenseCloud([frame, frame], { minViews: 1 }).count).toBe(0)
    const far = renderFrame('far', poseAt([0, 1.4, 0], 0, 0.45))
    const clipped = buildDenseCloud([far, far], { minViews: 1, maxDepthM: 2.5 })
    expect(clipped.count).toBeGreaterThan(0)
    for (let i = 0; i < clipped.count; i += 1) {
      const dx = clipped.positions[i * 3]!
      const dy = clipped.positions[i * 3 + 1]! - 1.4
      const dz = clipped.positions[i * 3 + 2]!
      expect(Math.hypot(dx, dy, dz)).toBeLessThan(2.6)
    }
  })

  test('keeps only voxels two frames saw, and caps the output', () => {
    const one = buildDenseCloud([frames[0]!], { minViews: 2 })
    expect(one.count).toBe(0)
    const capped = buildDenseCloud(frames, { ...cloudOptions, maxPoints: 1000 })
    expect(capped.count).toBe(1000)
    expect(capped.stats.droppedByCap).toBeGreaterThan(0)
  })

  test('rejects a depth jump: a pixel beside a far surface has no normal', () => {
    // A near strip against a far wall: pixels at the step have a neighbour over 5 % away.
    const frame = renderFrame('step', poseAt([0, 1.4, 0], 0, 0), { withImage: false })
    for (let y = 0; y < frame.height; y += 1)
      for (let x = 80; x < frame.width; x += 1) frame.depth[y * frame.width + x] = 1000
    const cloudStep = buildDenseCloud([frame, frame], { minViews: 1 })
    const nearPoints = Array.from(
      { length: cloudStep.count },
      (_, i) => cloudStep.positions[i * 3 + 2]!,
    )
    // The near surface is at z = -1 (camera at the origin looking down -Z).
    const nearSide = nearPoints.filter((z) => Math.abs(z + 1) < 0.05)
    expect(nearSide.length).toBeGreaterThan(0)
    for (const z of nearSide) expect(z).toBeLessThanOrEqual(-0.95)
  })

  test('geometry without photos is mid grey and counted', () => {
    const bare = buildDenseCloud(
      roomFrames()
        .slice(0, 6)
        .map((frame) => ({ ...frame, image: null })),
      { minViews: 2 },
    )
    expect(bare.count).toBeGreaterThan(0)
    expect(bare.stats.uncoloured).toBe(bare.count)
    expect(bare.colors[0]).toBe(128)
  })

  test('normalises per-frame exposure', () => {
    const gains = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.6 : 1))
    const dim = roomFrames(gains)
    const raw = buildDenseCloud(dim, { ...cloudOptions, normaliseExposure: false })
    const fixed = buildDenseCloud(dim, { ...cloudOptions, normaliseExposure: true })
    const spread = (c: typeof raw) => {
      // Standard deviation of luminance across red-wall voxels: the colour is the same everywhere.
      const values: number[] = []
      for (let i = 0; i < c.count; i += 1) {
        if (Math.abs(c.positions[i * 3]! - HALF_X) > 0.05) continue
        values.push(c.colors[i * 3]!)
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length
      return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
    }
    expect(spread(fixed)).toBeLessThan(spread(raw))
    const applied = Object.values(fixed.stats.gains)
    expect(Math.max(...applied) / Math.min(...applied)).toBeGreaterThan(1.3)
  })
})

describe('edge cases', () => {
  test('maxFrames of 1 uses one frame and does not divide by zero', () => {
    const cloudOne = buildDenseCloud(roomFrames().slice(0, 4), { maxFrames: 1, minViews: 1 })
    expect(cloudOne.stats.framesUsed).toBe(1)
    expect(cloudOne.count).toBeGreaterThan(0)
    expect(buildDenseCloud(roomFrames().slice(0, 4), { maxFrames: 0 }).count).toBe(0)
  })

  test('a frame sharing no voxels keeps a gain of exactly 1, and gains stay in range', () => {
    const shared = roomFrames().slice(0, 8)
    // A frame far outside the room shares nothing with the others.
    const alone = renderFrame('alone', poseAt([0, 1.4, 0], 0, 0.45))
    alone.pose = alone.pose.map((v, i) => (i === 12 ? v + 500 : v))
    const result = buildDenseCloud([...shared, alone], { minViews: 1 })
    expect(result.stats.gains.alone).toBe(1)
    for (const gain of Object.values(result.stats.gains)) {
      expect(gain).toBeGreaterThanOrEqual(0.6)
      expect(gain).toBeLessThanOrEqual(1.7)
    }
  })

  test('the coloured mask marks voxels a photo reached', () => {
    const withPhotos = buildDenseCloud(roomFrames().slice(0, 12), { minViews: 2 })
    expect(withPhotos.coloured.every((flag) => flag === 1)).toBe(true)
    const bare = buildDenseCloud(
      roomFrames()
        .slice(0, 12)
        .map((frame) => ({ ...frame, image: null })),
      { minViews: 2 },
    )
    expect(bare.coloured.every((flag) => flag === 0)).toBe(true)
  })
})

describe('buildOrthomap', () => {
  const cloud = buildDenseCloud(roomFrames(), cloudOptions)

  test('puts floor colours in the right quadrants, unmirrored, at the right scale', () => {
    const map = buildOrthomap(cloud, { floorY: 0, ceilingY: ROOM_HEIGHT, layer: 'floor' })
    expect(map.metresPerPixel).toBeCloseTo(0.02, 6)
    // Extent is the room, 4 x 3 m, within the padding.
    expect(map.width * map.metresPerPixel).toBeGreaterThan(3.9)
    expect(map.width * map.metresPerPixel).toBeLessThan(4.5)
    expect(map.height * map.metresPerPixel).toBeGreaterThan(2.9)
    expect(map.height * map.metresPerPixel).toBeLessThan(3.5)
    near(pixelAt(map, 1, 0.75), FLOOR_PX_PZ)
    near(pixelAt(map, 1, -0.75), FLOOR_PX_NZ)
    near(pixelAt(map, -1, 0.75), FLOOR_NX_PZ)
    near(pixelAt(map, -1, -0.75), FLOOR_NX_NZ)
    // Rows run towards +z: the +z side of the image is the lower half.
    expect(pixelAt(map, 1, 0.75)[3]).toBe(255)
  })

  test('the top layer shows walls where their tops stand, each wall in its own colour', () => {
    const map = buildOrthomap(cloud, { floorY: 0, ceilingY: ROOM_HEIGHT, layer: 'top' })
    expect(map.clipY).toBeCloseTo(2.3, 6)
    // The wall is one or two cells wide at its fused position; look along a short run across it.
    const across = (x: number, z: number, dx: number, dz: number, expected: Rgb) => {
      const hits = [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03].filter((offset) => {
        const pixel = pixelAt(map, x + dx * offset, z + dz * offset)
        return pixel[3] === 255 && [0, 1, 2].every((c) => Math.abs(pixel[c]! - expected[c]!) <= 60)
      })
      expect(hits.length).toBeGreaterThan(0)
    }
    across(HALF_X, 0, 1, 0, RED)
    across(-HALF_X, 0, 1, 0, BLUE)
    across(0, HALF_Z, 0, 1, GREEN)
    across(0, -HALF_Z, 0, 1, YELLOW)
    near(pixelAt(map, 1, 0.75), FLOOR_PX_PZ)
  })

  test('reports a transform: level coordinates follow the scan node', () => {
    const transform: ScanTransform = {
      position: [10, 0, -4],
      rotation: [0, Math.PI / 2, 0],
      scale: 1,
    }
    const map = buildOrthomap(cloud, { floorY: 0, transform, layer: 'floor' })
    // three.js XYZ rotation by +90 degrees about Y: (x, z) -> (z, -x), then the position.
    const level = (x: number, z: number): [number, number] => [10 + z, -4 - x]
    near(pixelAt(map, ...level(1, 0.75)), FLOOR_PX_PZ)
    near(pixelAt(map, ...level(-1, -0.75)), FLOOR_NX_NZ)
    near(pixelAt(map, ...level(1, -0.75)), FLOOR_PX_NZ)
  })

  test('grows the cell to fit the pixel cap, and downscales with alpha kept', () => {
    const coarse = buildOrthomap(cloud, { floorY: 0, layer: 'floor', maxPixels: 100 })
    expect(coarse.coarsened).toBe(true)
    expect(Math.max(coarse.width, coarse.height)).toBeLessThanOrEqual(100)
    const fine = buildOrthomap(cloud, { floorY: 0, layer: 'floor' })
    const small = downscaleOrthomap(fine, 100)
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(100)
    expect(small.metresPerPixel).toBeGreaterThan(fine.metresPerPixel)
    expect(small.rgba.length).toBe(small.width * small.height * 4)
    near(pixelAt(small, 1, 0.75), FLOOR_PX_PZ)
  })

  test('downscales by a fractional factor, not by whole halvings', () => {
    const fine = buildOrthomap(cloud, { floorY: 0, layer: 'floor', metresPerPixel: 0.0035 })
    expect(Math.max(fine.width, fine.height)).toBeGreaterThan(1024)
    expect(Math.max(fine.width, fine.height)).toBeLessThan(2048)
    const small = downscaleOrthomap(fine, 1024)
    expect(Math.max(small.width, small.height)).toBeGreaterThan(900)
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(1024)
  })

  test('uncoloured points draw as shape only, and far outliers do not inflate the grid', () => {
    const count = 2000
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (i % 50) * 0.04
      positions[i * 3 + 1] = 0
      positions[i * 3 + 2] = Math.floor(i / 50) * 0.04
    }
    // One stray point 500 m away.
    positions[0] = 500
    const colors = new Uint8Array(count * 3).fill(200)
    const coloured = new Uint8Array(count).fill(1)
    coloured.fill(0, 0, 1000)
    const map = buildOrthomap({ positions, colors, coloured, count }, { floorY: 0, layer: 'floor' })
    expect(map.width * map.metresPerPixel).toBeLessThan(5)
    const alphas = new Set<number>()
    for (let i = 0; i < map.width * map.height; i += 1) alphas.add(map.rgba[i * 4 + 3]!)
    expect(alphas.has(128)).toBe(true)
    expect(alphas.has(255)).toBe(true)
  })

  test('an empty cloud gives an empty map with a note', () => {
    const map = buildOrthomap({
      positions: new Float32Array(0),
      colors: new Uint8Array(0),
      count: 0,
    })
    expect(map.width).toBe(0)
    expect(map.notes.length).toBe(1)
  })
})
