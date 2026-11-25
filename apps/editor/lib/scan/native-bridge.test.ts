import { describe, expect, test } from 'bun:test'
import {
  BridgeError,
  createNativeBridgeClient,
  findNativeBridge,
  isUploadProgressFor,
  type NativeBridgeTransport,
} from './native-bridge'

const manifestSha = 'c'.repeat(64)

type Sent = { v: number; id: string; method: string; params?: Record<string, unknown> }

/** Stands in for the companion: records requests and lets the test answer them. */
class FakeBridge implements NativeBridgeTransport {
  readonly sent: Sent[] = []
  private listeners = new Set<(event: { data: unknown }) => void>()
  onRequest?: (request: Sent) => void

  postMessage(message: string) {
    const request = JSON.parse(message) as Sent
    this.sent.push(request)
    this.onRequest?.(request)
  }

  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
    this.listeners.delete(listener)
  }

  get listenerCount() {
    return this.listeners.size
  }

  emit(value: unknown) {
    const data = typeof value === 'string' ? value : JSON.stringify(value)
    for (const listener of this.listeners) listener({ data })
  }

  reply(id: string, result: unknown) {
    this.emit({ v: 1, id, ok: true, result })
  }

  fail(id: string, code: string, message = 'failed') {
    this.emit({ v: 1, id, ok: false, error: { code, message } })
  }
}

function sequentialIds() {
  let next = 0
  return () => `req-${++next}`
}

const capabilities = {
  arcore: { availability: 'SUPPORTED_INSTALLED', depth: true, rawDepth: true },
  cameras: [],
  sensors: { accelerometer: true },
  device: { manufacturer: 'Test', model: 'Synthetic', sdkInt: 35, webViewVersion: null },
}

describe('native bridge client', () => {
  test('sends v1 requests with unique ids and resolves typed replies', async () => {
    const bridge = new FakeBridge()
    bridge.onRequest = (request) => {
      if (request.method === 'bridge.hello') {
        bridge.reply(request.id, {
          bridgeVersion: 1,
          appVersion: '0.0.1',
          platform: 'android',
          methods: ['bridge.hello', 'capabilities.get'],
        })
      }
      if (request.method === 'capabilities.get') bridge.reply(request.id, capabilities)
    }
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })

    const [hello, caps] = await Promise.all([client.hello(), client.capabilities()])

    expect(bridge.sent).toEqual([
      { v: 1, id: 'req-1', method: 'bridge.hello' },
      { v: 1, id: 'req-2', method: 'capabilities.get' },
    ])
    expect(hello.methods).toContain('capabilities.get')
    expect(caps.arcore.depth).toBe(true)
  })

  test('maps contract error codes and rejects unknown ones as internal', async () => {
    const bridge = new FakeBridge()
    bridge.onRequest = (request) =>
      bridge.fail(request.id, request.method === 'scan.start' ? 'permission_denied' : 'weird')
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })

    const denied = await client.startScan().catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(BridgeError)
    expect((denied as BridgeError).code).toBe('permission_denied')

    const other = await client.listScans().catch((error: unknown) => error)
    expect((other as BridgeError).code).toBe('internal')
  })

  test('times out when the companion never answers', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge, { timeoutMs: 20, newId: sequentialIds() })
    const error = await client.request('bridge.hello').catch((cause: unknown) => cause)
    expect((error as BridgeError).code).toBe('timeout')
    // A late reply for a timed-out request is ignored.
    bridge.reply('req-1', {})
  })

  test('rejects replies that do not match the method contract', async () => {
    const bridge = new FakeBridge()
    bridge.onRequest = (request) =>
      bridge.reply(request.id, { sessionId: 's1', manifestUrl: 'https://evil.test/x' })
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })
    const error = await client.uploadScan('s1').catch((cause: unknown) => cause)
    expect((error as BridgeError).code).toBe('invalid_reply')
  })

  test('runs the native flow: start, follow events, upload, receive manifestUrl', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })
    const seen: string[] = []
    const unsubscribe = client.subscribe('*', (event) => seen.push(event.event))
    const progressOnly: unknown[] = []
    client.subscribe('upload.progress', (event) => progressOnly.push(event.data))

    bridge.onRequest = (request) => {
      if (request.method === 'scan.start') {
        expect(request.params).toEqual({ projectId: 'p1', options: { depth: true } })
        bridge.reply(request.id, { sessionId: 'scan-1' })
        bridge.emit({ v: 1, event: 'scan.state', data: { sessionId: 'scan-1', state: 'scanning' } })
        bridge.emit({ v: 1, event: 'scan.progress', data: { sessionId: 'scan-1', keyframes: 12 } })
      }
      if (request.method === 'scan.upload') {
        bridge.emit({
          v: 1,
          event: 'upload.progress',
          data: { sessionId: 'scan-1', uploaded: 1, total: 2 },
        })
        bridge.reply(request.id, {
          sessionId: 'scan-1',
          manifestUrl: `/api/artifacts/${manifestSha}`,
          manifestSha256: manifestSha,
        })
      }
    }

    const { sessionId } = await client.startScan({
      projectId: 'p1',
      options: { depth: true, maxKeyframes: undefined },
    })
    const upload = await client.uploadScan(sessionId)

    expect(upload.manifestUrl).toBe(`/api/artifacts/${manifestSha}`)
    expect(seen).toEqual(['scan.state', 'scan.progress', 'upload.progress'])
    expect(progressOnly).toEqual([{ sessionId: 'scan-1', uploaded: 1, total: 2 }])
    unsubscribe()
    bridge.emit({ v: 1, event: 'scan.state', data: {} })
    expect(seen).toHaveLength(3)
  })

  test('scan.start passes the sensor and location opt-ins unchanged', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })
    let params: unknown
    bridge.onRequest = (request) => {
      params = request.params
      bridge.reply(request.id, { sessionId: 'scan-1' })
    }
    await client.startScan({
      projectId: 'p1',
      options: { depth: true, location: true, sensors: false },
    })
    expect(params).toEqual({
      projectId: 'p1',
      options: { depth: true, location: true, sensors: false },
    })
  })

  test('progress of the uploading session keeps a long upload alive past the idle timeout', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })
    const result = client.request(
      'scan.upload',
      { sessionId: 's' },
      { timeoutMs: 30, keepAlive: isUploadProgressFor('s') },
    )
    for (let step = 0; step < 4; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      bridge.emit({ v: 1, event: 'upload.progress', data: { sessionId: 's', step } })
    }
    bridge.reply('req-1', { ok: 'done' })
    expect(await result).toEqual({ ok: 'done' })
  })

  test("another session's progress, or progress without a session, does not extend it", async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })
    const result = client
      .request(
        'scan.upload',
        { sessionId: 's' },
        { timeoutMs: 30, keepAlive: isUploadProgressFor('s') },
      )
      .catch((cause: unknown) => cause)
    for (let step = 0; step < 4; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      bridge.emit({
        v: 1,
        event: 'upload.progress',
        data: step % 2 ? { sessionId: 'other' } : { step },
      })
    }
    expect(((await result) as BridgeError).code).toBe('timeout')
  })

  test('ignores malformed, foreign-version and unknown-id messages', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge, { timeoutMs: 30, newId: sequentialIds() })
    const events: unknown[] = []
    client.subscribe('*', (event) => events.push(event))
    const pending = client.request('bridge.hello')
    bridge.emit('not json')
    bridge.emit({ v: 2, id: 'req-1', ok: true, result: {} })
    bridge.emit({ v: 1, id: 'other', ok: true, result: {} })
    bridge.emit({ v: 1, event: 'unknown.event', data: {} })
    bridge.emit(`{"v":1,"event":"scan.state","data":"${'x'.repeat(70_000)}"}`)
    expect(events).toEqual([])
    expect(((await pending.catch((e: unknown) => e)) as BridgeError).code).toBe('timeout')
  })

  test('refuses requests over 64 KiB without posting them', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge)
    const error = await client
      .request('scan.start', { blob: 'x'.repeat(70_000) })
      .catch((cause: unknown) => cause)
    expect((error as BridgeError).code).toBe('too_large')
    expect(bridge.sent).toHaveLength(0)
  })

  test('cancels through an abort signal', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge)
    const controller = new AbortController()
    const pending = client.request('scan.list', undefined, { signal: controller.signal })
    controller.abort()
    expect(((await pending.catch((e: unknown) => e)) as BridgeError).code).toBe('cancelled')
  })

  test('dispose rejects pending requests and detaches the listener', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge)
    const pending = client.request('scan.list')
    expect(bridge.listenerCount).toBe(1)
    client.dispose()
    expect(((await pending.catch((e: unknown) => e)) as BridgeError).code).toBe('disposed')
    expect(bridge.listenerCount).toBe(0)
    expect(((await client.hello().catch((e: unknown) => e)) as BridgeError).code).toBe('disposed')
  })

  test('falls back to onmessage when the injected object has no addEventListener', async () => {
    const sent: string[] = []
    const transport: NativeBridgeTransport = {
      postMessage(message) {
        sent.push(message)
        const { id } = JSON.parse(message) as { id: string }
        transport.onmessage?.({ data: JSON.stringify({ v: 1, id, ok: true, result: [] }) })
      },
      onmessage: null,
    }
    const client = createNativeBridgeClient(transport)
    expect(await client.listScans()).toEqual([])
    client.dispose()
    expect(transport.onmessage).toBeNull()
  })
})

describe('uploaded scans in scan.list', () => {
  test('carries the manifest url of an uploaded scan and the upload.done event is accepted', async () => {
    const bridge = new FakeBridge()
    const client = createNativeBridgeClient(bridge, { newId: sequentialIds() })
    const done: unknown[] = []
    client.subscribe('upload.done', (event) => done.push(event.data))
    bridge.onRequest = (request) => {
      bridge.reply(request.id, [
        {
          sessionId: 's1',
          createdAt: '2026-11-25T00:00:00Z',
          state: 'ready',
          keyframes: 84,
          bytes: 1,
          uploaded: true,
          manifestUrl: `/api/artifacts/${manifestSha}`,
        },
      ])
      bridge.emit({ v: 1, event: 'upload.done', data: { sessionId: 's1' } })
    }
    const [entry] = await client.listScans()
    expect(entry?.manifestUrl).toBe(`/api/artifacts/${manifestSha}`)
    expect(done).toEqual([{ sessionId: 's1' }])
  })
})

describe('findNativeBridge', () => {
  test('finds only an object with postMessage', () => {
    expect(findNativeBridge({})).toBeNull()
    expect(findNativeBridge({ SpatialStudioNative: { postMessage: 1 } })).toBeNull()
    const bridge = { postMessage() {} }
    expect(findNativeBridge({ SpatialStudioNative: bridge })).toBe(bridge)
  })
})
