import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { ScanNode } from '@pascal-app/core/schema'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { DiskArtifactStore } from '../storage/disk-artifact-store'
import { MAP_MAX_SIDE, registerScanMapTool } from './scan-map-tool'

// Synthetic bundles only. A box room (x -2..2, z -1.5..1.5, y 0..2.5) is ray-cast into raw depth
// frames and baseline JPEG photos, so the map's colours can be checked against known places.

type Rgb = [number, number, number]
const RED: Rgb = [220, 30, 30]
const BLUE: Rgb = [30, 30, 220]
const GREEN: Rgb = [30, 200, 30]
const YELLOW: Rgb = [230, 220, 30]
const WHITE: Rgb = [235, 235, 235]
const FLOOR_PX_PZ: Rgb = [220, 30, 220]
const FLOOR_PX_NZ: Rgb = [30, 210, 210]
const FLOOR_NX_PZ: Rgb = [240, 140, 30]
const FLOOR_NX_NZ: Rgb = [110, 110, 110]

const floorColour = (x: number, z: number): Rgb =>
  x > 0 ? (z > 0 ? FLOOR_PX_PZ : FLOOR_PX_NZ) : z > 0 ? FLOOR_NX_PZ : FLOOR_NX_NZ

function cast(o: number[], d: number[]): { t: number; colour: Rgb } | null {
  let best: { t: number; colour: Rgb } | null = null
  const consider = (t: number, colour: Rgb) => {
    if (t > 1e-6 && (!best || t < best.t)) best = { t, colour }
  }
  if (d[0]! > 1e-9) consider((2 - o[0]!) / d[0]!, RED)
  if (d[0]! < -1e-9) consider((-2 - o[0]!) / d[0]!, BLUE)
  if (d[2]! > 1e-9) consider((1.5 - o[2]!) / d[2]!, GREEN)
  if (d[2]! < -1e-9) consider((-1.5 - o[2]!) / d[2]!, YELLOW)
  if (d[1]! > 1e-9) consider((2.5 - o[1]!) / d[1]!, WHITE)
  if (d[1]! < -1e-9) {
    const t = -o[1]! / d[1]!
    consider(t, floorColour(o[0]! + t * d[0]!, o[2]! + t * d[2]!))
  }
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

/** A baseline 4:4:4 JPEG with only DC coefficients: one block colour per 8x8 pixels. */
function encodeDcJpeg(width: number, height: number, blocks: Rgb[]): Uint8Array {
  const out: number[] = [0xff, 0xd8]
  const marker = (code: number, body: number[]) =>
    out.push(0xff, code, (body.length + 2) >> 8, (body.length + 2) & 255, ...body)
  marker(0xdb, [0, ...Array.from({ length: 64 }, () => 1)])
  marker(0xc0, [
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    0,
    3,
    0x11,
    0,
  ])
  // DC table: twelve 4-bit codes for categories 0..11. AC table: one 1-bit code for EOB (0x00).
  marker(0xc4, [
    0x00,
    0,
    0,
    0,
    12,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...Array.from({ length: 12 }, (_, i) => i),
  ])
  marker(0xc4, [0x10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00])
  marker(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0])
  let acc = 0
  let nbits = 0
  const put = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) {
      acc = (acc << 1) | ((value >> i) & 1)
      nbits += 1
      if (nbits === 8) {
        out.push(acc)
        if (acc === 0xff) out.push(0)
        acc = 0
        nbits = 0
      }
    }
  }
  const prediction = [0, 0, 0]
  for (const [r, g, b] of blocks) {
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128
    ;[y, cb, cr].forEach((value, c) => {
      const dc = Math.round((value - 128) * 8)
      const diff = dc - prediction[c]!
      prediction[c] = dc
      const magnitude = Math.abs(diff)
      const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1
      put(category, 4)
      if (category > 0) put(diff < 0 ? diff + (1 << category) - 1 : diff, category)
      put(0, 1) // EOB
    })
  }
  if (nbits > 0) put(0x7f, 8 - nbits)
  out.push(0xff, 0xd9)
  return Uint8Array.from(out)
}

let directory: string
let store: DiskArtifactStore

async function put(value: unknown | Uint8Array): Promise<string> {
  const bytes =
    value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await store.put(sha256, bytes)
  return sha256
}
const pointer = (sha256: string) => ({ uri: `/api/artifacts/${sha256}`, sha256 })
const reference = (sha256: string, mediaType: string) => ({
  id: sha256.slice(0, 8),
  ...pointer(sha256),
  mediaType,
})

const DEPTH = { width: 160, height: 90, fx: 120, fy: 120, cx: 80, cy: 45 }
const PHOTO_SCALE = 4
const PHOTO = { width: 640, height: 360 }

async function roomBundle(options: { withDepth?: boolean; progressive?: boolean }) {
  const rgbFrames: unknown[] = []
  const depthFrames: unknown[] = []
  const spots = [
    [-1, -0.6],
    [1, 0.5],
    [0, 0],
    [-0.8, 0.7],
    [0.9, -0.7],
  ]
  let n = 0
  for (const [x, z] of spots) {
    for (let k = 0; k < 8; k += 1) {
      const pose = poseAt([x!, 1.4, z!], (k * Math.PI) / 4, 0.45)
      const world = (cx: number, cy: number, cz: number) => [
        pose[0]! * cx + pose[4]! * cy + pose[8]! * cz,
        pose[1]! * cx + pose[5]! * cy + pose[9]! * cz,
        pose[2]! * cx + pose[6]! * cy + pose[10]! * cz,
      ]
      const origin = [x!, 1.4, z!]
      const depth = new Uint8Array(DEPTH.width * DEPTH.height * 2)
      const view = new DataView(depth.buffer)
      for (let py = 0; py < DEPTH.height; py += 1) {
        for (let px = 0; px < DEPTH.width; px += 1) {
          const hit = cast(
            origin,
            world((px - DEPTH.cx) / DEPTH.fx, -(py - DEPTH.cy) / DEPTH.fy, -1),
          )
          view.setUint16((py * DEPTH.width + px) * 2, hit ? Math.round(hit.t * 1000) : 0, true)
        }
      }
      // One colour per 8x8 photo block, taken at the block centre.
      const blocks: Rgb[] = []
      for (let by = 0; by < PHOTO.height / 8; by += 1) {
        for (let bx = 0; bx < PHOTO.width / 8; bx += 1) {
          const u = bx * 8 + 4
          const v = by * 8 + 4
          const hit = cast(
            origin,
            world(
              (u - DEPTH.cx * PHOTO_SCALE) / (DEPTH.fx * PHOTO_SCALE),
              -(v - DEPTH.cy * PHOTO_SCALE) / (DEPTH.fy * PHOTO_SCALE),
              -1,
            ),
          )
          blocks.push(hit?.colour ?? [0, 0, 0])
        }
      }
      const image = options.progressive
        ? Uint8Array.from([0xff, 0xd8, 0xff, 0xc2, 0, 2, 0xff, 0xd9])
        : encodeDcJpeg(PHOTO.width, PHOTO.height, blocks)
      rgbFrames.push({
        id: `kf${n}`,
        timestamp: n * 500,
        image: pointer(await put(image)),
        width: PHOTO.width,
        height: PHOTO.height,
        intrinsics: {
          fx: DEPTH.fx * PHOTO_SCALE,
          fy: DEPTH.fy * PHOTO_SCALE,
          cx: DEPTH.cx * PHOTO_SCALE,
          cy: DEPTH.cy * PHOTO_SCALE,
        },
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
        depth: pointer(await put(depth)),
        confidence: pointer(await put(new Uint8Array(DEPTH.width * DEPTH.height).fill(230))),
      })
      n += 1
    }
  }
  const streams: unknown[] = [
    {
      id: 'photos',
      kind: 'rgb-keyframes',
      role: 'photos',
      artifact: reference(await put({ frames: rgbFrames }), 'application/json'),
    },
  ]
  if (options.withDepth !== false) {
    streams.push({
      id: 'depth',
      kind: 'depth-keyframes',
      role: 'depth',
      artifact: reference(await put({ frames: depthFrames }), 'application/json'),
    })
  }
  return put({
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
      camera: { convention: 'opengl', frame: 'image-readout', sensorOrientationDeg: 90 },
    },
  })
}

async function connect(scans: Array<{ id: string; manifest: string }>) {
  const bridge = new SceneBridge()
  bridge.setScene({}, [])
  bridge.loadDefault()
  const json = bridge.exportJSON()
  const nodes = json.nodes as Record<string, any>
  const level = Object.values(nodes).find((node) => node.type === 'level')
  for (const scan of scans) {
    nodes[scan.id] = ScanNode.parse({
      id: scan.id,
      parentId: level.id,
      position: [10, 0, 20],
      rotation: [0, 0, 0],
      captureSession: {
        sessionId: `session-${scan.id}`,
        schemaVersion: 2,
        manifestUrl: `/api/artifacts/${scan.manifest}`,
      },
    })
  }
  level.children = [...(level.children ?? []), ...scans.map((scan) => scan.id)]
  bridge.loadJSON({ ...json, nodes })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerScanMapTool(server, bridge, store)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

type Part = { type: string; text?: string; data?: string; mimeType?: string }
const call = async (client: Client, args: Record<string, unknown>) => {
  const result = await client.callTool({ name: 'view_scan_map', arguments: args })
  return { ...result, content: result.content as Part[] }
}

/** Decodes the PNG this server writes (RGB, 8 bit, Sub filter). */
function decodePng(base64: string) {
  const bytes = Buffer.from(base64, 'base64')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const length = bytes.readUInt32BE(33)
  const raw = inflateSync(bytes.subarray(41, 41 + length))
  const rgb = new Uint8Array(width * height * 3)
  const stride = width * 3
  for (let y = 0; y < height; y += 1) {
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 3 ? rgb[y * stride + i - 3]! : 0
      rgb[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + left) & 255
    }
  }
  return { width, height, rgb, bytes: bytes.length }
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'pascal-scan-map-'))
  store = new DiskArtifactStore(join(directory, 'pascal.db'))
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('view_scan_map', () => {
  test('returns a PNG whose colours sit where the room has them, through the node transform', async () => {
    const client = await connect([{ id: 'scan_roomroom', manifest: await roomBundle({}) }])
    const { content, isError } = await call(client, { scanId: 'scan_roomroom', layer: 'floor' })
    expect(isError).toBeFalsy()
    const info = JSON.parse(content[0]!.text!)
    const image = content.find((part) => part.type === 'image')!
    expect(image.mimeType).toBe('image/png')
    const png = decodePng(image.data!)
    expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(MAP_MAX_SIDE)
    expect(info.image.width).toBe(png.width)
    expect(info.image.bytes).toBe(png.bytes)
    expect(info.cloud.photosDecoded).toBeGreaterThan(10)
    // The room is 4 x 3 m; the scan node moves it by (10, 20).
    expect(png.width * info.image.metresPerPixel).toBeGreaterThan(3.9)
    expect(png.width * info.image.metresPerPixel).toBeLessThan(4.6)
    const at = (x: number, z: number) => {
      const column = Math.floor((x + 10 - info.image.topLeftLevel.x) / info.image.metresPerPixel)
      const row = Math.floor((z + 20 - info.image.topLeftLevel.z) / info.image.metresPerPixel)
      const offset = (row * png.width + column) * 3
      return [png.rgb[offset]!, png.rgb[offset + 1]!, png.rgb[offset + 2]!]
    }
    const close = (actual: number[], expected: Rgb) => {
      for (let c = 0; c < 3; c += 1) expect(Math.abs(actual[c]! - expected[c]!)).toBeLessThan(45)
    }
    close(at(1, 0.75), FLOOR_PX_PZ)
    close(at(1, -0.75), FLOOR_PX_NZ)
    close(at(-1, 0.75), FLOOR_NX_PZ)
    close(at(-1, -0.75), FLOOR_NX_NZ)
    expect(info.image.axes).toContain('+x')
  })

  test('the top layer is returned too, and the outline option is respected', async () => {
    const client = await connect([{ id: 'scan_roomtop1', manifest: await roomBundle({}) }])
    const { content } = await call(client, { scanId: 'scan_roomtop1', outline: false })
    const info = JSON.parse(content[0]!.text!)
    expect(info.layer).toBe('top')
    expect(info.outline).toBeNull()
    expect(content.some((part) => part.type === 'image')).toBe(true)
  })

  test('photos it cannot read still give a shape map, and say so', async () => {
    const client = await connect([
      { id: 'scan_noncolor', manifest: await roomBundle({ progressive: true }) },
    ])
    const { content } = await call(client, { scanId: 'scan_noncolor', layer: 'floor' })
    const info = JSON.parse(content[0]!.text!)
    expect(info.cloud.photosDecoded).toBe(0)
    expect(info.cloud.uncolouredVoxels).toBe(info.cloud.voxels)
    expect(info.notes.join(' ')).toContain('baseline JPEG')
  })

  test('refuses a scan without depth, and an unknown scan', async () => {
    const client = await connect([
      { id: 'scan_nodepth01', manifest: await roomBundle({ withDepth: false }) },
    ])
    const nodepth = await call(client, { scanId: 'scan_nodepth01' })
    expect(nodepth.isError).toBe(true)
    expect(nodepth.content[0]!.text).toContain('no_depth')
    const missing = await call(client, { scanId: 'scan_missing01' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0]!.text).toContain('scan_not_found')
  })
})
