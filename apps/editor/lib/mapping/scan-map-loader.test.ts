import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { sameOriginUrl } from '../capture/source-resolver'
import {
  type LoaderDeps,
  loadScanMap,
  MapCancelled,
  MapRefusal,
  northInLevel,
  type PhotoDecoder,
} from './scan-map-loader'

// A box room (x -2..2, z -1.5..1.5, y 0..2.5) ray-cast into raw depth frames. Photos are faked by
// the decoder, so the worker logic is tested without a browser.

function cast(o: number[], d: number[]): number | null {
  let best: number | null = null
  const consider = (t: number) => {
    if (t > 1e-6 && (best === null || t < best)) best = t
  }
  if (d[0]! > 1e-9) consider((2 - o[0]!) / d[0]!)
  if (d[0]! < -1e-9) consider((-2 - o[0]!) / d[0]!)
  if (d[2]! > 1e-9) consider((1.5 - o[2]!) / d[2]!)
  if (d[2]! < -1e-9) consider((-1.5 - o[2]!) / d[2]!)
  if (d[1]! > 1e-9) consider((2.5 - o[1]!) / d[1]!)
  if (d[1]! < -1e-9) consider(-o[1]! / d[1]!)
  return best
}

function poseAt(position: number[], yaw: number, pitch: number): number[] {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const right = [cy, 0, -sy]
  const back = [sy * cp, sp, cy * cp]
  const up = [
    back[1]! * right[2]! - back[2]! * right[1]!,
    back[2]! * right[0]! - back[0]! * right[2]!,
    back[0]! * right[1]! - back[1]! * right[0]!,
  ]
  return [...right, 0, ...up, 0, ...back, 0, ...position, 1]
}

const DEPTH = { width: 160, height: 90, fx: 120, fy: 120, cx: 80, cy: 45 }
const PHOTO = { width: 640, height: 360 }
const MANIFEST_SHA = 'f'.repeat(64)

function buildStore(options: { trueNorth?: unknown; depthIndexMissing?: boolean } = {}) {
  const files = new Map<string, Uint8Array>()
  const put = (value: unknown | Uint8Array): string => {
    const bytes =
      value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value))
    const sha = createHash('sha256').update(bytes).digest('hex')
    files.set(sha, bytes)
    return sha
  }
  const pointer = (sha: string) => ({ uri: `/api/artifacts/${sha}`, sha256: sha })
  const rgbFrames: unknown[] = []
  const depthFrames: unknown[] = []
  let n = 0
  const jpeg = put(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))
  for (const [x, z] of [
    [-1, -0.6],
    [1, 0.5],
    [0, 0],
    [-0.8, 0.7],
    [0.9, -0.7],
  ] as const) {
    for (let k = 0; k < 8; k += 1) {
      const pose = poseAt([x, 1.4, z], (k * Math.PI) / 4, 0.45)
      const world = (cx: number, cy: number, cz: number) => [
        pose[0]! * cx + pose[4]! * cy + pose[8]! * cz,
        pose[1]! * cx + pose[5]! * cy + pose[9]! * cz,
        pose[2]! * cx + pose[6]! * cy + pose[10]! * cz,
      ]
      const depth = new Uint8Array(DEPTH.width * DEPTH.height * 2)
      const view = new DataView(depth.buffer)
      for (let py = 0; py < DEPTH.height; py += 1) {
        for (let px = 0; px < DEPTH.width; px += 1) {
          const t = cast(
            [x, 1.4, z],
            world((px - DEPTH.cx) / DEPTH.fx, -(py - DEPTH.cy) / DEPTH.fy, -1),
          )
          view.setUint16((py * DEPTH.width + px) * 2, t === null ? 0 : Math.round(t * 1000), true)
        }
      }
      rgbFrames.push({
        id: `kf${n}`,
        timestamp: n * 500,
        image: pointer(jpeg),
        width: PHOTO.width,
        height: PHOTO.height,
        intrinsics: { fx: 480, fy: 480, cx: 320, cy: 180 },
        pose,
        trackingState: 'tracking',
      })
      depthFrames.push({
        id: `d${n}`,
        rgbKeyframeId: `kf${n}`,
        timestamp: n * 500,
        width: DEPTH.width,
        height: DEPTH.height,
        intrinsics: { fx: DEPTH.fx, fy: DEPTH.fy, cx: DEPTH.cx, cy: DEPTH.cy },
        depth: pointer(put(depth)),
        confidence: pointer(put(new Uint8Array(DEPTH.width * DEPTH.height).fill(230))),
      })
      n += 1
    }
  }
  const streams: unknown[] = [
    {
      id: 'photos',
      kind: 'rgb-keyframes',
      artifact: {
        id: 'photos',
        ...pointer(put({ frames: rgbFrames })),
        mediaType: 'application/json',
      },
    },
  ]
  if (!options.depthIndexMissing) {
    streams.push({
      id: 'depth',
      kind: 'depth-keyframes',
      artifact: {
        id: 'depth',
        ...pointer(put({ frames: depthFrames })),
        mediaType: 'application/json',
      },
    })
  }
  files.set(
    MANIFEST_SHA,
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        sessionId: 'room',
        state: 'ready',
        coordinateFrames: [],
        streams,
        metadata: {
          provider: 'android-arcore',
          appVersion: '0.0.0-test',
          device: { manufacturer: 'Test', model: 'Synthetic', os: 'Android' },
          createdAt: '2026-11-25T10:00:00+00:00',
          trackingLossCount: 0,
          warnings: [],
          ...(options.trueNorth ? { trueNorth: options.trueNorth } : {}),
        },
      }),
    ),
  )
  return files
}

const ORIGIN = 'https://studio.test'
function deps(files: Map<string, Uint8Array>, extra: Partial<LoaderDeps> = {}): LoaderDeps {
  const decodePhoto: PhotoDecoder = async () => {
    const width = 160
    const height = 90
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i += 1) data.set([200, 40, 40, 255], i * 4)
    return {
      width,
      height,
      sourceWidth: PHOTO.width,
      sourceHeight: PHOTO.height,
      data,
      channels: 4,
    }
  }
  return {
    fetchBytes: async (url, limit) => {
      const bytes = files.get(url.split('/').pop()!)
      if (!bytes) return null
      if (limit.exact !== undefined && bytes.byteLength !== limit.exact) return null
      if (limit.max !== undefined && bytes.byteLength > limit.max) return null
      return bytes
    },
    decodePhoto,
    artifactUrl: (value) => sameOriginUrl(value, ORIGIN, ORIGIN),
    yieldToLoop: async () => {},
    ...extra,
  }
}

const request = {
  manifestUrl: `/api/artifacts/${MANIFEST_SHA}`,
  transform: {
    position: [10, 0, 20] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: 1,
  },
  layer: 'top' as const,
}

describe('loadScanMap', () => {
  test('builds a coloured map placed through the scan transform, in level coordinates', async () => {
    const progress: string[] = []
    const result = await loadScanMap(request, {
      ...deps(buildStore()),
      onProgress: (p) => progress.push(p.phase),
    })
    // The room spans x -2..2, z -1.5..1.5 in the capture world; the scan sits at (10, 20).
    expect(result.map.origin[0]).toBeGreaterThan(7.5)
    expect(result.map.origin[0]).toBeLessThan(8.3)
    expect(result.map.origin[1]).toBeGreaterThan(18.3)
    expect(result.map.origin[1]).toBeLessThan(18.8)
    const extentX = result.map.width * result.map.metresPerPixel
    expect(extentX).toBeGreaterThan(3.8)
    expect(extentX).toBeLessThan(4.8)
    let coloured = 0
    for (let at = 0; at < result.map.width * result.map.height; at += 1) {
      if (result.map.rgba[at * 4 + 3] === 255) {
        coloured += 1
        expect(result.map.rgba[at * 4]).toBe(200)
        expect(result.map.rgba[at * 4 + 1]).toBe(40)
      }
    }
    expect(coloured).toBeGreaterThan(1000)
    expect(result.photosDecoded).toBeGreaterThan(0)
    expect(progress).toContain('frames')
    expect(progress.at(-1)).toBe('map')
    expect(result.north).toBeNull()
  })

  test('a photo whose size differs from its keyframe adds shape but no colour', async () => {
    const wrongSize: PhotoDecoder = async () => ({
      width: 160,
      height: 90,
      sourceWidth: 800,
      sourceHeight: 450,
      data: new Uint8ClampedArray(160 * 90 * 4).fill(255),
      channels: 4,
    })
    const result = await loadScanMap(request, { ...deps(buildStore()), decodePhoto: wrongSize })
    expect(result.photosDecoded).toBe(0)
    expect(result.notes.join(' ')).toContain('could not be used')
    const shapeOnly = Array.from({ length: result.map.width * result.map.height }).some(
      (_, at) => result.map.rgba[at * 4 + 3] === 128,
    )
    expect(shapeOnly).toBe(true)
  })

  test('reads trueNorth into a level direction', async () => {
    const result = await loadScanMap(
      request,
      deps(
        buildStore({
          trueNorth: {
            worldYawDeg: 90,
            confidence: 0.9,
            method: 'compass-median-true',
            reference: 'true',
            spreadDeg: 3,
            sampleCount: 40,
            declinationDeg: 0.5,
            segmentsAgree: true,
          },
        }),
      ),
    )
    // North at +90 degrees from -Z is +X: pointing right on the map.
    expect(result.north![0]).toBeCloseTo(1, 5)
    expect(result.north![1]).toBeCloseTo(0, 5)
    expect(result.northReference).toBe('true')
  })

  test('refuses a scan without depth keyframes', async () => {
    await expect(
      loadScanMap(request, deps(buildStore({ depthIndexMissing: true }))),
    ).rejects.toBeInstanceOf(MapRefusal)
  })

  test('refuses manifest URLs that are not same-origin artifacts', async () => {
    for (const url of [
      'https://evil.test/api/artifacts/' + MANIFEST_SHA,
      '/api/other/' + MANIFEST_SHA,
      'data:application/json,{}',
      `/api/artifacts/${MANIFEST_SHA}?x=1`,
    ]) {
      await expect(
        loadScanMap({ ...request, manifestUrl: url }, deps(buildStore())),
      ).rejects.toThrow()
    }
  })

  test('stops when cancelled', async () => {
    const state = { calls: 0 }
    await expect(
      loadScanMap(request, {
        ...deps(buildStore()),
        isCancelled: () => {
          state.calls += 1
          return state.calls > 3
        },
      }),
    ).rejects.toBeInstanceOf(MapCancelled)
  })
})

describe('northInLevel', () => {
  const identity = {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: 1,
  }
  test('0 degrees points up the map (-z), 90 right (+x), 180 down', () => {
    expect(northInLevel(0, identity)[1]).toBeCloseTo(-1, 5)
    expect(northInLevel(90, identity)[0]).toBeCloseTo(1, 5)
    expect(northInLevel(180, identity)[1]).toBeCloseTo(1, 5)
  })
  test('follows the scan rotation about y', () => {
    const turned = northInLevel(0, { ...identity, rotation: [0, Math.PI / 2, 0] })
    expect(Math.abs(turned[0])).toBeCloseTo(1, 5)
  })
})
