import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { ScanNode, WallNode } from '@pascal-app/core/schema'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { DiskArtifactStore } from '../storage/disk-artifact-store'
import { registerScanSemanticsTools } from './scan-semantics-tools'

// Synthetic bundle only: a 5 x 4 m room with a door in the north wall, ray-cast into raw depth.

type V3 = [number, number, number]
type Box = { min: V3; max: V3 }
const DEPTH_W = 160
const DEPTH_H = 90
const DEPTH_K = { fx: 105, fy: 105, cx: 80, cy: 45 }
const IMAGE_K = { fx: 1260, fy: 1260, cx: 960, cy: 540 }
const FACING_NORTH = -Math.PI / 2

const BOXES: Box[] = [
  { min: [-0.5, -0.1, -3], max: [5.5, 0, 4.5] },
  { min: [-0.5, 2.6, -3], max: [5.5, 2.7, 4.5] },
  { min: [-0.5, 0, -0.05], max: [1, 2.6, 0] },
  { min: [1.9, 0, -0.05], max: [5.5, 2.6, 0] },
  { min: [1, 2.1, -0.05], max: [1.9, 2.6, 0] },
  { min: [-0.5, 0, -3.05], max: [5.5, 2.6, -3] },
  { min: [5, 0, -3], max: [5.05, 2.6, 4.5] },
  { min: [-0.5, 0, 4], max: [5.5, 2.6, 4.05] },
  { min: [-0.05, 0, -3], max: [0, 2.6, 4.5] },
]

function rayBox(o: V3, d: V3, box: Box): number | null {
  let near = 0
  let far = Number.POSITIVE_INFINITY
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(d[axis]!) < 1e-12) {
      if (o[axis]! < box.min[axis]! || o[axis]! > box.max[axis]!) return null
      continue
    }
    let t0 = (box.min[axis]! - o[axis]!) / d[axis]!
    let t1 = (box.max[axis]! - o[axis]!) / d[axis]!
    if (t0 > t1) [t0, t1] = [t1, t0]
    near = Math.max(near, t0)
    far = Math.min(far, t1)
    if (near > far) return null
  }
  return near > 1e-6 ? near : null
}

function pose(x: number, z: number, yaw: number): number[] {
  const f = [Math.cos(yaw), 0, Math.sin(yaw)]
  const r = [-Math.sin(yaw), 0, Math.cos(yaw)]
  return [...r, 0, 0, 1, 0, 0, -f[0]!, -f[1]!, -f[2]!, 0, x, 1.4, z, 1]
}

function renderDepth(m: number[]): Uint8Array {
  const out = new Uint8Array(DEPTH_W * DEPTH_H * 2)
  const view = new DataView(out.buffer)
  const o: V3 = [m[12]!, m[13]!, m[14]!]
  for (let py = 0; py < DEPTH_H; py += 1) {
    for (let px = 0; px < DEPTH_W; px += 1) {
      const x = (px + 0.5 - DEPTH_K.cx) / DEPTH_K.fx
      const y = (DEPTH_K.cy - (py + 0.5)) / DEPTH_K.fy
      const d: V3 = [
        m[0]! * x + m[4]! * y - m[8]!,
        m[1]! * x + m[5]! * y - m[9]!,
        m[2]! * x + m[6]! * y - m[10]!,
      ]
      let hit = Number.POSITIVE_INFINITY
      for (const box of BOXES) {
        const t = rayBox(o, d, box)
        if (t !== null && t < hit) hit = t
      }
      if (Number.isFinite(hit))
        view.setUint16((py * DEPTH_W + px) * 2, Math.round(hit * 1000), true)
    }
  }
  return out
}

function project(m: number[], p: V3): [number, number] {
  const rel = [p[0] - m[12]!, p[1] - m[13]!, p[2] - m[14]!]
  const along = (a: number) => rel[0]! * m[a]! + rel[1]! * m[a + 1]! + rel[2]! * m[a + 2]!
  const depth = -along(8)
  return [
    IMAGE_K.cx + (IMAGE_K.fx * along(0)) / depth,
    IMAGE_K.cy - (IMAGE_K.fy * along(4)) / depth,
  ]
}

function planePose(x: number[], y: number[], z: number[], t: number[]): number[] {
  return [...x, 0, ...y, 0, ...z, 0, ...t, 1]
}

function wallPlane(id: string, a: [number, number], b: [number, number], height = 2.6) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  const dx = (b[0] - a[0]) / length
  const dz = (b[1] - a[1]) / length
  return {
    id,
    orientation: 'vertical',
    centerPose: planePose(
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

const floorPlane = {
  id: 'floor',
  orientation: 'horizontal-up',
  centerPose: planePose([1, 0, 0], [0, 1, 0], [0, 0, 1], [2.5, 0, 2]),
  extent: [5, 4],
  polygon: [
    [-2.5, -2],
    [2.5, -2],
    [2.5, 2],
    [-2.5, 2],
  ],
  subsumedBy: null,
}

let directory: string
let store: DiskArtifactStore

async function put(value: unknown): Promise<string> {
  const bytes =
    value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await store.put(sha256, bytes)
  return sha256
}

const ref = (sha256: string) => ({ uri: `/api/artifacts/${sha256}`, sha256 })

const VIEWS = [
  { id: 'kf0', pose: pose(1.5, 2.5, FACING_NORTH) },
  { id: 'kf1', pose: pose(2.6, 3.4, FACING_NORTH) },
  { id: 'kf2', pose: pose(4, 3.2, Math.PI / 2) },
]

async function bundle(): Promise<string> {
  const rgb = []
  const depth = []
  for (const view of VIEWS) {
    const image = new Uint8Array([0xff, 0xd8, 1, 2, 3])
    rgb.push({
      id: view.id,
      timestamp: 1,
      image: ref(await put(image)),
      width: 1920,
      height: 1080,
      intrinsics: IMAGE_K,
      pose: view.pose,
      trackingState: 'tracking',
    })
    depth.push({
      id: `d-${view.id}`,
      rgbKeyframeId: view.id,
      timestamp: 1,
      width: DEPTH_W,
      height: DEPTH_H,
      intrinsics: DEPTH_K,
      depth: ref(await put(renderDepth(view.pose))),
      confidence: null,
    })
  }
  const planes = {
    planes: [
      wallPlane('n', [0, 0], [5, 0]),
      wallPlane('e', [5, 0], [5, 4]),
      wallPlane('s', [5, 4], [0, 4]),
      wallPlane('w', [0, 4], [0, 0]),
      floorPlane,
    ],
  }
  const stream = async (id: string, kind: string, payload: unknown) => ({
    id,
    kind,
    role: id,
    artifact: { id, ...ref(await put(payload)), mediaType: 'application/json' },
  })
  return put({
    schemaVersion: 2,
    sessionId: 'semantics',
    state: 'ready',
    coordinateFrames: [],
    streams: [
      await stream('photos', 'rgb-keyframes', { frames: rgb }),
      await stream('depth', 'depth-keyframes', { frames: depth }),
      await stream('planes', 'plane-set', planes),
    ],
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

type Part = { type: string; text?: string }
async function connect(manifest: string, withWalls: boolean) {
  const bridge = new SceneBridge()
  bridge.setScene({}, [])
  bridge.loadDefault()
  const exported = bridge.exportJSON()
  const nodes = exported.nodes as Record<string, any>
  const level = Object.values(nodes).find((node) => node.type === 'level')
  const children: string[] = []
  nodes.scan_semantic = ScanNode.parse({
    id: 'scan_semantic',
    parentId: level.id,
    captureSession: {
      sessionId: 'session-semantics',
      schemaVersion: 2,
      manifestUrl: `/api/artifacts/${manifest}`,
    },
  })
  children.push('scan_semantic')
  if (withWalls) {
    const corners: Array<[string, [number, number], [number, number]]> = [
      ['wall_aaaaaaaa', [0, 0], [5, 0]],
      ['wall_bbbbbbbb', [5, 0], [5, 4]],
      ['wall_cccccccc', [5, 4], [0, 4]],
      ['wall_dddddddd', [0, 4], [0, 0]],
    ]
    for (const [id, start, end] of corners) {
      nodes[id] = WallNode.parse({ id, parentId: level.id, start, end, height: 2.6 })
      children.push(id)
    }
  }
  level.children = [...(level.children ?? []), ...children]
  bridge.loadJSON({ ...exported, nodes })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerScanSemanticsTools(server, bridge, store)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Part[]
  return { isError: result.isError, body: JSON.parse(content[0]!.text!) }
}

const doorBox = (view: number[]) => {
  const corners = [project(view, [1, 0, 0]), project(view, [1.9, 2.1, 0])]
  return [
    Math.min(...corners.map((c) => c[0])),
    Math.min(...corners.map((c) => c[1])),
    Math.max(...corners.map((c) => c[0])),
    Math.max(...corners.map((c) => c[1])),
  ]
}

let manifest: string
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'pascal-scan-semantics-'))
  store = new DiskArtifactStore(join(directory, 'pascal.db'))
  manifest = await bundle()
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('plan_scan_semantics', () => {
  test('names frontal keyframes per scene wall and says what to do next', async () => {
    const client = await connect(manifest, true)
    const { isError, body } = await call(client, 'plan_scan_semantics', { scanId: 'scan_semantic' })
    expect(isError).toBeFalsy()
    expect(body.wallSource).toBe('scene-walls')
    const north = body.walls.find((wall: any) => wall.wallId === 'wall_aaaaaaaa')
    expect(north.keyframes.map((frame: any) => frame.frameId)).toEqual(
      expect.arrayContaining(['kf0', 'kf1']),
    )
    expect(body.keyframeSizes.kf0).toEqual({ width: 1920, height: 1080 })
    expect(body.instructions.join(' ')).toContain('view_scan_photos')
    expect(body.next).toContain('Nothing was written')
  })

  test('falls back to the room proposal when the level has no walls', async () => {
    const client = await connect(manifest, false)
    const { isError, body } = await call(client, 'plan_scan_semantics', { scanId: 'scan_semantic' })
    expect(isError).toBeFalsy()
    expect(body.wallSource).toBe('room-proposal')
    expect(body.notes.join(' ')).toContain('Create the room first')
  })
})

describe('lift_scan_semantics', () => {
  test('lifts a door seen twice, confirms it and suggests add_door on the real wall', async () => {
    const client = await connect(manifest, true)
    const { isError, body } = await call(client, 'lift_scan_semantics', {
      scanId: 'scan_semantic',
      detections: [
        {
          frameId: 'kf0',
          label: 'door',
          kind: 'door',
          box2d: doorBox(VIEWS[0]!.pose),
          confidence: 0.9,
        },
        {
          frameId: 'kf1',
          label: 'door',
          kind: 'door',
          box2d: doorBox(VIEWS[1]!.pose),
          confidence: 0.8,
        },
        { frameId: 'kf2', label: 'sofa', kind: 'furniture', box2d: [0, 0, 5, 5], confidence: 0.5 },
      ],
    })
    expect(isError).toBeFalsy()
    expect(body.doorsAndWindows).toHaveLength(1)
    const door = body.doorsAndWindows[0]
    expect(door).toMatchObject({
      wallId: 'wall_aaaaaaaa',
      status: 'confirmed',
      viewCount: 2,
      basis: 'estimate',
    })
    expect(door.positionAlongWall).toBeCloseTo(1.45, 1)
    expect(door.width).toBeCloseTo(0.9, 1)
    expect(door.height).toBeCloseTo(2.1, 1)
    expect(body.suggestedCalls.openings[0].call).toMatchObject({
      tool: 'add_door',
      input: { wallId: 'wall_aaaaaaaa' },
    })
    expect(body.needsVerification).toBe(true)
  })

  test('never guesses: a box outside the image is listed as unlifted with a reason', async () => {
    const client = await connect(manifest, true)
    const { body } = await call(client, 'lift_scan_semantics', {
      scanId: 'scan_semantic',
      detections: [
        {
          frameId: 'kf0',
          label: 'door',
          kind: 'door',
          box2d: [5000, 5000, 5100, 5100],
          confidence: 0.9,
        },
        {
          frameId: 'missing',
          label: 'door',
          kind: 'door',
          box2d: [0, 0, 100, 100],
          confidence: 0.9,
        },
      ],
    })
    expect(body.doorsAndWindows).toEqual([])
    expect(body.unlifted.map((item: any) => item.reason).toSorted()).toEqual([
      'box_outside_image',
      'frame_not_found',
    ])
  })

  test('on proposal walls, door suggestions wait for a real room', async () => {
    const client = await connect(manifest, false)
    const { body } = await call(client, 'lift_scan_semantics', {
      scanId: 'scan_semantic',
      detections: [
        {
          frameId: 'kf0',
          label: 'door',
          kind: 'door',
          box2d: doorBox(VIEWS[0]!.pose),
          confidence: 0.9,
        },
      ],
    })
    expect(body.wallSource).toBe('room-proposal')
    expect(body.doorsAndWindows[0].status).toBe('uncertain')
    expect(body.suggestedCalls.openings[0].call).toBeNull()
  })

  test('bounds its input: more than 40 frames, or 200 detections, is refused', async () => {
    const client = await connect(manifest, true)
    const detection = (frameId: string) => ({
      frameId,
      label: 'door',
      kind: 'door',
      box2d: [0, 0, 100, 100],
      confidence: 0.5,
    })
    const manyFrames = await call(client, 'lift_scan_semantics', {
      scanId: 'scan_semantic',
      detections: Array.from({ length: 41 }, (_, index) => detection(`f${index}`)),
    })
    expect(manyFrames.isError).toBe(true)
    expect(manyFrames.body.code).toBe('too_many_frames')
    const tooMany = await client
      .callTool({
        name: 'lift_scan_semantics',
        arguments: {
          scanId: 'scan_semantic',
          detections: Array.from({ length: 201 }, () => detection('kf0')),
        },
      })
      .catch((error: unknown) => ({ isError: true, error }))
    expect((tooMany as { isError?: boolean }).isError).toBe(true)
  })
})
