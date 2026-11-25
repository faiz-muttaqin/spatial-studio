import { describe, expect, test } from 'bun:test'
import {
  buildBrushDataset,
  buildPointsPly,
  matrixFromRows,
  matrixRows,
  projectToKeyframe,
} from './brush-dataset'
import type { RgbKeyframe } from './streams'

const SHA = 'a'.repeat(64)

/** Column-major camera-to-world: rotation about Y by `yaw`, then translation. */
function poseOf(yaw: number, position: [number, number, number]): number[] {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, ...position, 1]
}

function keyframe(
  id: string,
  pose: number[] | null,
  patch: Partial<RgbKeyframe> = {},
): RgbKeyframe {
  return {
    id,
    timestamp: 0,
    image: { uri: `/api/artifacts/${SHA}`, sha256: SHA },
    width: 192,
    height: 108,
    intrinsics: { fx: 150, fy: 150, cx: 96, cy: 54 },
    pose,
    trackingState: 'tracking',
    ...patch,
  }
}

describe('matrixRows', () => {
  test('writes the column-major pose as rows with the translation in the last column', () => {
    const pose = poseOf(0.4, [1, 2, 3])
    const rows = matrixRows(pose)
    expect(rows[0]![3]).toBe(1)
    expect(rows[1]![3]).toBe(2)
    expect(rows[2]![3]).toBe(3)
    expect(rows[3]).toEqual([0, 0, 0, 1])
    expect(rows[0]![2]).toBeCloseTo(Math.sin(0.4))
    expect(matrixFromRows(rows)).toEqual(pose)
  })
})

describe('buildBrushDataset', () => {
  test('round-trips a known pose and the intrinsics', () => {
    const pose = poseOf(0.7, [0.5, 1.4, -0.25])
    const dataset = buildBrushDataset({
      keyframes: [
        keyframe('kf 1', pose, {
          intrinsics: { fx: 1500, fy: 1498, cx: 960, cy: 540 },
          width: 1920,
          height: 1080,
        }),
      ],
    })
    const [frame] = dataset.transforms.frames
    expect(frame).toMatchObject({
      file_path: 'images/kf_1.jpg',
      fl_x: 1500,
      fl_y: 1498,
      cx: 960,
      cy: 540,
      w: 1920,
      h: 1080,
    })
    expect(matrixFromRows(frame!.transform_matrix)).toEqual(pose)
    expect(dataset.images).toEqual([{ path: 'images/kf_1.jpg', keyframeId: 'kf 1', sha256: SHA }])
    expect(dataset.transforms.camera_model).toBe('PINHOLE')
    expect(dataset.transforms.ply_file_path).toBeUndefined()
  })

  test('skips frames without tracking, pose or intrinsics, and keeps file names unique', () => {
    const pose = poseOf(0, [0, 0, 0])
    const dataset = buildBrushDataset({
      keyframes: [
        keyframe('a b', pose),
        keyframe('a?b', pose),
        keyframe('lost', pose, { trackingState: 'paused' }),
        keyframe('bare', null),
        keyframe('blind', pose, { intrinsics: null }),
        keyframe('nan', [Number.NaN, ...pose.slice(1)]),
      ],
    })
    expect(dataset.images.map((image) => image.path)).toEqual([
      'images/a_b.jpg',
      'images/a_b_2.jpg',
    ])
    expect(dataset.skipped.map((entry) => entry.reason)).toEqual([
      'not-tracking',
      'no-pose',
      'no-intrinsics',
      'not-finite',
    ])
  })

  test('applies the stream frame transform to poses and to the cloud', () => {
    const shift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]
    const dataset = buildBrushDataset({
      keyframes: [keyframe('a', poseOf(0, [1, 0, 0]))],
      keyframeFrame: shift,
      cloud: { positions: [0, 0, 0], colors: [1, 0.5, 0] },
      cloudFrame: shift,
    })
    expect(dataset.transforms.frames[0]!.transform_matrix[0]![3]).toBe(11)
    expect(dataset.transforms.ply_file_path).toBe('points.ply')
    const view = new DataView(dataset.pointsPly!.buffer)
    const headerLength = new TextDecoder().decode(dataset.pointsPly!).indexOf('end_header\n') + 11
    expect(view.getFloat32(headerLength, true)).toBe(10)
    expect([...dataset.pointsPly!.slice(headerLength + 12, headerLength + 15)]).toEqual([
      255, 128, 0,
    ])
  })
})

describe('buildPointsPly', () => {
  test('writes a binary PLY, drops non-finite points and reads byte colours', () => {
    const ply = buildPointsPly({
      positions: [0, 0, 0, Number.NaN, 0, 0, 1, 2, 3],
      colors: [10, 20, 30, 0, 0, 0, 200, 100, 0],
    })!
    const text = new TextDecoder().decode(ply.bytes.slice(0, 200))
    expect(text).toContain('element vertex 2')
    expect(text).toContain('format binary_little_endian 1.0')
    expect(ply.count).toBe(2)
    expect(ply.bytes.length).toBe(text.indexOf('end_header\n') + 11 + 2 * 15)
    const tail = ply.bytes.slice(-3)
    expect([...tail]).toEqual([200, 100, 0])
  })

  test('returns null for an empty cloud', () => {
    expect(buildPointsPly({ positions: [] })).toBeNull()
  })
})

describe('projectToKeyframe reprojection', () => {
  const width = 192
  const height = 108
  const intrinsics = { fx: 150, fy: 150, cx: 96, cy: 54 }
  const pose = poseOf(0.5, [0.4, 1.2, 0.3])

  /** Paints a vertical rectangle of a plane by casting a ray for every pixel, independent of the projection under test. */
  function render(
    rectangle: { centre: [number, number, number]; halfU: number; halfV: number },
    plane: {
      normal: [number, number, number]
      right: [number, number, number]
      up: [number, number, number]
    },
  ): Uint8Array {
    const image = new Uint8Array(width * height)
    const origin = [pose[12]!, pose[13]!, pose[14]!]
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const cx = (column + 0.5 - intrinsics.cx) / intrinsics.fx
        const cy = -(row + 0.5 - intrinsics.cy) / intrinsics.fy
        const dir = [0, 1, 2].map(
          (axis) => pose[axis]! * cx + pose[4 + axis]! * cy + pose[8 + axis]! * -1,
        )
        const denominator =
          dir[0]! * plane.normal[0] + dir[1]! * plane.normal[1] + dir[2]! * plane.normal[2]
        if (Math.abs(denominator) < 1e-9) continue
        const t =
          ((rectangle.centre[0] - origin[0]!) * plane.normal[0] +
            (rectangle.centre[1] - origin[1]!) * plane.normal[1] +
            (rectangle.centre[2] - origin[2]!) * plane.normal[2]) /
          denominator
        if (t <= 0) continue
        const hit = [0, 1, 2].map(
          (axis) => origin[axis]! + dir[axis]! * t - rectangle.centre[axis]!,
        )
        const a = hit[0]! * plane.right[0] + hit[1]! * plane.right[1] + hit[2]! * plane.right[2]
        const b = hit[0]! * plane.up[0] + hit[1]! * plane.up[1] + hit[2]! * plane.up[2]
        if (Math.abs(a) <= rectangle.halfU && Math.abs(b) <= rectangle.halfV) {
          image[row * width + column] = 255
        }
      }
    }
    return image
  }

  // A wall facing +Z at z = -3, seen from a camera turned 0.5 rad and shifted.
  const plane = {
    normal: [0, 0, 1] as [number, number, number],
    right: [1, 0, 0] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
  }
  const rectangle = { centre: [0, 1.2, -3] as [number, number, number], halfU: 0.6, halfV: 0.4 }
  const image = render(rectangle, plane)

  test('the rectangle is visible, so the check is not vacuous', () => {
    const lit = image.reduce((sum, value) => sum + (value === 255 ? 1 : 0), 0)
    expect(lit).toBeGreaterThan(500)
  })

  test('cloud points on the rectangle land on bright pixels, points off it on dark ones', () => {
    let inside = 0
    let bright = 0
    for (let i = 0; i <= 10; i += 1) {
      for (let j = 0; j <= 10; j += 1) {
        // Stay 5 per cent inside the edge so pixel rounding cannot flip the result.
        const point: [number, number, number] = [
          rectangle.centre[0] + (i / 5 - 1) * rectangle.halfU * 0.95,
          rectangle.centre[1] + (j / 5 - 1) * rectangle.halfV * 0.95,
          rectangle.centre[2],
        ]
        const hit = projectToKeyframe(point, pose, intrinsics, width, height)
        if (!hit) continue
        inside += 1
        if (image[Math.floor(hit.v) * width + Math.floor(hit.u)] === 255) bright += 1
      }
    }
    expect(inside).toBeGreaterThan(60)
    expect(bright).toBe(inside)

    const off = projectToKeyframe([0, 1.2, -3] as const, pose, intrinsics, width, height)
    expect(off).not.toBeNull()
    const outside = projectToKeyframe([1.6, 1.2, -3], pose, intrinsics, width, height)
    if (outside) expect(image[Math.floor(outside.v) * width + Math.floor(outside.u)]).toBe(0)
  })

  test('a point behind the camera does not project', () => {
    expect(projectToKeyframe([0, 1.2, 5], pose, intrinsics, width, height)).toBeNull()
  })

  test('a point on the optical axis lands on the principal point', () => {
    const forward = [-pose[8]!, -pose[9]!, -pose[10]!]
    const point: [number, number, number] = [
      pose[12]! + forward[0]! * 2,
      pose[13]! + forward[1]! * 2,
      pose[14]! + forward[2]! * 2,
    ]
    const hit = projectToKeyframe(point, pose, intrinsics, width, height)!
    expect(hit.u).toBeCloseTo(96)
    expect(hit.v).toBeCloseTo(54)
    expect(hit.depth).toBeCloseTo(2)
  })
})
