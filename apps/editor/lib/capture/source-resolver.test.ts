import { describe, expect, it } from 'bun:test'
import { createCaptureSourceResolver } from './source-resolver'

const origin = 'https://studio.example.test'
const sha = 'b'.repeat(64)

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    sessionId: 'session-1',
    streams: [
      {
        id: 'points',
        kind: 'point-cloud',
        role: 'pointCloud',
        artifact: {
          id: 'points-artifact',
          mediaType: 'application/json',
          uri: `/api/artifacts/${sha}`,
        },
      },
    ],
    ...overrides,
  }
}

function fetchStub(body: unknown, calls: Array<{ url: string; init?: RequestInit }> = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

describe('createCaptureSourceResolver', () => {
  it('fetches the manifest with same-origin credentials and resolves artifacts against it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const resolve = createCaptureSourceResolver({ fetch: fetchStub(manifest(), calls), origin })
    const source = await resolve({
      sessionId: 'session-1',
      manifestUrl: `/api/artifacts/${'c'.repeat(64)}`,
    })
    const descriptor = await source.describe()
    expect(calls[0]?.url).toBe(`${origin}/api/artifacts/${'c'.repeat(64)}`)
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    const artifact = descriptor.streams[0]?.artifact
    expect(artifact).toBeDefined()
    const resolved = await source.resolveArtifact?.(artifact as never)
    expect(resolved?.url).toBe(`${origin}/api/artifacts/${sha}`)
  })

  it('shares one source (and one manifest fetch) per session', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const resolve = createCaptureSourceResolver({ fetch: fetchStub(manifest(), calls), origin })
    const locator = { sessionId: 'session-1', manifestUrl: `/api/artifacts/${sha}` }
    const first = await resolve(locator)
    const second = await resolve({ ...locator })
    expect(second).toBe(first)
    await first.describe()
    await second.describe()
    expect(calls).toHaveLength(1)
  })

  it('refuses a manifest on another origin', () => {
    const resolve = createCaptureSourceResolver({ fetch: fetchStub(manifest()), origin })
    expect(() =>
      resolve({ sessionId: 'session-1', manifestUrl: 'https://evil.example.test/m.json' }),
    ).toThrow('this origin')
  })

  it('refuses an artifact URI that leaves the origin, and one that is missing', async () => {
    const resolve = createCaptureSourceResolver({ fetch: fetchStub(manifest()), origin })
    const source = await resolve({ sessionId: 'session-1', manifestUrl: `/api/artifacts/${sha}` })
    await expect(
      source.resolveArtifact?.({
        id: 'x',
        mediaType: 'image/jpeg',
        uri: 'https://evil.example.test/a.jpg',
      }),
    ).rejects.toThrow('this origin')
    await expect(
      source.resolveArtifact?.({
        id: 'x',
        mediaType: 'image/jpeg',
        uri: '//evil.example.test/a.jpg',
      }),
    ).rejects.toThrow('this origin')
    await expect(source.resolveArtifact?.({ id: 'x', mediaType: 'image/jpeg' })).rejects.toThrow(
      'no URI',
    )
  })

  it('needs a manifest URL and does not cache a failed manifest', async () => {
    let attempts = 0
    const flaky = (async () => {
      attempts += 1
      return attempts === 1
        ? new Response('no', { status: 503 })
        : new Response(JSON.stringify(manifest()), { status: 200 })
    }) as unknown as typeof fetch
    const resolve = createCaptureSourceResolver({ fetch: flaky, origin })
    expect(() => resolve({ sessionId: 'session-1' })).toThrow('no manifest URL')
    const source = await resolve({ sessionId: 'session-1', manifestUrl: `/api/artifacts/${sha}` })
    await expect(source.describe()).rejects.toThrow('unavailable')
    expect((await source.describe()).sessionId).toBe('session-1')
  })
})
