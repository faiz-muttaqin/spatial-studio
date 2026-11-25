import { describe, expect, it } from 'bun:test'
import type { LiveDepthFrame } from '@pascal-app/core/capture'
import { LivePreviewState } from './live-preview'

// Synthetic depth only: a ray caster over a 4 m by 3 m box room, camera in the middle.
const ROOM = { x: 4, z: 3, height: 2.5 }
const WIDTH = 160
const HEIGHT = 90
const K = { fx: 105, fy: 105, cx: 80, cy: 45 }
const CAMERA_Y = 1.4

function pose(x: number, z: number, yaw: number): number[] {
  const forward = [Math.cos(yaw), 0, Math.sin(yaw)]
  const right = [-Math.sin(yaw), 0, Math.cos(yaw)]
  return [...right, 0, 0, 1, 0, 0, -forward[0]!, 0, -forward[2]!, 0, x, CAMERA_Y, z, 1]
}

function depthFrame(seq: number, x: number, z: number, yaw: number): LiveDepthFrame {
  const m = pose(x, z, yaw)
  const depth = new Uint16Array(WIDTH * HEIGHT)
  for (let v = 0; v < HEIGHT; v += 1) {
    for (let u = 0; u < WIDTH; u += 1) {
      const cam = [(u - K.cx) / K.fx, (K.cy - v) / K.fy, -1]
      const d = [
        m[0]! * cam[0]! + m[4]! * cam[1]! + m[8]! * cam[2]!,
        m[1]! * cam[0]! + m[5]! * cam[1]! + m[9]! * cam[2]!,
        m[2]! * cam[0]! + m[6]! * cam[1]! + m[10]! * cam[2]!,
      ]
      let t = Number.POSITIVE_INFINITY
      const hit = (value: number) => {
        if (value > 1e-6 && value < t) t = value
      }
      if (d[0]! > 0) hit((ROOM.x - x) / d[0]!)
      if (d[0]! < 0) hit((0 - x) / d[0]!)
      if (d[2]! > 0) hit((ROOM.z - z) / d[2]!)
      if (d[2]! < 0) hit((0 - z) / d[2]!)
      if (d[1]! > 0) hit((ROOM.height - CAMERA_Y) / d[1]!)
      if (d[1]! < 0) hit((0 - CAMERA_Y) / d[1]!)
      depth[v * WIDTH + u] = Math.round(t * 1000)
    }
  }
  return {
    type: 'depth',
    seq,
    timestampNs: seq * 200_000_000,
    width: WIDTH,
    height: HEIGHT,
    intrinsics: K,
    pose: m,
    depth,
    confidence: new Uint8Array(WIDTH * HEIGHT).fill(255),
  }
}

function area(polygon: Array<[number, number]>): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, z1] = polygon[i]!
    const [x2, z2] = polygon[(i + 1) % polygon.length]!
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

describe('LivePreviewState', () => {
  it('draws no outline before it has enough depth frames', () => {
    const state = new LivePreviewState()
    state.ingest(depthFrame(0, 2, 1.5, 0))
    expect(state.needsCarve).toBe(false)
    expect(state.snapshot().outline).toBeNull()
  })

  it('carves the room outline from streamed depth while the phone walks a loop', () => {
    const state = new LivePreviewState()
    // Free space is carved around where the phone walked, so the test walks an ellipse and looks about.
    for (let i = 0; i < 24; i += 1) {
      const theta = (i * 2 * Math.PI) / 24
      const x = 2 + 1.2 * Math.cos(theta)
      const z = 1.5 + 0.7 * Math.sin(theta)
      state.ingest({
        type: 'pose',
        seq: 1000 + i,
        timestampNs: 0,
        pose: pose(x, z, 0),
        tracking: 'tracking',
      })
      state.ingest(depthFrame(i, x, z, theta + Math.PI + ((i % 3) - 1) * 0.8))
    }
    expect(state.needsCarve).toBe(true)
    const outline = state.carve()
    expect(state.needsCarve).toBe(false)
    expect(outline.polygon).not.toBeNull()
    const polygon = state.snapshot().outline!
    // 4 x 3 = 12 m2, within what the carving's 5 cm grid and edge squaring give.
    expect(area(polygon)).toBeGreaterThan(10)
    expect(area(polygon)).toBeLessThan(14)
  })

  it('keeps the ring bounded and skips frames that add nothing', () => {
    const state = new LivePreviewState()
    for (let i = 0; i < 100; i += 1) state.ingest(depthFrame(i, 2, 1.5, 0))
    expect(state.snapshot().ringSize).toBe(1)
    for (let i = 0; i < 100; i += 1) state.ingest(depthFrame(1000 + i, 2, 1.5, i * 0.3))
    expect(state.snapshot().ringSize).toBeLessThanOrEqual(24)
    expect(state.snapshot().depthFrames).toBe(200)
  })

  it('follows pose, tracking and coverage frames', () => {
    const state = new LivePreviewState()
    state.ingest({
      type: 'pose',
      seq: 1,
      timestampNs: 0,
      pose: pose(1, 2, 0),
      tracking: 'tracking',
    })
    state.ingest({ type: 'pose', seq: 2, timestampNs: 0, pose: pose(9, 9, 0), tracking: 'paused' })
    state.ingest({
      type: 'coverage',
      seq: 3,
      timestampNs: 0,
      cellMetres: 0.25,
      floorY: 0,
      percent: 42,
      cells: Int32Array.from([0, 0, 1, 0]),
    })
    const snap = state.snapshot()
    expect(snap.camera).toMatchObject({ x: 1, z: 2 })
    expect(snap.camera?.headingX).toBeCloseTo(1)
    expect(snap.tracking).toBe('paused')
    expect(snap.coverage).toMatchObject({ cellMetres: 0.25, percent: 42 })
    state.reset()
    expect(state.snapshot().camera).toBeNull()
  })
})
