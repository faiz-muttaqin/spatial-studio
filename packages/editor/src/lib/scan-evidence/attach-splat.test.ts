import { describe, expect, test } from 'bun:test'
import { attachSplatToManifest, SplatAttachError } from './attach-splat'

function splatPly(): Uint8Array {
  const names = [
    'x',
    'y',
    'z',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
  ]
  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex 1\n${names.map((name) => `property float ${name}`).join('\n')}\nend_header\n`,
  )
  const bytes = new Uint8Array(header.length + names.length * 4)
  bytes.set(header, 0)
  return bytes
}

const MANIFEST_SHA = 'a'.repeat(64)
const manifest = {
  schemaVersion: 2,
  sessionId: 'capture_1',
  state: 'ready',
  coordinateFrames: [{ id: 'world', convention: 'arcore-world' }],
  streams: [{ id: 'photos', kind: 'rgb-keyframes', role: 'photos', frameId: 'world' }],
}

function fakeFetch() {
  const puts: Array<{ url: string; headers: Record<string, string>; size: number }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = init.body as Blob | Uint8Array
      puts.push({
        url,
        headers: init.headers as Record<string, string>,
        size: body instanceof Blob ? body.size : body.length,
      })
      return new Response('{}', { status: 200 })
    }
    return new Response(JSON.stringify(manifest), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, puts }
}

describe('attachSplatToManifest', () => {
  test('stores the splat with its size header, then a manifest naming it', async () => {
    const { fetchImpl, puts } = fakeFetch()
    const result = await attachSplatToManifest(
      new Blob([splatPly() as BlobPart]),
      `/api/artifacts/${MANIFEST_SHA}`,
      { fetchImpl },
    )
    expect(puts).toHaveLength(2)
    expect(puts[0]!.headers['X-Artifact-Kind']).toBe('gaussian-splat')
    expect(puts[1]!.url).toBe(result.manifestUrl)
    expect(result).toMatchObject({ splatCount: 1, shDegree: 0 })
    expect(result.manifestUrl).toMatch(/^\/api\/artifacts\/[0-9a-f]{64}$/)
    expect(result.manifestUrl).not.toContain(MANIFEST_SHA)
  })

  test('refuses a file that is not a splat before uploading anything', async () => {
    const { fetchImpl, puts } = fakeFetch()
    await expect(
      attachSplatToManifest(new Blob(['hello']), `/api/artifacts/${MANIFEST_SHA}`, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'invalid_file' })
    expect(puts).toHaveLength(0)
  })

  test('refuses a manifest URL outside the artifact store', async () => {
    const { fetchImpl } = fakeFetch()
    await expect(
      attachSplatToManifest(new Blob([splatPly() as BlobPart]), '/somewhere/else', { fetchImpl }),
    ).rejects.toBeInstanceOf(SplatAttachError)
  })
})
