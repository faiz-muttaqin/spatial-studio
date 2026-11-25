import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ARTIFACT_BYTES, readBodyWithin } from './artifact-upload-limit'

function streamedRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Request('http://127.0.0.1:3000/x', {
    method: 'PUT',
    headers,
    body,
    duplex: 'half',
  } as RequestInit)
}

describe('readBodyWithin', () => {
  test('returns the whole body when it fits', async () => {
    const bytes = await readBodyWithin(
      streamedRequest([new Uint8Array([1, 2]), new Uint8Array([3])]),
      3,
    )
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('with an honest Content-Length the body fills one buffer; a liar is cut off or trimmed', async () => {
    const honest = streamedRequest([new Uint8Array([1, 2]), new Uint8Array([3])], {
      'content-length': '3',
    })
    expect(await readBodyWithin(honest, 10)).toEqual(new Uint8Array([1, 2, 3]))
    const longer = streamedRequest([new Uint8Array(6)], { 'content-length': '3' })
    expect(await readBodyWithin(longer, 10)).toBeNull()
    const shorter = streamedRequest([new Uint8Array([9])], { 'content-length': '3' })
    expect(await readBodyWithin(shorter, 10)).toEqual(new Uint8Array([9]))
  })

  test('refuses a declared Content-Length over the limit without reading', async () => {
    const request = streamedRequest([new Uint8Array(11)], { 'content-length': '11' })
    expect(await readBodyWithin(request, 10)).toBeNull()
    expect(request.bodyUsed).toBe(false)
  })

  test('stops a body that runs past the limit without a truthful Content-Length', async () => {
    const chunk = new Uint8Array(6)
    expect(await readBodyWithin(streamedRequest([chunk, chunk]), 10)).toBeNull()
    expect(
      await readBodyWithin(streamedRequest([chunk, chunk], { 'content-length': '4' }), 10),
    ).toBeNull()
  })

  test('an empty body is zero bytes', async () => {
    const request = new Request('http://127.0.0.1:3000/x', { method: 'PUT' })
    expect(await readBodyWithin(request, 10)).toEqual(new Uint8Array(0))
  })
})

describe('PUT /api/artifacts/{sha256}', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'artifact-limit-'))
  const saved = {
    PASCAL_DB_PATH: process.env.PASCAL_DB_PATH,
    PASCAL_SCENE_API_TOKEN: process.env.PASCAL_SCENE_API_TOKEN,
  }
  let PUT: typeof import('../app/api/artifacts/[sha256]/route')['PUT']

  beforeAll(async () => {
    process.env.PASCAL_DB_PATH = join(tempDir, 'pascal.db')
    delete process.env.PASCAL_SCENE_API_TOKEN // loopback requests need no token
    PUT = (await import('../app/api/artifacts/[sha256]/route')).PUT
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  const put = (bytes: Uint8Array) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const request = new Request(`http://127.0.0.1:3000/api/artifacts/${sha256}`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:3000', 'content-type': 'application/octet-stream' },
      body: bytes as BodyInit,
    })
    return { sha256, response: PUT(request, { params: Promise.resolve({ sha256 }) }) }
  }

  test('stores an artifact at the limit', async () => {
    const { sha256, response } = put(new Uint8Array(MAX_ARTIFACT_BYTES))
    expect((await response).status).toBe(200)
    expect(existsSync(join(`${join(tempDir, 'pascal.db')}.artifacts`))).toBe(true)
    expect(((await (await response).json()) as { sha256: string }).sha256).toBe(sha256)
  })

  test('answers 413 one byte over the limit and stores nothing', async () => {
    const { response } = put(new Uint8Array(MAX_ARTIFACT_BYTES + 1))
    const result = await response
    expect(result.status).toBe(413)
    expect(await result.json()).toEqual({ error: 'too_large', maxBytes: MAX_ARTIFACT_BYTES })
  })
})
