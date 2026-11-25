import { describe, expect, test } from 'bun:test'
import {
  ArtifactError,
  artifactUri,
  prepareArtifact,
  sha256Hex,
  uploadArtifacts,
} from './artifacts'

type Call = { url: string; method?: string; contentType?: string; body?: BodyInit | null }

function fakeFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get('Content-Type') ?? undefined,
      body: init?.body,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('artifacts', () => {
  test('hashes with WebCrypto (known SHA-256 vector)', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  test('prepares strings, bytes and blobs with their media type', async () => {
    const fromString = await prepareArtifact('abc', 'application/json')
    const fromBlob = await prepareArtifact(new Blob(['abc']), 'image/jpeg')
    expect(fromString.sha256).toBe(fromBlob.sha256)
    expect(fromString.byteLength).toBe(3)
    expect(fromBlob.body.type).toBe('image/jpeg')
    expect(artifactUri(fromString.sha256)).toBe(`/api/artifacts/${fromString.sha256}`)
  })

  test('refuses artifacts over 16 MB', async () => {
    const error = await prepareArtifact(new Uint8Array(16 * 1024 * 1024 + 1), 'image/jpeg').catch(
      (cause: unknown) => cause,
    )
    expect((error as ArtifactError).code).toBe('too_large')
  })

  test('PUTs each distinct artifact once with its content type and reports progress', async () => {
    const a = await prepareArtifact('a', 'image/jpeg')
    const b = await prepareArtifact('b', 'application/json')
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ ok: true }))
    const progress: number[] = []
    const stored: string[] = []
    await uploadArtifacts([a, b, a], {
      fetchImpl,
      onProgress: (value) => progress.push(value.done),
      onStored: (sha256) => stored.push(sha256),
    })
    expect(stored.sort()).toEqual([a.sha256, b.sha256].sort())
    expect(calls.map((call) => [call.method, call.url, call.contentType]).sort()).toEqual(
      [
        ['PUT', `/api/artifacts/${a.sha256}`, 'image/jpeg'],
        ['PUT', `/api/artifacts/${b.sha256}`, 'application/json'],
      ].sort(),
    )
    expect(progress).toEqual([0, 1, 2])
  })

  test('waits for Retry-After on 429 and retries', async () => {
    const a = await prepareArtifact('a', 'image/jpeg')
    const waits: number[] = []
    const { calls, fetchImpl } = fakeFetch((_, index) =>
      index === 0
        ? new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Retry-After': '2' },
          })
        : Response.json({ sha256: a.sha256 }),
    )
    await uploadArtifacts([a], {
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(calls).toHaveLength(2)
    expect(waits).toEqual([2000])
  })

  test('surfaces the API error and stops starting new uploads', async () => {
    const artifacts = await Promise.all(
      ['a', 'b', 'c', 'd'].map((value) => prepareArtifact(value, 'image/jpeg')),
    )
    const { calls, fetchImpl } = fakeFetch(() =>
      Response.json({ error: 'hash_mismatch' }, { status: 400 }),
    )
    const error = await uploadArtifacts(artifacts, { fetchImpl, concurrency: 1 }).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(ArtifactError)
    expect((error as ArtifactError).message).toBe('hash_mismatch')
    expect(calls).toHaveLength(1)
  })
})
