/**
 * Page side of the live preview stream (SENSING_RESEARCH.md, P2N.3). The companion sends one binary frame
 * per message; this module checks and decodes it. The stream is a preview only: the recorded bundle stays
 * the source of truth, and a frame that fails any check is dropped, never repaired.
 *
 * Wire format, little endian, 24 byte header: magic `SSL1` (4), type u8, flags u8, reserved u16 (zero),
 * seq u32, timestampNs i64, payloadLength u32; then the payload. The Kotlin encoder is
 * `apps/android/.../live/LiveFrames.kt`; keep the two in step.
 */

export const LIVE_HEADER_BYTES = 24
export const LIVE_MAX_PAYLOAD_BYTES = 128 * 1024
export const LIVE_MAX_FRAME_BYTES = LIVE_HEADER_BYTES + LIVE_MAX_PAYLOAD_BYTES
export const LIVE_MAX_DEPTH_PIXELS = 40_000
export const LIVE_MAX_COVERAGE_CELLS = 8_192
export const LIVE_MAX_PLANES = 32

const FLAG_HAS_CONFIDENCE = 1
const DEPTH_FIXED_BYTES = 4 + 16 + 64
const POSE_BYTES = 64 + 4
const PLANE_BYTES = 64 + 8 + 4

export type LiveTracking = 'none' | 'tracking' | 'paused' | 'stopped'
export type LivePlaneOrientation = 'other' | 'horizontal-up' | 'horizontal-down' | 'vertical'

type Common = {
  seq: number
  /** Sender clock, nanoseconds. Only differences between frames are meaningful. */
  timestampNs: number
}

export type LiveDepthFrame = Common & {
  type: 'depth'
  width: number
  height: number
  /** Depth pixels. */
  intrinsics: { fx: number; fy: number; cx: number; cy: number }
  /** Column-major camera-to-world, capture world. */
  pose: number[]
  /** Millimetres, row-major; 0 means no measurement. */
  depth: Uint16Array
  confidence: Uint8Array | null
}

export type LivePoseFrame = Common & {
  type: 'pose'
  pose: number[]
  tracking: LiveTracking
}

export type LiveCoverageFrame = Common & {
  type: 'coverage'
  cellMetres: number
  floorY: number | null
  /** Covered share of the known floor, 0 to 100, or null. */
  percent: number | null
  /** `cx, cz` pairs in `cellMetres` units. The phone coarsens the grid, doubling the cell, past the cap. */
  cells: Int32Array
}

export type LivePlane = {
  orientation: LivePlaneOrientation
  centerPose: number[]
  extentX: number
  extentZ: number
}

export type LivePlanesFrame = Common & { type: 'planes'; planes: LivePlane[] }

export type LiveFrame = LiveDepthFrame | LivePoseFrame | LiveCoverageFrame | LivePlanesFrame

const TRACKING: LiveTracking[] = ['none', 'tracking', 'paused', 'stopped']
const ORIENTATION: LivePlaneOrientation[] = [
  'other',
  'horizontal-up',
  'horizontal-down',
  'vertical',
]

function floats(view: DataView, offset: number, count: number): number[] | null {
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const value = view.getFloat32(offset + i * 4, true)
    if (!Number.isFinite(value)) return null
    out.push(value)
  }
  return out
}

/** Decodes one stream message; null when it is not a well-formed frame within the bounds. */
export function parseLiveFrame(data: unknown): LiveFrame | null {
  if (!(data instanceof ArrayBuffer)) return null
  const size = data.byteLength
  if (size < LIVE_HEADER_BYTES || size > LIVE_MAX_FRAME_BYTES) return null
  const view = new DataView(data)
  if (
    view.getUint8(0) !== 0x53 ||
    view.getUint8(1) !== 0x53 ||
    view.getUint8(2) !== 0x4c ||
    view.getUint8(3) !== 0x31
  ) {
    return null
  }
  const type = view.getUint8(4)
  const flags = view.getUint8(5)
  if (view.getUint16(6, true) !== 0) return null
  const seq = view.getUint32(8, true)
  const timestampNs = view.getUint32(12, true) + view.getInt32(16, true) * 4294967296
  if (view.getUint32(20, true) !== size - LIVE_HEADER_BYTES) return null
  const base = LIVE_HEADER_BYTES
  const payload = size - base
  const common = { seq, timestampNs }

  switch (type) {
    case 1: {
      if (payload < DEPTH_FIXED_BYTES) return null
      const width = view.getUint16(base, true)
      const height = view.getUint16(base + 2, true)
      const pixels = width * height
      if (width < 1 || height < 1 || pixels > LIVE_MAX_DEPTH_PIXELS) return null
      const withConfidence = (flags & FLAG_HAS_CONFIDENCE) !== 0
      if (payload !== DEPTH_FIXED_BYTES + pixels * 2 + (withConfidence ? pixels : 0)) return null
      const k = floats(view, base + 4, 4)
      const pose = floats(view, base + 20, 16)
      if (!k || !pose) return null
      const depthStart = base + DEPTH_FIXED_BYTES
      return {
        ...common,
        type: 'depth',
        width,
        height,
        intrinsics: { fx: k[0]!, fy: k[1]!, cx: k[2]!, cy: k[3]! },
        pose,
        // Copied: the view into the message would need a 2 byte aligned offset, and a copy lets the buffer go.
        depth: new Uint16Array(data.slice(depthStart, depthStart + pixels * 2)),
        confidence: withConfidence
          ? new Uint8Array(data.slice(depthStart + pixels * 2, depthStart + pixels * 3))
          : null,
      }
    }
    case 2: {
      if (payload !== POSE_BYTES) return null
      const pose = floats(view, base, 16)
      const tracking = TRACKING[view.getUint8(base + 64)]
      if (!pose || !tracking) return null
      return { ...common, type: 'pose', pose, tracking }
    }
    case 3: {
      if (payload < 12) return null
      const count = view.getUint16(base + 10, true)
      if (count > LIVE_MAX_COVERAGE_CELLS || payload !== 12 + count * 8) return null
      const cellMetres = view.getFloat32(base, true)
      const floorY = view.getFloat32(base + 4, true)
      const percent = view.getInt16(base + 8, true)
      if (!(cellMetres > 0 && cellMetres < 10)) return null
      const cells = new Int32Array(count * 2)
      for (let i = 0; i < count * 2; i += 1) cells[i] = view.getInt32(base + 12 + i * 4, true)
      return {
        ...common,
        type: 'coverage',
        cellMetres,
        floorY: Number.isFinite(floorY) ? floorY : null,
        percent: percent >= 0 && percent <= 100 ? percent : null,
        cells,
      }
    }
    case 4: {
      if (payload < 4) return null
      const count = view.getUint8(base)
      if (count > LIVE_MAX_PLANES || payload !== 4 + count * PLANE_BYTES) return null
      const planes: LivePlane[] = []
      for (let i = 0; i < count; i += 1) {
        const at = base + 4 + i * PLANE_BYTES
        const centerPose = floats(view, at, 16)
        const extent = floats(view, at + 64, 2)
        const orientation = ORIENTATION[view.getUint8(at + 72)]
        if (!centerPose || !extent || !orientation) return null
        planes.push({ orientation, centerPose, extentX: extent[0]!, extentZ: extent[1]! })
      }
      return { ...common, type: 'planes', planes }
    }
    default:
      return null
  }
}
