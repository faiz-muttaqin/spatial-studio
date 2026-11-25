import { multiplyMatrix4 } from './frames'
import type { CameraIntrinsics, RgbKeyframe } from './streams'

/**
 * Brush dataset export (ROADMAP R6): a scan bundle as the nerfstudio `transforms.json` Brush
 * trains from (`crates/brush-dataset/src/formats/nerfstudio.rs`, commit `d43bd1e6b232`), plus an
 * initial `points.ply`. Poses are the bundle's own: column-major OpenGL camera-to-world matrices
 * in the capture world (ARCore, Y up, metres), written as the four rows nerfstudio expects. Brush
 * reads `transform_matrix` as row-major camera-to-world with OpenGL axes (+X right, +Y up, -Z
 * forward), the same convention as the bundle, so no axis flip is applied here.
 */

export const BRUSH_IMAGE_DIR = 'images'
export const BRUSH_TRANSFORMS_FILE = 'transforms.json'
export const BRUSH_POINTS_FILE = 'points.ply'

export type BrushFrame = {
  file_path: string
  transform_matrix: number[][]
  fl_x: number
  fl_y: number
  cx: number
  cy: number
  w: number
  h: number
}

export type BrushTransforms = {
  camera_model: 'PINHOLE'
  ply_file_path?: string
  frames: BrushFrame[]
}

export type BrushCloudInput = {
  /** xyz per point, in the cloud's own frame. */
  positions: ArrayLike<number>
  /** rgb per point: 0..1 floats, or 0..255 when any value is above 1. Grey when absent. */
  colors?: ArrayLike<number> | null
}

export type BrushDatasetInput = {
  keyframes: readonly RgbKeyframe[]
  /** The rgb-keyframes stream's frame transform into the capture world, when it has one. */
  keyframeFrame?: readonly number[] | null
  cloud?: BrushCloudInput | null
  /** The cloud stream's frame transform into the capture world, when it has one. */
  cloudFrame?: readonly number[] | null
}

export type BrushImage = {
  /** Path inside the zip, `images/<name>.jpg`. */
  path: string
  keyframeId: string
  sha256: string
}

export type BrushSkippedFrame = {
  keyframeId: string
  reason: 'not-tracking' | 'no-pose' | 'no-intrinsics' | 'not-finite'
}

export type BrushDataset = {
  transforms: BrushTransforms
  images: BrushImage[]
  /** Binary little-endian PLY, or null when no point has a finite position. */
  pointsPly: Uint8Array | null
  pointCount: number
  skipped: BrushSkippedFrame[]
}

/** The four rows of a column-major 4x4: row `r` is elements `r`, `r + 4`, `r + 8`, `r + 12`. */
export function matrixRows(matrix: readonly number[]): number[][] {
  return [0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((column) => matrix[column * 4 + row]!))
}

/** The inverse of {@link matrixRows}: four rows back to a column-major 16-array. */
export function matrixFromRows(rows: readonly (readonly number[])[]): number[] {
  const out = new Array<number>(16)
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) out[column * 4 + row] = rows[row]![column]!
  }
  return out
}

function safeFileStem(id: string): string {
  const stem = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return stem.length > 0 ? stem : 'frame'
}

/** Builds the transforms, the image list and the initial point cloud of a Brush dataset. */
export function buildBrushDataset(input: BrushDatasetInput): BrushDataset {
  const frames: BrushFrame[] = []
  const images: BrushImage[] = []
  const skipped: BrushSkippedFrame[] = []
  const usedNames = new Set<string>()

  for (const keyframe of input.keyframes) {
    if (keyframe.trackingState !== 'tracking') {
      skipped.push({ keyframeId: keyframe.id, reason: 'not-tracking' })
      continue
    }
    if (!keyframe.pose) {
      skipped.push({ keyframeId: keyframe.id, reason: 'no-pose' })
      continue
    }
    if (!keyframe.intrinsics) {
      skipped.push({ keyframeId: keyframe.id, reason: 'no-intrinsics' })
      continue
    }
    const pose = input.keyframeFrame
      ? multiplyMatrix4(input.keyframeFrame, keyframe.pose)
      : keyframe.pose
    if (!pose.every(Number.isFinite)) {
      skipped.push({ keyframeId: keyframe.id, reason: 'not-finite' })
      continue
    }
    let stem = safeFileStem(keyframe.id)
    for (let suffix = 2; usedNames.has(stem); suffix += 1)
      stem = `${safeFileStem(keyframe.id)}_${suffix}`
    usedNames.add(stem)
    const path = `${BRUSH_IMAGE_DIR}/${stem}.jpg`
    const { fx, fy, cx, cy } = keyframe.intrinsics
    frames.push({
      file_path: path,
      transform_matrix: matrixRows(pose),
      fl_x: fx,
      fl_y: fy,
      cx,
      cy,
      w: keyframe.width,
      h: keyframe.height,
    })
    images.push({ path, keyframeId: keyframe.id, sha256: keyframe.image.sha256 })
  }

  const cloud = input.cloud ? buildPointsPly(input.cloud, input.cloudFrame ?? null) : null
  const transforms: BrushTransforms = {
    camera_model: 'PINHOLE',
    ...(cloud ? { ply_file_path: BRUSH_POINTS_FILE } : {}),
    frames,
  }
  return {
    transforms,
    images,
    pointsPly: cloud?.bytes ?? null,
    pointCount: cloud?.count ?? 0,
    skipped,
  }
}

const PLY_VERTEX_BYTES = 15

/** A binary little-endian PLY with `x y z` floats and `red green blue` bytes per vertex. */
export function buildPointsPly(
  cloud: BrushCloudInput,
  frame: readonly number[] | null = null,
): { bytes: Uint8Array; count: number } | null {
  const total = Math.floor(cloud.positions.length / 3)
  const colours = cloud.colors && cloud.colors.length >= total * 3 ? cloud.colors : null
  let scale = 255
  if (colours) {
    let max = 0
    for (let index = 0; index < total * 3; index += 1) max = Math.max(max, colours[index]!)
    scale = max > 1 ? 1 : 255
  }
  const vertices = new Uint8Array(total * PLY_VERTEX_BYTES)
  const view = new DataView(vertices.buffer)
  let count = 0
  for (let index = 0; index < total; index += 1) {
    let x = cloud.positions[index * 3]!
    let y = cloud.positions[index * 3 + 1]!
    let z = cloud.positions[index * 3 + 2]!
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue
    if (frame) {
      const wx = frame[0]! * x + frame[4]! * y + frame[8]! * z + frame[12]!
      const wy = frame[1]! * x + frame[5]! * y + frame[9]! * z + frame[13]!
      const wz = frame[2]! * x + frame[6]! * y + frame[10]! * z + frame[14]!
      x = wx
      y = wy
      z = wz
    }
    const at = count * PLY_VERTEX_BYTES
    view.setFloat32(at, x, true)
    view.setFloat32(at + 4, y, true)
    view.setFloat32(at + 8, z, true)
    for (let channel = 0; channel < 3; channel += 1) {
      const value = colours ? colours[index * 3 + channel]! * scale : 128
      vertices[at + 12 + channel] = Math.min(255, Math.max(0, Math.round(value)))
    }
    count += 1
  }
  if (count === 0) return null
  const header = new TextEncoder().encode(
    [
      'ply',
      'format binary_little_endian 1.0',
      `element vertex ${count}`,
      'property float x',
      'property float y',
      'property float z',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'end_header',
      '',
    ].join('\n'),
  )
  const bytes = new Uint8Array(header.length + count * PLY_VERTEX_BYTES)
  bytes.set(header, 0)
  bytes.set(vertices.subarray(0, count * PLY_VERTEX_BYTES), header.length)
  return { bytes, count }
}

/**
 * The pixel a capture-world point lands on in a keyframe: the point goes through the inverse of
 * the camera-to-world pose into OpenGL camera axes, then `u = cx + fx x / -z` and
 * `v = cy - fy y / -z` (image rows run down). Null when the point is behind the camera or off
 * the image.
 */
export function projectToKeyframe(
  point: readonly [number, number, number],
  pose: readonly number[],
  intrinsics: CameraIntrinsics,
  width: number,
  height: number,
): { u: number; v: number; depth: number } | null {
  const dx = point[0] - pose[12]!
  const dy = point[1] - pose[13]!
  const dz = point[2] - pose[14]!
  // The rotation block is orthonormal, so its transpose is its inverse.
  const x = pose[0]! * dx + pose[1]! * dy + pose[2]! * dz
  const y = pose[4]! * dx + pose[5]! * dy + pose[6]! * dz
  const z = pose[8]! * dx + pose[9]! * dy + pose[10]! * dz
  if (z >= 0) return null
  const u = intrinsics.cx + (intrinsics.fx * x) / -z
  const v = intrinsics.cy - (intrinsics.fy * y) / -z
  if (u < 0 || v < 0 || u >= width || v >= height) return null
  return { u, v, depth: -z }
}
