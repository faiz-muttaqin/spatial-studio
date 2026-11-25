/**
 * Dev fixture: uploads a synthetic Android-style scan bundle (a 4 x 3 x 2.5 m room) to a running
 * editor and attaches it as a `scan` node. No real capture data is involved.
 *
 *   bun scripts/dev-synthetic-scan.ts --origin http://localhost:3000 [--project <id>] [--keyframes 6]
 *
 * Auth: loopback dev servers are open; otherwise set PASCAL_SCENE_API_TOKEN. JPEGs are encoded
 * with `sharp`, which Next.js already installs (not a dependency of this repo).
 */
import { createHash } from 'node:crypto'
import {
  attachScanToProject,
  createProjectWithScan,
  newSceneId,
} from '../apps/editor/lib/scan/attach'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set((process.argv[i] ?? '').replace(/^--/, ''), process.argv[i + 1] ?? '')
}
const origin = (args.get('origin') ?? 'http://localhost:3000').replace(/\/$/, '')
const keyframeCount = Math.min(300, Number(args.get('keyframes') ?? 6))
const token = process.env.PASCAL_SCENE_API_TOKEN
const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

const W = 4
const L = 3
const H = 2.5
const EYE = 1.4 // camera height above the floor; the session origin is the start pose
const FLOOR_Y = -EYE
const CEIL_Y = H - EYE

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function put(bytes: Uint8Array): Promise<string> {
  const hash = sha256(bytes)
  const response = await fetch(`${origin}/api/artifacts/${hash}`, {
    body: bytes as BodyInit,
    headers,
    method: 'PUT',
  })
  if (!response.ok) throw new Error(`PUT ${hash} failed (${response.status})`)
  return hash
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

async function jsonArtifact(value: unknown) {
  const bytes = json(value)
  const hash = await put(bytes)
  return {
    id: hash,
    mediaType: 'application/json',
    byteLength: bytes.byteLength,
    sha256: hash,
    uri: `/api/artifacts/${hash}`,
  }
}

function lookMatrix(x: number, z: number, yaw: number): number[] {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  // Column-major camera-to-world, Y up, rotation about Y.
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0, z, 1]
}

// Walk the room perimeter, looking inward.
const samples = Array.from({ length: 60 }, (_, i) => {
  const t = i / 60
  const angle = t * Math.PI * 2
  const x = Math.cos(angle) * (W / 2 - 0.5)
  const z = Math.sin(angle) * (L / 2 - 0.5)
  return { segment: 0, timestamp: i * 0.5e9, transform: lookMatrix(x, z, -angle - Math.PI / 2) }
})

const positions: number[] = []
const step = 0.08
for (let x = -W / 2; x <= W / 2; x += step) {
  for (let z = -L / 2; z <= L / 2; z += step) positions.push(x, FLOOR_Y, z)
  for (let y = FLOOR_Y; y <= CEIL_Y; y += step) positions.push(x, y, -L / 2, x, y, L / 2)
}
for (let z = -L / 2; z <= L / 2; z += step) {
  for (let y = FLOOR_Y; y <= CEIL_Y; y += step) positions.push(-W / 2, y, z, W / 2, y, z)
}

const plane = (
  id: string,
  orientation: string,
  x: number,
  y: number,
  z: number,
  ex: number,
  ez: number,
  subsumedBy: string | null = null,
) => ({
  id,
  orientation,
  centerPose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  extent: [ex, ez],
  polygon: [
    [-ex / 2, -ez / 2],
    [ex / 2, -ez / 2],
    [ex / 2, ez / 2],
    [-ex / 2, ez / 2],
  ],
  subsumedBy,
})

async function keyframes() {
  const sharp = (await import('sharp')).default
  const frames = []
  for (let i = 0; i < keyframeCount; i += 1) {
    const [w, h] = [320, 240]
    const raw = Buffer.alloc(w * h * 3)
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 3
        raw[o] = (x * 255) / w
        raw[o + 1] = (y * 255) / h
        raw[o + 2] = (i * 255) / Math.max(1, keyframeCount - 1)
      }
    }
    const jpeg = new Uint8Array(
      await sharp(raw, { raw: { channels: 3, height: h, width: w } })
        .jpeg({ quality: 70 })
        .toBuffer(),
    )
    const hash = await put(jpeg)
    frames.push({
      id: `kf-${i}`,
      timestamp: i * 1.5e9,
      image: { uri: `/api/artifacts/${hash}`, sha256: hash },
      width: w,
      height: h,
      intrinsics: { fx: 280, fy: 280, cx: w / 2, cy: h / 2 },
      pose: samples[(i * 10) % samples.length]?.transform ?? null,
      trackingState: i === 3 ? 'paused' : 'tracking',
    })
  }
  return { frames }
}

const sessionId = `synthetic-${Date.now().toString(36)}`
const cloud = await jsonArtifact({ coordinateSystem: 'arcore-world', positions })
const planes = await jsonArtifact({
  planes: [
    plane('floor-a', 'horizontal-up', 0, FLOOR_Y, 0, W, L),
    plane('floor-b', 'horizontal-up', 0.5, FLOOR_Y, 0, 1, 1, 'floor-a'),
    plane('ceiling', 'horizontal-down', 0, CEIL_Y, 0, W, L),
    plane('wall-n', 'vertical', 0, 0, -L / 2, W, H),
    plane('wall-s', 'vertical', 0, 0, L / 2, W, H),
    plane('wall-e', 'vertical', W / 2, 0, 0, L, H),
    plane('wall-w', 'vertical', -W / 2, 0, 0, L, H),
  ],
})
const measurements = await jsonArtifact({
  units: 'm',
  room: { width: W, length: L, height: H },
  openings: [
    { kind: 'door', wall: 'south', width: 0.9, height: 2.1, sill: 0 },
    { kind: 'window', wall: 'east', width: 1.2, height: 1.1, sill: 0.9 },
  ],
  notes: 'Synthetic fixture room.',
  source: 'manual',
})
const photos = await jsonArtifact(await keyframes())

const manifest = {
  schemaVersion: 2,
  sessionId,
  state: 'ready',
  clocks: [{ id: 'device', timebase: 'nanoseconds' }],
  coordinateFrames: [{ id: 'world', convention: 'arcore-world' }],
  streams: [
    {
      id: 'device-motion',
      kind: 'device-motion',
      role: 'deviceMotion',
      availability: 'ready',
      frameId: 'world',
      clockId: 'device',
      inline: { coordinateSystem: 'arcore-world', samples },
    },
    {
      id: 'point-cloud',
      kind: 'point-cloud',
      role: 'pointCloud',
      availability: 'ready',
      frameId: 'world',
      artifact: cloud,
    },
    {
      id: 'rgb-keyframes',
      kind: 'rgb-keyframes',
      role: 'photos',
      availability: 'ready',
      frameId: 'world',
      artifact: photos,
    },
    {
      id: 'plane-set',
      kind: 'plane-set',
      role: 'planes',
      availability: 'ready',
      frameId: 'world',
      artifact: planes,
    },
    {
      id: 'manual-measurements',
      kind: 'manual-measurements',
      role: 'measurements',
      availability: 'ready',
      artifact: measurements,
    },
  ],
  metadata: {
    provider: 'android-arcore',
    appVersion: 'synthetic',
    device: { manufacturer: 'Synthetic', model: 'Fixture 1', os: 'Android' },
    createdAt: new Date().toISOString(),
    trackingLossCount: 1,
    warnings: ['Synthetic bundle: not a real capture.'],
    camera: { convention: 'opengl', frame: 'image-readout', sensorOrientationDeg: 90 },
  },
}
const manifestBytes = json(manifest)
const manifestHash = await put(manifestBytes)
const attachment = {
  name: 'Synthetic room scan',
  sessionId,
  manifestUrl: `/api/artifacts/${manifestHash}`,
}

// The attach helpers use relative URLs; point them at the target origin.
const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetch(`${origin}${String(input)}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), ...headers },
  })) as typeof fetch

const project = args.get('project')
const result = project
  ? await attachScanToProject(project, attachment, { fetchImpl })
  : await createProjectWithScan('Synthetic scan fixture', attachment, {
      fetchImpl,
      sceneId: newSceneId(),
    })
console.log(
  JSON.stringify(
    {
      manifestUrl: attachment.manifestUrl,
      project: `${origin}/project/${result.sceneId}`,
      scanId: result.scanId,
    },
    null,
    2,
  ),
)
