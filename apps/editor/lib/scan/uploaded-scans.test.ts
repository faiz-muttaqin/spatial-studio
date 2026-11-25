import { describe, expect, test } from 'bun:test'
import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'
import type { ScanListEntry } from './native-bridge'
import { classifyUploadedScans, findScanNodeFor } from './uploaded-scans'

const sha = 'a'.repeat(64)
const origin = 'https://studio.example'

function entry(overrides: Partial<ScanListEntry> & { sessionId: string }): ScanListEntry {
  return {
    createdAt: '2026-11-25T10:00:00Z',
    state: 'ready',
    keyframes: 10,
    bytes: 1000,
    uploaded: true,
    manifestUrl: `/api/artifacts/${sha}`,
    ...overrides,
  } as ScanListEntry
}

function graphWithScan(captureSession: { sessionId?: string; manifestUrl?: string }): SceneGraph {
  return {
    nodes: { scan_1: { id: 'scan_1', type: 'scan', captureSession } },
    rootNodeIds: [],
  } as unknown as SceneGraph
}

/** A fake site: which manifests exist, and the projects with their graphs. */
function site(options: {
  manifests?: Record<string, number>
  scenes?: Array<{ id: string; name: string; graph: SceneGraph }>
  /** Status returned for these scene graphs instead of the graph. */
  graphStatus?: Record<string, number>
  listStatus?: number
  headStatus?: number
}): { fetchImpl: typeof fetch; urls: string[]; methods: string[] } {
  const urls: string[] = []
  const methods: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    methods.push(init?.method ?? 'GET')
    if (url.startsWith('/api/artifacts/')) {
      if (init?.method === 'HEAD' && options.headStatus) {
        return new Response(null, { status: options.headStatus })
      }
      return new Response('{}', { status: options.manifests?.[url] ?? 200 })
    }
    if (url.startsWith('/api/scenes?')) {
      if (options.listStatus) return new Response('', { status: options.listStatus })
      return Response.json({
        scenes: (options.scenes ?? []).map(({ id, name }) => ({ id, name })),
      })
    }
    const scene = options.scenes?.find((item) => url === `/api/scenes/${item.id}`)
    if (scene && options.graphStatus?.[scene.id]) {
      return new Response('', { status: options.graphStatus[scene.id] })
    }
    return scene ? Response.json({ graph: scene.graph }) : new Response('', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, urls, methods }
}

const fresh = () => new Map<string, 'present' | 'missing'>()

describe('findScanNodeFor', () => {
  test('matches the capture session or the manifest', () => {
    expect(findScanNodeFor(graphWithScan({ sessionId: 's1' }), { sessionId: 's1' })).toBe('scan_1')
    expect(
      findScanNodeFor(graphWithScan({ manifestUrl: `/api/artifacts/${sha}` }), {
        sessionId: 'other',
        manifestUrl: `/api/artifacts/${sha}`,
      }),
    ).toBe('scan_1')
    expect(findScanNodeFor(graphWithScan({ sessionId: 's1' }), { sessionId: 's2' })).toBeNull()
  })
})

describe('classifyUploadedScans', () => {
  test('every entry is verified with HEAD, whatever origin it recorded', async () => {
    const other = 'b'.repeat(64)
    const { fetchImpl, methods } = site({ manifests: { [`/api/artifacts/${other}`]: 404 } })
    const report = await classifyUploadedScans(
      [
        entry({
          sessionId: 'gone',
          manifestUrl: `/api/artifacts/${other}`,
          uploadedOrigin: origin,
        }),
        entry({ sessionId: 'here', uploadedOrigin: 'http://127.0.0.1:3002' }),
        entry({ sessionId: 'old' }),
      ],
      { fetchImpl, cache: fresh() },
    )
    expect(report.statuses.get('gone')).toEqual({ kind: 'elsewhere' })
    // A different recorded origin does not decide it: the manifest is on this site.
    expect(report.statuses.get('here')).toEqual({ kind: 'attachable' })
    expect(report.statuses.get('old')).toEqual({ kind: 'attachable' })
    expect(methods.filter((method) => method === 'HEAD').length).toBeGreaterThan(0)
  })

  test('only same-site artifact paths are fetched', async () => {
    const { fetchImpl, urls } = site({})
    const report = await classifyUploadedScans(
      [
        entry({ sessionId: 'abs', manifestUrl: `https://evil.example/api/artifacts/${sha}` }),
        entry({ sessionId: 'odd', manifestUrl: '/api/artifacts/not-a-sha' }),
      ],
      { fetchImpl, cache: fresh() },
    )
    expect(urls.some((url) => url.includes('evil.example') || url.includes('not-a-sha'))).toBe(
      false,
    )
    expect(report.statuses.get('abs')).toEqual({ kind: 'unknown' })
    expect(report.statuses.get('odd')).toEqual({ kind: 'unknown' })
  })

  test('a server that refuses HEAD gets a one-byte ranged GET', async () => {
    const { fetchImpl, methods } = site({ headStatus: 405 })
    const report = await classifyUploadedScans([entry({ sessionId: 's1' })], {
      fetchImpl,
      cache: fresh(),
    })
    expect(report.statuses.get('s1')).toEqual({ kind: 'attachable' })
    expect(methods.slice(0, 2)).toEqual(['HEAD', 'GET'])
  })

  test('definitive manifest answers are cached by sha, uncertain ones are not', async () => {
    const cache = fresh()
    const first = site({})
    await classifyUploadedScans([entry({ sessionId: 's1' })], { fetchImpl: first.fetchImpl, cache })
    const second = site({})
    await classifyUploadedScans([entry({ sessionId: 's1' })], {
      fetchImpl: second.fetchImpl,
      cache,
    })
    expect(second.urls.some((url) => url.startsWith('/api/artifacts/'))).toBe(false)

    const flaky = site({ headStatus: 503 })
    const uncached = fresh()
    const report = await classifyUploadedScans([entry({ sessionId: 's1' })], {
      fetchImpl: flaky.fetchImpl,
      cache: uncached,
    })
    expect(report.statuses.get('s1')).toEqual({ kind: 'unknown' })
    expect(uncached.size).toBe(0)
  })

  test('checks run at most four at a time', async () => {
    let running = 0
    let peak = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/artifacts/')) {
        running++
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running--
        return new Response(null, { status: 200 })
      }
      return Response.json({ scenes: [] })
    }) as typeof fetch
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry({
        sessionId: `s${index}`,
        manifestUrl: `/api/artifacts/${String(index).repeat(64).slice(0, 64)}`,
      }),
    )
    await classifyUploadedScans(entries, { fetchImpl, cache: fresh() })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  test('a network error or rate limit is unknown, never attachable', async () => {
    const offline = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/artifacts/')) throw new TypeError('offline')
      return Response.json({ scenes: [] })
    }) as typeof fetch
    const report = await classifyUploadedScans([entry({ sessionId: 's1' })], {
      fetchImpl: offline,
      cache: fresh(),
    })
    expect(report.statuses.get('s1')).toEqual({ kind: 'unknown' })
  })

  test('a failed project list or an unreadable project fails closed', async () => {
    const noList = site({ listStatus: 429 })
    const listReport = await classifyUploadedScans([entry({ sessionId: 's1' })], {
      fetchImpl: noList.fetchImpl,
      cache: fresh(),
    })
    expect(listReport.statuses.get('s1')).toEqual({ kind: 'unknown' })

    const flakyGraph = site({
      scenes: [
        { id: 'p1', name: 'Busy', graph: { nodes: {}, rootNodeIds: [] } as unknown as SceneGraph },
      ],
      graphStatus: { p1: 503 },
    })
    const graphReport = await classifyUploadedScans([entry({ sessionId: 's1' })], {
      fetchImpl: flakyGraph.fetchImpl,
      cache: fresh(),
    })
    expect(graphReport.statuses.get('s1')).toEqual({ kind: 'unknown' })
  })

  test('a project that already holds the scan is reported, by session or by manifest', async () => {
    const { fetchImpl } = site({
      scenes: [
        { id: 'p0', name: 'Empty', graph: { nodes: {}, rootNodeIds: [] } as unknown as SceneGraph },
        { id: 'p1', name: 'TestAndroid', graph: graphWithScan({ sessionId: 's1' }) },
        {
          id: 'p2',
          name: 'Bedroom Test',
          graph: graphWithScan({ manifestUrl: `/api/artifacts/${'c'.repeat(64)}` }),
        },
      ],
    })
    const report = await classifyUploadedScans(
      [
        entry({ sessionId: 's1' }),
        entry({ sessionId: 's2', manifestUrl: `/api/artifacts/${'c'.repeat(64)}` }),
        entry({ sessionId: 's3' }),
      ],
      { fetchImpl, cache: fresh() },
    )
    expect(report.statuses.get('s1')).toEqual({
      kind: 'in-project',
      sceneId: 'p1',
      name: 'TestAndroid',
    })
    expect(report.statuses.get('s2')).toEqual({
      kind: 'in-project',
      sceneId: 'p2',
      name: 'Bedroom Test',
    })
    expect(report.statuses.get('s3')).toEqual({ kind: 'attachable' })
    expect(report.projectNames.get('p2')).toBe('Bedroom Test')
  })

  test("the scan's own project is searched first", async () => {
    const { fetchImpl, urls } = site({
      scenes: [
        { id: 'p0', name: 'Other', graph: { nodes: {}, rootNodeIds: [] } as unknown as SceneGraph },
        { id: 'p1', name: 'Mine', graph: graphWithScan({ sessionId: 's1' }) },
      ],
    })
    const report = await classifyUploadedScans([entry({ sessionId: 's1', projectId: 'p1' })], {
      fetchImpl,
      cache: fresh(),
    })
    expect(report.statuses.get('s1')).toEqual({ kind: 'in-project', sceneId: 'p1', name: 'Mine' })
    expect(urls.includes('/api/scenes/p0')).toBe(false)
  })
})
