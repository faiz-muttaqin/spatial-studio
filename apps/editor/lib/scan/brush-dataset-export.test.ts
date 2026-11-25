import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { BrushExportError, exportBrushDataset } from './brush-dataset-export'
import { crc32 } from './zip-store'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function memoryHost(files: Map<string, Uint8Array>) {
  return {
    read: async (hash: string) => files.get(hash) ?? null,
    size: async (hash: string) => files.get(hash)?.length ?? null,
  }
}

/** Reads a stored zip through its central directory and checks every CRC. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const out = new Map<string, Uint8Array>()
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const offset = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    expect(view.getUint32(offset, true)).toBe(0x04034b50)
    const dataStart =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true)
    const data = bytes.slice(dataStart, dataStart + size)
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return out
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function bundle(options: { dropImage?: boolean } = {}) {
  const files = new Map<string, Uint8Array>()
  const put = (bytes: Uint8Array) => {
    const hash = sha(bytes)
    files.set(hash, bytes)
    return hash
  }
  const images = [new Uint8Array([0xff, 0xd8, 0xff, 1]), new Uint8Array([0xff, 0xd8, 0xff, 2])]
  const hashes = images.map(put)
  if (options.dropImage) files.delete(hashes[1]!)
  const pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1.5, 2, 1]
  const frame = (id: string, hash: string) => ({
    id,
    timestamp: 1,
    image: { uri: `/api/artifacts/${hash}`, sha256: hash },
    width: 1920,
    height: 1080,
    intrinsics: { fx: 1500, fy: 1500, cx: 960, cy: 540 },
    pose,
    trackingState: 'tracking',
  })
  const rgb = put(json({ frames: [frame('k1', hashes[0]!), frame('k2', hashes[1]!)] }))
  const cloud = put(
    json({
      coordinateSystem: 'arcore-world',
      positions: [0, 1, -2, 1, 1, -2],
      colors: [1, 0, 0, 0, 1, 0],
    }),
  )
  const manifest = put(
    json({
      schemaVersion: 2,
      sessionId: 'capture_x',
      state: 'ready',
      coordinateFrames: [{ id: 'world', convention: 'arcore-world' }],
      streams: [
        {
          id: 'photos',
          kind: 'rgb-keyframes',
          role: 'photos',
          frameId: 'world',
          artifact: {
            id: 'p',
            mediaType: 'application/json',
            uri: `/api/artifacts/${rgb}`,
            sha256: rgb,
          },
        },
        {
          id: 'cloud',
          kind: 'point-cloud',
          role: 'pointCloud',
          frameId: 'world',
          artifact: {
            id: 'c',
            mediaType: 'application/json',
            uri: `/api/artifacts/${cloud}`,
            sha256: cloud,
          },
        },
      ],
    }),
  )
  const node = {
    id: 'scan_1',
    type: 'scan',
    captureSession: { manifestUrl: `/api/artifacts/${manifest}` },
  }
  return { files, node, hashes, images }
}

describe('exportBrushDataset', () => {
  test('zips images, transforms.json and points.ply that agree with each other', async () => {
    const { files, node, images } = bundle()
    const result = await exportBrushDataset(node, memoryHost(files))
    expect(result.frames).toBe(2)
    expect(result.pointCount).toBe(2)
    const zip = unzip(await collect(result.stream))
    expect([...zip.keys()].sort()).toEqual([
      'images/k1.jpg',
      'images/k2.jpg',
      'points.ply',
      'transforms.json',
    ])
    expect(zip.get('images/k1.jpg')).toEqual(images[0]!)
    const transforms = JSON.parse(new TextDecoder().decode(zip.get('transforms.json')))
    expect(transforms.ply_file_path).toBe('points.ply')
    expect(transforms.frames.map((frame: { file_path: string }) => frame.file_path)).toEqual([
      'images/k1.jpg',
      'images/k2.jpg',
    ])
    expect(transforms.frames[0].transform_matrix[0]).toEqual([1, 0, 0, 0.5])
    expect(transforms.frames[0].transform_matrix[2]).toEqual([0, 0, 1, 2])
    expect(new TextDecoder().decode(zip.get('points.ply')!.slice(0, 60))).toContain(
      'element vertex 2',
    )
  })

  test('lists a keyframe whose image is missing instead of naming it in transforms.json', async () => {
    const { files, node } = bundle({ dropImage: true })
    const result = await exportBrushDataset(node, memoryHost(files))
    expect(result.frames).toBe(1)
    expect(result.skipped).toEqual([{ keyframeId: 'k2', reason: 'image-missing' }])
    const zip = unzip(await collect(result.stream))
    expect(zip.has('images/k2.jpg')).toBe(false)
  })

  test('names an image by its real type and lists one that is not an image', async () => {
    const { files, node, hashes } = bundle()
    files.set(hashes[0]!, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]))
    files.set(hashes[1]!, new TextEncoder().encode('not an image'))
    const result = await exportBrushDataset(node, memoryHost(files))
    expect(result.skipped).toEqual([{ keyframeId: 'k2', reason: 'image-unsupported' }])
    const zip = unzip(await collect(result.stream))
    expect(zip.has('images/k1.png')).toBe(true)
  })

  test('errors the stream when an image vanishes after the check', async () => {
    const { files, node, hashes } = bundle()
    const host = memoryHost(files)
    let reads = 0
    const flaky = {
      size: host.size,
      read: async (hash: string) => {
        if (hash === hashes[1]) reads += 1
        return reads > 1 ? null : host.read(hash)
      },
    }
    const result = await exportBrushDataset(node, flaky)
    await expect(collect(result.stream)).rejects.toThrow('disappeared')
  })

  test('refuses a node that is not a scan, has no manifest, or whose manifest is not stored', async () => {
    const { files, node } = bundle()
    const host = memoryHost(files)
    await expect(exportBrushDataset({ id: 'x', type: 'wall' }, host)).rejects.toBeInstanceOf(
      BrushExportError,
    )
    await expect(
      exportBrushDataset({ id: 'x', type: 'scan', captureSession: null }, host),
    ).rejects.toMatchObject({ code: 'no_capture' })
    await expect(
      exportBrushDataset(
        { ...node, captureSession: { manifestUrl: `/api/artifacts/${'0'.repeat(64)}` } },
        host,
      ),
    ).rejects.toMatchObject({ code: 'manifest_unreadable' })
  })
})
