/**
 * Coloured dense cloud from raw depth keyframes and their RGB photos.
 *
 * Pure typed-array code: it works in a browser worker and in Node, and decoding JPEGs is left to
 * adapters (pass decoded RGB in). Methods are ported from SceneView, Apache-2.0, commit
 * 820e17c8537b720c4d7957436475ffa35431c086:
 * - `samples/android-demo/.../demos/internal/DenseCloud.kt`, `DepthBackProjection`: the
 *   0.2 to 5 m and confidence >= 128 gates, the 5 % depth-jump rule, the edge-on cosine limit of
 *   0.15, the normal from the four neighbours and the fusion weight
 *   `confidence/255 * min(1, (1 m / d)^2) * cos(theta)`.
 * - `DenseFusion.kt`: 2 cm voxels holding a weighted mean, saved with 2 or more views. The
 *   coarsening levels are not ported.
 * The back-projection is the official ARCore raw-depth convention (arcore-android-sdk
 * 204ddfd1715e): integer pixel indices, `X = d(x - cx)/fx`, `Y = d(cy - y)/fy`, `Z = -d`, then the
 * keyframe pose (column-major camera-to-world, OpenGL axes, image-readout frame).
 *
 * Colour is read from the RGB keyframe along the same ray: the camera-space point is projected
 * through the photo's intrinsics, so the two images may differ in size and focal length. The depth
 * and the photo are assumed to share one pose (the depth keyframe names its rgb keyframe).
 *
 * The optional exposure normalisation is a per-keyframe gain, solved from how each frame's
 * brightness departs from the fused colour of the voxels it shares with other frames. It is a
 * cheap relative of the gain compensation in RTAB-Map `util3d_surface.cpp` and the per-row offset
 * idea of 3DLiveScanner `postproc/texturize.cc`; nothing from those files is copied.
 */
import type { DepthFrameInput } from './depth-walls'
import type { CameraIntrinsics } from './streams'

/** Decoded photo pixels, row-major, `channels` bytes per pixel (RGB or RGBA). */
export type RgbImage = {
  width: number
  height: number
  channels: 3 | 4
  data: Uint8Array | Uint8ClampedArray
  /** Intrinsics for this image size. Null: the depth intrinsics scaled to the image size. */
  intrinsics?: CameraIntrinsics | null
}

export type DenseCloudFrame = DepthFrameInput & {
  /** The photo of the same instant; without it the frame adds geometry but no colour. */
  image?: RgbImage | null
}

export type DenseCloudOptions = {
  /** Voxel edge in metres. Default 0.02. */
  voxelSize?: number
  /** Depth gate in metres. Default 0.2 to 5. */
  minDepthM?: number
  maxDepthM?: number
  /** Depth pixels below this confidence are dropped when the frame has confidence. Default 128. */
  minConfidence?: number
  /** Surfaces seen more edge-on than this (cosine to the view ray) are dropped. Default 0.15. */
  minViewCosine?: number
  /** Neighbours further apart in depth than this share of it lie on another surface. Default 0.05. */
  edgeFraction?: number
  /** Voxels seen in fewer frames are dropped. Default 2. */
  minViews?: number
  /** Output cap; the voxels with the greatest fused weight are kept. Default 600,000. */
  maxPoints?: number
  /** Frames beyond this many are skipped evenly. Default 150. */
  maxFrames?: number
  /** Per-keyframe exposure gain. Default true. */
  normaliseExposure?: boolean
  /** Stop adding frames after this many milliseconds, keeping what was fused. Default none. */
  maxMillis?: number
}

export type DenseCloud = {
  /** Capture-world metres, xyz per voxel. */
  positions: Float32Array
  /** RGB per voxel. A voxel no photo reached is mid grey and counted in `stats.uncoloured`. */
  colors: Uint8Array
  /** Unit normals, xyz per voxel, in the capture world, facing the cameras that saw it. */
  normals: Float32Array
  /** Fused weight per voxel. */
  weights: Float32Array
  /** Distinct frames that saw the voxel. */
  views: Uint16Array
  count: number
  voxelSize: number
  stats: DenseCloudStats
}

export type DenseCloudStats = {
  framesUsed: number
  framesSkipped: number
  samples: number
  voxelsBeforeFilter: number
  voxelsKept: number
  /** Kept voxels beyond `maxPoints` that were dropped. */
  droppedByCap: number
  /** Kept voxels no photo colour reached. */
  uncoloured: number
  /** True when `maxMillis` ended the run early. */
  timedOut: boolean
  /** Per used frame, the exposure gain applied (1 when normalisation is off). */
  gains: Record<string, number>
}

const DEFAULTS = {
  voxelSize: 0.02,
  minDepthM: 0.2,
  maxDepthM: 5,
  minConfidence: 128,
  minViewCosine: 0.15,
  edgeFraction: 0.05,
  minViews: 2,
  maxPoints: 600_000,
  maxFrames: 150,
}
/** The depth up to which a sample weighs in full; past it the weight falls as 1/d^2. */
const FULL_WEIGHT_M = 1
const GAIN_MIN = 0.6
const GAIN_MAX = 1.7
const GAIN_ITERATIONS = 3
/** Voxel keys use 16 bits per axis around zero: +-655 m at 2 cm. */
const KEY_OFFSET = 32768
const KEY_SPAN = 65536

/** SceneView `DepthBackProjection.weight`. */
export function sampleWeight(confidence: number, depthM: number, cosine: number): number {
  const near = FULL_WEIGHT_M / depthM
  return (confidence / 255) * Math.min(1, near * near) * cosine
}

class Growable {
  private f32: Float32Array
  private u8: Uint8Array
  private u16: Uint16Array
  private i32: Int32Array
  length = 0
  constructor(capacity: number) {
    this.f32 = new Float32Array(capacity)
    this.u8 = new Uint8Array(capacity * 3)
    this.u16 = new Uint16Array(capacity)
    this.i32 = new Int32Array(capacity)
  }
  get capacity(): number {
    return this.f32.length
  }
  private grow() {
    const next = Math.max(1024, this.capacity * 2)
    const f32 = new Float32Array(next)
    f32.set(this.f32)
    const u8 = new Uint8Array(next * 3)
    u8.set(this.u8)
    const u16 = new Uint16Array(next)
    u16.set(this.u16)
    const i32 = new Int32Array(next)
    i32.set(this.i32)
    this.f32 = f32
    this.u8 = u8
    this.u16 = u16
    this.i32 = i32
  }
  push(voxel: number, frame: number, weight: number, r: number, g: number, b: number) {
    if (this.length === this.capacity) this.grow()
    const at = this.length++
    this.i32[at] = voxel
    this.u16[at] = frame
    this.f32[at] = weight
    this.u8[at * 3] = r
    this.u8[at * 3 + 1] = g
    this.u8[at * 3 + 2] = b
  }
  voxel(at: number) {
    return this.i32[at]!
  }
  frame(at: number) {
    return this.u16[at]!
  }
  weight(at: number) {
    return this.f32[at]!
  }
  /** Colour channels; a sample without colour has a negative weight and is skipped. */
  red(at: number) {
    return this.u8[at * 3]!
  }
  green(at: number) {
    return this.u8[at * 3 + 1]!
  }
  blue(at: number) {
    return this.u8[at * 3 + 2]!
  }
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function evenIndices(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, index) => index)
  return Array.from({ length: count }, (_, index) =>
    Math.round((index * (total - 1)) / (count - 1)),
  )
}

/**
 * The photo colour along the depth ray: the camera-space point is projected through the photo's
 * intrinsics, then a small window is averaged (a depth pixel spans many photo pixels). Returns
 * false when the ray falls outside the photo.
 */
function sampleColour(
  image: RgbImage,
  intrinsics: CameraIntrinsics,
  x: number,
  y: number,
  z: number,
  halfWindow: number,
  out: Float64Array,
): boolean {
  if (z >= 0) return false
  const u = intrinsics.cx + (intrinsics.fx * x) / -z
  const v = intrinsics.cy - (intrinsics.fy * y) / -z
  const iu = Math.floor(u)
  const iv = Math.floor(v)
  if (iu < 0 || iv < 0 || iu >= image.width || iv >= image.height) return false
  const step = halfWindow > 1 ? 2 : 1
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let dv = -halfWindow; dv <= halfWindow; dv += step) {
    const row = iv + dv
    if (row < 0 || row >= image.height) continue
    for (let du = -halfWindow; du <= halfWindow; du += step) {
      const col = iu + du
      if (col < 0 || col >= image.width) continue
      const at = (row * image.width + col) * image.channels
      r += image.data[at]!
      g += image.data[at + 1]!
      b += image.data[at + 2]!
      n += 1
    }
  }
  if (n === 0) return false
  out[0] = r / n
  out[1] = g / n
  out[2] = b / n
  return true
}

function photoIntrinsics(frame: DenseCloudFrame, image: RgbImage): CameraIntrinsics {
  if (image.intrinsics) return image.intrinsics
  // Same field of view as the depth camera, scaled to the photo.
  const sx = image.width / frame.width
  const sy = image.height / frame.height
  return {
    fx: frame.intrinsics.fx * sx,
    fy: frame.intrinsics.fy * sy,
    cx: frame.intrinsics.cx * sx,
    cy: frame.intrinsics.cy * sy,
  }
}

export function buildDenseCloud(
  allFrames: readonly DenseCloudFrame[],
  options: DenseCloudOptions = {},
): DenseCloud {
  const o = { ...DEFAULTS, ...options }
  const started = Date.now()
  const voxelSize = o.voxelSize
  const inverseVoxel = 1 / voxelSize
  const stats: DenseCloudStats = {
    framesUsed: 0,
    framesSkipped: 0,
    samples: 0,
    voxelsBeforeFilter: 0,
    voxelsKept: 0,
    droppedByCap: 0,
    uncoloured: 0,
    timedOut: false,
    gains: {},
  }

  const frameIndexes = evenIndices(allFrames.length, o.maxFrames)
  stats.framesSkipped = allFrames.length - frameIndexes.length

  const keyToVoxel = new Map<number, number>()
  // Per voxel accumulators (Float64: capture coordinates reach tens of metres).
  let capacity = 4096
  let sumPos = new Float64Array(capacity * 3)
  let sumNormal = new Float64Array(capacity * 3)
  let sumWeight = new Float64Array(capacity)
  let views = new Uint16Array(capacity)
  let lastFrame = new Int32Array(capacity).fill(-1)
  const growVoxels = () => {
    capacity *= 2
    const grow = <T extends Float64Array | Uint16Array | Int32Array>(
      array: T,
      width: number,
      fill?: number,
    ): T => {
      const next = new (array.constructor as new (length: number) => T)(capacity * width)
      next.set(array)
      if (fill !== undefined) next.fill(fill, array.length)
      return next
    }
    sumPos = grow(sumPos, 3)
    sumNormal = grow(sumNormal, 3)
    sumWeight = grow(sumWeight, 1)
    views = grow(views, 1)
    lastFrame = grow(lastFrame, 1, -1)
  }

  const samples = new Growable(1 << 16)
  const colour = new Float64Array(3)
  const usedFrames: DenseCloudFrame[] = []

  for (let order = 0; order < frameIndexes.length; order += 1) {
    if (o.maxMillis !== undefined && Date.now() - started > o.maxMillis) {
      stats.timedOut = true
      stats.framesSkipped += frameIndexes.length - order
      break
    }
    const frameIndex = frameIndexes[order]!
    const frame = allFrames[frameIndex]!
    const { width, height, intrinsics, pose, depth } = frame
    if (pose.length !== 16 || depth.length < width * height) {
      stats.framesSkipped += 1
      continue
    }
    const slot = usedFrames.length
    usedFrames.push(frame)
    stats.framesUsed += 1
    const confidence =
      frame.confidence && frame.confidence.length >= width * height ? frame.confidence : null
    const image = frame.image ?? null
    const photo = image ? photoIntrinsics(frame, image) : null
    const halfWindow = image ? Math.max(0, Math.floor(image.width / width / 4)) : 0

    const metres = new Float32Array(width * height)
    for (let i = 0; i < metres.length; i += 1) {
      const d = depth[i]! / 1000
      metres[i] = d >= o.minDepthM && d <= o.maxDepthM ? d : 0
    }
    const near = (x: number, y: number, d: number, edge: number, inside: boolean) => {
      if (!inside) return 0
      const value = metres[y * width + x]!
      return value !== 0 && Math.abs(value - d) <= edge ? value : 0
    }
    // ARCore raw depth: X right, Y up, -Z forward, integer pixel indices.
    const px = (x: number, d: number) => ((x - intrinsics.cx) * d) / intrinsics.fx
    const py = (y: number, d: number) => (-(y - intrinsics.cy) * d) / intrinsics.fy

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        const d = metres[i]!
        if (d === 0) continue
        const conf = confidence ? confidence[i]! : 255
        if (conf < o.minConfidence) continue
        const edge = o.edgeFraction * d
        const left = near(x - 1, y, d, edge, x > 0)
        const right = near(x + 1, y, d, edge, x < width - 1)
        const up = near(x, y - 1, d, edge, y > 0)
        const down = near(x, y + 1, d, edge, y < height - 1)
        if ((left === 0 && right === 0) || (up === 0 && down === 0)) continue
        const cx0 = px(x, d)
        const cy0 = py(y, d)
        const cz0 = -d
        const ax = (right !== 0 ? px(x + 1, right) : cx0) - (left !== 0 ? px(x - 1, left) : cx0)
        const ay = (right !== 0 ? py(y, right) : cy0) - (left !== 0 ? py(y, left) : cy0)
        const az = (right !== 0 ? -right : cz0) - (left !== 0 ? -left : cz0)
        const bx = (down !== 0 ? px(x, down) : cx0) - (up !== 0 ? px(x, up) : cx0)
        const by = (down !== 0 ? py(y + 1, down) : cy0) - (up !== 0 ? py(y - 1, up) : cy0)
        const bz = (down !== 0 ? -down : cz0) - (up !== 0 ? -up : cz0)
        // Rows go down the image, so (right - left) x (down - up) points at the camera's -Z side
        // for a wall facing it; the sign is fixed below by the ray to the camera.
        let nx = ay * bz - az * by
        let ny = az * bx - ax * bz
        let nz = ax * by - ay * bx
        const length = Math.hypot(nx, ny, nz)
        if (!(length > 0)) continue
        nx /= length
        ny /= length
        nz /= length
        const rayLength = Math.hypot(cx0, cy0, cz0)
        let cosine = (nx * -cx0 + ny * -cy0 + nz * -cz0) / rayLength
        if (cosine < 0) {
          nx = -nx
          ny = -ny
          nz = -nz
          cosine = -cosine
        }
        if (cosine < o.minViewCosine) continue

        const wx = pose[0]! * cx0 + pose[4]! * cy0 + pose[8]! * cz0 + pose[12]!
        const wy = pose[1]! * cx0 + pose[5]! * cy0 + pose[9]! * cz0 + pose[13]!
        const wz = pose[2]! * cx0 + pose[6]! * cy0 + pose[10]! * cz0 + pose[14]!
        const ix = Math.floor(wx * inverseVoxel) + KEY_OFFSET
        const iy = Math.floor(wy * inverseVoxel) + KEY_OFFSET
        const iz = Math.floor(wz * inverseVoxel) + KEY_OFFSET
        if (ix < 0 || iy < 0 || iz < 0 || ix >= KEY_SPAN || iy >= KEY_SPAN || iz >= KEY_SPAN)
          continue
        const key = (ix * KEY_SPAN + iy) * KEY_SPAN + iz
        let voxel = keyToVoxel.get(key)
        if (voxel === undefined) {
          voxel = keyToVoxel.size
          if (voxel >= capacity) growVoxels()
          keyToVoxel.set(key, voxel)
        }
        const weight = sampleWeight(conf, d, cosine)
        const wnx = pose[0]! * nx + pose[4]! * ny + pose[8]! * nz
        const wny = pose[1]! * nx + pose[5]! * ny + pose[9]! * nz
        const wnz = pose[2]! * nx + pose[6]! * ny + pose[10]! * nz
        sumPos[voxel * 3] = sumPos[voxel * 3]! + wx * weight
        sumPos[voxel * 3 + 1] = sumPos[voxel * 3 + 1]! + wy * weight
        sumPos[voxel * 3 + 2] = sumPos[voxel * 3 + 2]! + wz * weight
        sumNormal[voxel * 3] = sumNormal[voxel * 3]! + wnx * weight
        sumNormal[voxel * 3 + 1] = sumNormal[voxel * 3 + 1]! + wny * weight
        sumNormal[voxel * 3 + 2] = sumNormal[voxel * 3 + 2]! + wnz * weight
        sumWeight[voxel] = sumWeight[voxel]! + weight
        if (lastFrame[voxel] !== slot) {
          lastFrame[voxel] = slot
          views[voxel] = views[voxel]! + 1
        }
        const coloured =
          image && photo && sampleColour(image, photo, cx0, cy0, cz0, halfWindow, colour)
        if (coloured) {
          samples.push(
            voxel,
            slot,
            weight,
            Math.round(colour[0]!),
            Math.round(colour[1]!),
            Math.round(colour[2]!),
          )
        } else {
          // Geometry only; keep the slot's weight out of the colour pass.
          samples.push(voxel, slot, -weight, 0, 0, 0)
        }
        stats.samples += 1
      }
    }
  }

  const voxelCount = keyToVoxel.size
  stats.voxelsBeforeFilter = voxelCount
  const frameCount = usedFrames.length

  // Exposure gains: each frame's brightness against the fused colour of voxels shared with others.
  const gains = new Float64Array(frameCount).fill(1)
  if (o.normaliseExposure !== false && frameCount > 1) {
    const fused = new Float64Array(voxelCount)
    const fusedWeight = new Float64Array(voxelCount)
    for (let iteration = 0; iteration < GAIN_ITERATIONS; iteration += 1) {
      fused.fill(0)
      fusedWeight.fill(0)
      for (let at = 0; at < samples.length; at += 1) {
        const weight = samples.weight(at)
        if (weight <= 0) continue
        const voxel = samples.voxel(at)
        fused[voxel] =
          fused[voxel]! +
          weight *
            gains[samples.frame(at)]! *
            luminance(samples.red(at), samples.green(at), samples.blue(at))
        fusedWeight[voxel] = fusedWeight[voxel]! + weight
      }
      const numerator = new Float64Array(frameCount)
      const denominator = new Float64Array(frameCount)
      for (let at = 0; at < samples.length; at += 1) {
        const weight = samples.weight(at)
        if (weight <= 0) continue
        const voxel = samples.voxel(at)
        if (views[voxel]! < 2 || fusedWeight[voxel]! <= 0) continue
        const slot = samples.frame(at)
        numerator[slot] = numerator[slot]! + weight * (fused[voxel]! / fusedWeight[voxel]!)
        denominator[slot] =
          denominator[slot]! +
          weight * luminance(samples.red(at), samples.green(at), samples.blue(at))
      }
      let logSum = 0
      let logCount = 0
      for (let slot = 0; slot < frameCount; slot += 1) {
        if (denominator[slot]! > 1e-6 && numerator[slot]! > 1e-6) {
          gains[slot] = Math.min(
            GAIN_MAX,
            Math.max(GAIN_MIN, numerator[slot]! / denominator[slot]!),
          )
          logSum += Math.log(gains[slot]!)
          logCount += 1
        }
      }
      // Keep the overall brightness: the mean log gain is zero.
      if (logCount > 0) {
        const mean = Math.exp(logSum / logCount)
        for (let slot = 0; slot < frameCount; slot += 1) gains[slot] = gains[slot]! / mean
      }
    }
  }
  usedFrames.forEach((frame, slot) => {
    stats.gains[frame.id] = Math.round(gains[slot]! * 1000) / 1000
  })

  // Colour per voxel from the gain-corrected samples.
  const colourSum = new Float64Array(voxelCount * 3)
  const colourWeight = new Float64Array(voxelCount)
  for (let at = 0; at < samples.length; at += 1) {
    const weight = samples.weight(at)
    if (weight <= 0) continue
    const voxel = samples.voxel(at)
    const gain = gains[samples.frame(at)]!
    colourSum[voxel * 3] = colourSum[voxel * 3]! + weight * samples.red(at) * gain
    colourSum[voxel * 3 + 1] = colourSum[voxel * 3 + 1]! + weight * samples.green(at) * gain
    colourSum[voxel * 3 + 2] = colourSum[voxel * 3 + 2]! + weight * samples.blue(at) * gain
    colourWeight[voxel] = colourWeight[voxel]! + weight
  }

  // Keep voxels with enough views, then the heaviest up to the cap.
  const kept: number[] = []
  for (let voxel = 0; voxel < voxelCount; voxel += 1) {
    if (views[voxel]! >= o.minViews && sumWeight[voxel]! > 0) kept.push(voxel)
  }
  if (kept.length > o.maxPoints) {
    kept.sort((a, b) => sumWeight[b]! - sumWeight[a]!)
    stats.droppedByCap = kept.length - o.maxPoints
    kept.length = o.maxPoints
    kept.sort((a, b) => a - b)
  }
  const count = kept.length
  stats.voxelsKept = count
  const positions = new Float32Array(count * 3)
  const colors = new Uint8Array(count * 3)
  const normals = new Float32Array(count * 3)
  const weights = new Float32Array(count)
  const viewCounts = new Uint16Array(count)
  kept.forEach((voxel, out) => {
    const weight = sumWeight[voxel]!
    positions[out * 3] = sumPos[voxel * 3]! / weight
    positions[out * 3 + 1] = sumPos[voxel * 3 + 1]! / weight
    positions[out * 3 + 2] = sumPos[voxel * 3 + 2]! / weight
    const nx = sumNormal[voxel * 3]!
    const ny = sumNormal[voxel * 3 + 1]!
    const nz = sumNormal[voxel * 3 + 2]!
    const length = Math.hypot(nx, ny, nz) || 1
    normals[out * 3] = nx / length
    normals[out * 3 + 1] = ny / length
    normals[out * 3 + 2] = nz / length
    weights[out] = weight
    viewCounts[out] = views[voxel]!
    const cw = colourWeight[voxel]!
    if (cw > 0) {
      for (let channel = 0; channel < 3; channel += 1) {
        colors[out * 3 + channel] = Math.min(
          255,
          Math.max(0, Math.round(colourSum[voxel * 3 + channel]! / cw)),
        )
      }
    } else {
      colors.fill(128, out * 3, out * 3 + 3)
      stats.uncoloured += 1
    }
  })
  return { positions, colors, normals, weights, views: viewCounts, count, voxelSize, stats }
}
