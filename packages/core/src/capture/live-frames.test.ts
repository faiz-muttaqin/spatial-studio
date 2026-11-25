import { describe, expect, it } from 'bun:test'
import {
  LIVE_HEADER_BYTES,
  LIVE_MAX_COVERAGE_CELLS,
  LIVE_MAX_FRAME_BYTES,
  parseLiveFrame,
} from './live-frames'

// Frames are built byte by byte, the way `LiveFrames.kt` writes them.

function frame(type: number, flags: number, seq: number, ts: number, payload: number): DataView {
  const buffer = new ArrayBuffer(LIVE_HEADER_BYTES + payload)
  const view = new DataView(buffer)
  view.setUint8(0, 0x53)
  view.setUint8(1, 0x53)
  view.setUint8(2, 0x4c)
  view.setUint8(3, 0x31)
  view.setUint8(4, type)
  view.setUint8(5, flags)
  view.setUint32(8, seq, true)
  view.setUint32(12, ts % 4294967296, true)
  view.setInt32(16, Math.floor(ts / 4294967296), true)
  view.setUint32(20, payload, true)
  return view
}

const POSE = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0))

function depthFrame(width: number, height: number, withConfidence: boolean): ArrayBuffer {
  const pixels = width * height
  const view = frame(
    1,
    withConfidence ? 1 : 0,
    5,
    1_700_000_000_123_000_000,
    84 + pixels * 2 + (withConfidence ? pixels : 0),
  )
  let at = LIVE_HEADER_BYTES
  view.setUint16(at, width, true)
  view.setUint16(at + 2, height, true)
  ;[120, 121, 80, 45].forEach((value, i) => {
    view.setFloat32(at + 4 + i * 4, value, true)
  })
  POSE.forEach((value, i) => {
    view.setFloat32(at + 20 + i * 4, value, true)
  })
  at += 84
  for (let i = 0; i < pixels; i += 1) view.setUint16(at + i * 2, 1000 + i, true)
  if (withConfidence)
    for (let i = 0; i < pixels; i += 1) view.setUint8(at + pixels * 2 + i, i % 256)
  return view.buffer as ArrayBuffer
}

describe('parseLiveFrame', () => {
  it('decodes the 160 x 90 depth frame the phone sends, 43,284 byte payload', () => {
    const buffer = depthFrame(160, 90, true)
    expect(buffer.byteLength).toBe(LIVE_HEADER_BYTES + 43_284)
    const parsed = parseLiveFrame(buffer)
    expect(parsed?.type).toBe('depth')
    if (parsed?.type !== 'depth') return
    expect(parsed.seq).toBe(5)
    expect(parsed.timestampNs).toBe(1_700_000_000_123_000_000)
    expect(parsed.intrinsics).toEqual({ fx: 120, fy: 121, cx: 80, cy: 45 })
    expect(parsed.depth.length).toBe(14_400)
    expect(parsed.depth[3]).toBe(1003)
    expect(parsed.confidence?.[300]).toBe(300 % 256)
    expect(parsed.pose[5]).toBe(1)
  })

  it('decodes depth without confidence', () => {
    const parsed = parseLiveFrame(depthFrame(4, 3, false))
    expect(parsed?.type === 'depth' && parsed.confidence).toBeNull()
  })

  it('rejects depth that is too large, empty or the wrong size', () => {
    expect(parseLiveFrame(depthFrame(201, 200, false))).toBeNull()
    const view = new DataView(depthFrame(4, 3, true))
    view.setUint16(LIVE_HEADER_BYTES, 5, true)
    expect(parseLiveFrame(view.buffer as ArrayBuffer)).toBeNull()
    view.setUint16(LIVE_HEADER_BYTES, 0, true)
    expect(parseLiveFrame(view.buffer as ArrayBuffer)).toBeNull()
  })

  it('decodes pose and rejects an unknown tracking code', () => {
    const view = frame(2, 0, 1, 10, 68)
    POSE.forEach((value, i) => {
      view.setFloat32(LIVE_HEADER_BYTES + i * 4, value, true)
    })
    view.setUint8(LIVE_HEADER_BYTES + 64, 2)
    expect(parseLiveFrame(view.buffer as ArrayBuffer)).toMatchObject({
      type: 'pose',
      tracking: 'paused',
    })
    view.setUint8(LIVE_HEADER_BYTES + 64, 9)
    expect(parseLiveFrame(view.buffer as ArrayBuffer)).toBeNull()
  })

  it('rejects non-finite floats', () => {
    const view = frame(2, 0, 1, 10, 68)
    view.setFloat32(LIVE_HEADER_BYTES + 8, Number.NaN, true)
    expect(parseLiveFrame(view.buffer as ArrayBuffer)).toBeNull()
  })

  it('decodes coverage cells, NaN floor and unknown percent', () => {
    const view = frame(3, 0, 2, 0, 12 + 16)
    const at = LIVE_HEADER_BYTES
    view.setFloat32(at, 0.25, true)
    view.setFloat32(at + 4, Number.NaN, true)
    view.setInt16(at + 8, -1, true)
    view.setUint16(at + 10, 2, true)
    ;[1, -1, 2, 5].forEach((value, i) => {
      view.setInt32(at + 12 + i * 4, value, true)
    })
    const parsed = parseLiveFrame(view.buffer as ArrayBuffer)
    expect(parsed).toMatchObject({
      type: 'coverage',
      cellMetres: 0.25,
      floorY: null,
      percent: null,
    })
    expect(parsed?.type === 'coverage' && Array.from(parsed.cells)).toEqual([1, -1, 2, 5])
  })

  it('rejects a coverage count past the bound or not matching the payload', () => {
    const count = LIVE_MAX_COVERAGE_CELLS + 1
    const view = frame(3, 0, 2, 0, 12 + count * 8)
    view.setFloat32(LIVE_HEADER_BYTES, 0.25, true)
    view.setUint16(LIVE_HEADER_BYTES + 10, count, true)
    expect(parseLiveFrame(view.buffer as ArrayBuffer)).toBeNull()
    const short = frame(3, 0, 2, 0, 12 + 8)
    short.setFloat32(LIVE_HEADER_BYTES, 0.25, true)
    short.setUint16(LIVE_HEADER_BYTES + 10, 3, true)
    expect(parseLiveFrame(short.buffer as ArrayBuffer)).toBeNull()
  })

  it('decodes planes and rejects more than the bound', () => {
    const view = frame(4, 0, 3, 0, 4 + 76)
    view.setUint8(LIVE_HEADER_BYTES, 1)
    const at = LIVE_HEADER_BYTES + 4
    POSE.forEach((value, i) => {
      view.setFloat32(at + i * 4, value, true)
    })
    view.setFloat32(at + 64, 2, true)
    view.setFloat32(at + 68, 3, true)
    view.setUint8(at + 72, 3)
    expect(parseLiveFrame(view.buffer as ArrayBuffer)).toMatchObject({
      type: 'planes',
      planes: [{ orientation: 'vertical', extentX: 2, extentZ: 3 }],
    })
    const many = frame(4, 0, 3, 0, 4 + 33 * 76)
    many.setUint8(LIVE_HEADER_BYTES, 33)
    expect(parseLiveFrame(many.buffer as ArrayBuffer)).toBeNull()
  })

  it('rejects malformed headers and non-buffers', () => {
    const good = frame(2, 0, 1, 10, 68)
    POSE.forEach((value, i) => {
      good.setFloat32(LIVE_HEADER_BYTES + i * 4, value, true)
    })
    const copy = (mutate: (v: DataView) => void) => {
      const v = new DataView(good.buffer.slice(0) as ArrayBuffer)
      mutate(v)
      return v.buffer as ArrayBuffer
    }
    expect(parseLiveFrame(good.buffer)).not.toBeNull()
    expect(parseLiveFrame(copy((v) => v.setUint8(0, 0x58)))).toBeNull()
    expect(parseLiveFrame(copy((v) => v.setUint8(4, 9)))).toBeNull()
    expect(parseLiveFrame(copy((v) => v.setUint16(6, 1, true)))).toBeNull()
    expect(parseLiveFrame(copy((v) => v.setUint32(20, 67, true)))).toBeNull()
    expect(parseLiveFrame(good.buffer.slice(0, 10))).toBeNull()
    expect(parseLiveFrame(new ArrayBuffer(LIVE_MAX_FRAME_BYTES + 1))).toBeNull()
    expect(parseLiveFrame('{"json":true}')).toBeNull()
    expect(parseLiveFrame(new Uint8Array(40))).toBeNull()
    expect(parseLiveFrame(null)).toBeNull()
  })
})
