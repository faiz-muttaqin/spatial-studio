import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { ScanNode } from '@pascal-app/core/schema'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { DiskArtifactStore } from '../storage/disk-artifact-store'
import { MAX_PHOTO_BYTES, registerScanTools } from './scan-tools'

// Synthetic bundles only: no real capture data is committed.

function pose(x: number[], y: number[], z: number[], t: number[]): number[] {
  return [...x, 0, ...y, 0, ...z, 0, ...t, 1]
}

function wall(id: string, a: [number, number], b: [number, number], height = 2.5) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  const dx = (b[0] - a[0]) / length
  const dz = (b[1] - a[1]) / length
  return {
    id,
    orientation: 'vertical',
    centerPose: pose(
      [dx, 0, dz],
      [dz, 0, -dx],
      [0, 1, 0],
      [(a[0] + b[0]) / 2, height / 2, (a[1] + b[1]) / 2],
    ),
    extent: [length, height],
    polygon: [
      [-length / 2, -height / 2],
      [length / 2, -height / 2],
      [length / 2, height / 2],
      [-length / 2, height / 2],
    ],
    subsumedBy: null,
  }
}

function flat(id: string, orientation: string, y: number) {
  return {
    id,
    orientation,
    centerPose: pose(
      [1, 0, 0],
      [0, orientation === 'horizontal-up' ? 1 : -1, 0],
      [0, 0, 1],
      [2, y, 1.5],
    ),
    extent: [4, 3],
    polygon: [
      [-2, -1.5],
      [2, -1.5],
      [2, 1.5],
      [-2, 1.5],
    ],
    subsumedBy: null,
  }
}

const rectanglePlanes = {
  planes: [
    wall('w0', [0.05, 0], [3.95, 0]),
    wall('w1', [4, 0.05], [4, 2.95]),
    wall('w2', [3.95, 3], [0.05, 3]),
    wall('w3', [0, 2.95], [0, 0.05]),
    flat('floor', 'horizontal-up', 0),
    flat('ceiling', 'horizontal-down', 2.5),
  ],
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

const reference = (sha256: string, mediaType: string) => ({
  id: sha256.slice(0, 8),
  uri: `/api/artifacts/${sha256}`,
  sha256,
  mediaType,
})

function jpeg(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = seed
  return bytes
}

type BundleOptions = {
  sessionId: string
  planes?: unknown
  measurements?: unknown
  frames?: number
  frameSize?: number
}

async function bundle(options: BundleOptions): Promise<string> {
  const streams: unknown[] = []
  if (options.frames) {
    const frames = []
    for (let index = 0; index < options.frames; index += 1) {
      const image = await put(jpeg(options.frameSize ?? 2000, index))
      frames.push({
        id: `kf${index}`,
        timestamp: index * 1000,
        image: { uri: `/api/artifacts/${image}`, sha256: image },
        width: 640,
        height: 480,
        intrinsics: { fx: 500, fy: 500, cx: 320, cy: 240 },
        pose: pose([1, 0, 0], [0, 1, 0], [0, 0, 1], [index, 1.4, 0]),
        trackingState: 'tracking',
      })
    }
    streams.push({
      id: 'photos',
      kind: 'rgb-keyframes',
      role: 'photos',
      artifact: reference(await put({ frames }), 'application/json'),
    })
  }
  if (options.planes) {
    streams.push({
      id: 'planes',
      kind: 'plane-set',
      role: 'planes',
      artifact: reference(await put(options.planes), 'application/json'),
    })
  }
  if (options.measurements) {
    streams.push({
      id: 'measurements',
      kind: 'manual-measurements',
      role: 'measurements',
      inline: options.measurements,
    })
  }
  return put({
    schemaVersion: 2,
    sessionId: options.sessionId,
    state: 'ready',
    streams,
    metadata: {
      provider: 'android-arcore',
      appVersion: '0.0.0-test',
      device: { manufacturer: 'Test', model: 'Synthetic', os: 'Android' },
      createdAt: '2026-11-25T10:00:00+00:00',
      trackingLossCount: 2,
      warnings: ['synthetic'],
      camera: { convention: 'opengl', frame: 'image-readout', sensorOrientationDeg: 90 },
    },
  })
}

const measurementsOnly = {
  units: 'm',
  room: { width: 4.2, length: 3.1, height: 2.4 },
  openings: [],
  notes: '',
  source: 'manual',
}

async function connect(scans: Array<{ id: string; manifest: string | null; rotationY?: number }>) {
  const bridge = new SceneBridge()
  bridge.setScene({}, [])
  bridge.loadDefault()
  const json = bridge.exportJSON()
  const nodes = json.nodes as Record<string, any>
  const level = Object.values(nodes).find((node) => node.type === 'level')
  const children: string[] = []
  for (const scan of scans) {
    nodes[scan.id] = ScanNode.parse({
      id: scan.id,
      parentId: level.id,
      name: `Scan ${scan.id}`,
      position: [10, 0, 20],
      rotation: [0, scan.rotationY ?? 0, 0],
      captureSession: {
        sessionId: `session-${scan.id}`,
        schemaVersion: 2,
        ...(scan.manifest ? { manifestUrl: `/api/artifacts/${scan.manifest}` } : {}),
      },
    })
    children.push(scan.id)
  }
  level.children = [...(level.children ?? []), ...children]
  bridge.loadJSON({ ...json, nodes })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerScanTools(server, bridge, store)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, levelId: level.id as string }
}

type Part = { type: string; text?: string; data?: string; mimeType?: string }
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return { ...result, content: result.content as Part[] }
}
const json = (part: Part | undefined) => JSON.parse(part!.text!)

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'pascal-scan-tools-'))
  store = new DiskArtifactStore(join(directory, 'pascal.db'))
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('scan tools', () => {
  test('list_scans summarises scans and reports an unreadable one without failing', async () => {
    const full = await bundle({
      sessionId: 'a',
      planes: rectanglePlanes,
      measurements: measurementsOnly,
      frames: 5,
    })
    const { client, levelId } = await connect([
      { id: 'scan_aaaaaaaa', manifest: full },
      { id: 'scan_bbbbbbbb', manifest: 'f'.repeat(64) },
      { id: 'scan_cccccccc', manifest: null },
    ])
    const { content, isError } = await call(client, 'list_scans')
    expect(isError).toBeFalsy()
    const { scans, total } = json(content[0])
    expect(total).toBe(3)
    expect(scans[0]).toMatchObject({
      scanId: 'scan_aaaaaaaa',
      levelId,
      provider: 'android-arcore',
      createdAt: '2026-11-25T10:00:00+00:00',
      device: { manufacturer: 'Test', model: 'Synthetic', os: 'Android' },
      keyframeCount: 5,
      hasMeasurements: true,
      hasPlanes: true,
    })
    expect(scans[0].streamKinds.toSorted()).toEqual([
      'manual-measurements',
      'plane-set',
      'rgb-keyframes',
    ])
    expect(scans[1]).toMatchObject({ scanId: 'scan_bbbbbbbb', error: 'scan_manifest_missing' })
    expect(scans[2]).toMatchObject({ error: 'scan_has_no_capture' })
  })

  test('read_scan returns a compact summary with planes in capture and level coordinates', async () => {
    const manifest = await bundle({
      sessionId: 'r',
      planes: rectanglePlanes,
      measurements: measurementsOnly,
      frames: 3,
    })
    const { client } = await connect([{ id: 'scan_rrrrrrrr', manifest, rotationY: Math.PI / 2 }])
    const { content, isError } = await call(client, 'read_scan', { scanId: 'scan_rrrrrrrr' })
    expect(isError).toBeFalsy()
    const text = content[0]!.text!
    const summary = JSON.parse(text)
    expect(text.length).toBeLessThan(8000)
    expect(summary.captureMetadata).toMatchObject({
      provider: 'android-arcore',
      trackingLossCount: 2,
      warnings: ['synthetic'],
      camera: { convention: 'opengl', frame: 'image-readout', sensorOrientationDeg: 90 },
    })
    expect(summary.measurements.room.width).toBe(4.2)
    expect(summary.planes.floorToCeiling).toBe(2.5)
    expect(summary.planes.floor).toMatchObject({ captureWorldY: 0, levelY: 0 })
    expect(summary.planes.ceiling).toMatchObject({ captureWorldY: 2.5, levelY: 2.5 })
    const south = summary.planes.walls.find((entry: any) => entry.planeId === 'w0')
    expect(south.captureWorld.length).toBe(3.9)
    // Quarter turn about Y: capture (x, z) -> (z, -x), then the node offset [10, 20].
    expect(south.captureWorld.a).toEqual([0.05, 0])
    expect(south.level.a[0]).toBeCloseTo(10, 2)
    expect(south.level.a[1]).toBeCloseTo(19.95, 2)
    expect(summary.keyframes.count).toBe(3)
    expect(summary.keyframes.items[0]).toMatchObject({
      id: 'kf0',
      trackingState: 'tracking',
      hasPose: true,
    })
    expect(summary.depth).toEqual({ present: false, frameCount: 0 })
    expect(text).not.toContain('base64')
  })

  test('read_scan refuses unknown scans', async () => {
    const { client } = await connect([])
    const result = await call(client, 'read_scan', { scanId: 'scan_nope0000' })
    expect(result.isError).toBe(true)
    expect(json(result.content[0])).toMatchObject({ code: 'scan_not_found' })
  })

  test('view_scan_photos returns images with pose text, sampled evenly or by id', async () => {
    const manifest = await bundle({ sessionId: 'p', frames: 10 })
    const { client } = await connect([{ id: 'scan_pppppppp', manifest }])
    const sampled = await call(client, 'view_scan_photos', { scanId: 'scan_pppppppp', count: 3 })
    expect(sampled.isError).toBeFalsy()
    const images = sampled.content.filter((part) => part.type === 'image')
    expect(images).toHaveLength(3)
    expect(images[0]!.mimeType).toBe('image/jpeg')
    const notes = sampled.content
      .filter((part) => part.type === 'text')
      .slice(0, 3)
      .map(json)
    expect(notes.map((note) => note.frameId)).toEqual(['kf0', 'kf5', 'kf9'])
    expect(notes[0].intrinsics).toEqual({ fx: 500, fy: 500, cx: 320, cy: 240 })
    expect(notes[0].poseCameraToWorld).toHaveLength(16)
    // Node offset [10, 0, 20] applied to the camera position; identity rotation looks down -Z.
    expect(notes[1].positionLevel).toEqual([15, 1.4, 20])
    expect(notes[1].forwardLevel).toEqual([-0, -0, -1].map((value) => value + 0))

    const byId = await call(client, 'view_scan_photos', {
      scanId: 'scan_pppppppp',
      frameIds: ['kf2', 'kf4'],
    })
    expect(byId.content.filter((part) => part.type === 'image')).toHaveLength(2)
    const missing = await call(client, 'view_scan_photos', {
      scanId: 'scan_pppppppp',
      frameIds: ['nope'],
    })
    expect(missing.isError).toBe(true)
    expect(json(missing.content[0]).code).toBe('frame_not_found')
    const tooMany = await call(client, 'view_scan_photos', { scanId: 'scan_pppppppp', count: 9 })
    expect(tooMany.isError).toBe(true)
  })

  test('view_scan_photos caps the bytes per call and lists what it left out', async () => {
    const manifest = await bundle({ sessionId: 'big', frames: 4, frameSize: 1_000_000 })
    const { client } = await connect([{ id: 'scan_bbbbbbbb', manifest }])
    const result = await call(client, 'view_scan_photos', { scanId: 'scan_bbbbbbbb', count: 4 })
    const images = result.content.filter((part) => part.type === 'image')
    const summary = json(result.content.at(-1))
    expect(images).toHaveLength(3)
    expect(summary.imageBytes).toBeLessThanOrEqual(MAX_PHOTO_BYTES)
    expect(summary.omitted).toEqual([{ frameId: 'kf3', reason: 'over the size cap for one call' }])
  })

  test('view_scan_photos refuses a bundle with no photos', async () => {
    const manifest = await bundle({ sessionId: 'n', measurements: measurementsOnly })
    const { client } = await connect([{ id: 'scan_nnnnnnnn', manifest }])
    const result = await call(client, 'view_scan_photos', { scanId: 'scan_nnnnnnnn' })
    expect(json(result.content[0]).code).toBe('no_keyframes')
  })

  test('propose_room_from_scan proposes from planes and writes nothing', async () => {
    const manifest = await bundle({
      sessionId: 'q',
      planes: rectanglePlanes,
      measurements: measurementsOnly,
    })
    const { client, levelId } = await connect([{ id: 'scan_qqqqqqqq', manifest }])
    const result = await call(client, 'propose_room_from_scan', { scanId: 'scan_qqqqqqqq' })
    const proposal = json(result.content[0])
    expect(proposal).toMatchObject({ method: 'planes', levelId, needsVerification: true })
    expect(proposal.polygon).toHaveLength(4)
    // Node offset [10, 20] shifts the 4 x 3 rectangle.
    const xs = proposal.polygon
      .map((point: number[]) => point[0])
      .toSorted((a: number, b: number) => a - b)
    expect([xs[0], xs[3]]).toEqual([10, 14])
    expect(proposal.height).toEqual({ value: 2.5, basis: 'plane-estimate' })
    expect(proposal.unknowns.join(' ')).toContain('manual measurement says 2.4 m')
    expect(proposal.next).toContain('create_room')
  })

  test('propose_room_from_scan falls back to the measurements for a measurements-only bundle', async () => {
    const manifest = await bundle({ sessionId: 'm', measurements: measurementsOnly })
    const { client } = await connect([{ id: 'scan_mmmmmmmm', manifest }])
    const result = await call(client, 'propose_room_from_scan', { scanId: 'scan_mmmmmmmm' })
    const proposal = json(result.content[0])
    expect(proposal.method).toBe('manual-measurements')
    expect(proposal.height).toEqual({ value: 2.4, basis: 'manual-measurement' })
    expect(proposal.edges.every((edge: any) => edge.basis === 'manual-measurement')).toBe(true)
  })

  test('a manifest that breaks the contract is refused as invalid', async () => {
    const manifest = await put({ schemaVersion: 2, sessionId: 'bad', streams: 'nope' })
    const { client } = await connect([{ id: 'scan_xxxxxxxx', manifest }])
    const result = await call(client, 'read_scan', { scanId: 'scan_xxxxxxxx' })
    expect(json(result.content[0]).code).toBe('scan_manifest_invalid')
  })
})
