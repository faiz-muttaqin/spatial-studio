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
}): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('/api/artifacts/')) {
      return new Response('{}', { status: options.manifests?.[url] ?? 200 })
    }
    if (url.startsWith('/api/scenes?')) {
      return Response.json({
        scenes: (options.scenes ?? []).map(({ id, name }) => ({ id, name })),
      })
    }
    const scene = options.scenes?.find((item) => url === `/api/scenes/${item.id}`)
    return scene ? Response.json({ graph: scene.graph }) : new Response('', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, urls }
}

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
  test('a scan uploaded to another origin is elsewhere, without any request for it', async () => {
    const { fetchImpl, urls } = site({})
    const report = await classifyUploadedScans(
      [entry({ sessionId: 's1', uploadedOrigin: 'http://127.0.0.1:3002' })],
      { origin, fetchImpl },
    )
    expect(report.statuses.get('s1')).toEqual({ kind: 'elsewhere' })
    expect(urls.some((url) => url.startsWith('/api/artifacts/'))).toBe(false)
  })

  test('an older record is verified: 404 on this site means elsewhere, 200 means attachable', async () => {
    const other = 'b'.repeat(64)
    const { fetchImpl } = site({ manifests: { [`/api/artifacts/${other}`]: 404 } })
    const report = await classifyUploadedScans(
      [
        entry({ sessionId: 'gone', manifestUrl: `/api/artifacts/${other}` }),
        entry({ sessionId: 'here' }),
      ],
      { origin, fetchImpl },
    )
    expect(report.statuses.get('gone')).toEqual({ kind: 'elsewhere' })
    expect(report.statuses.get('here')).toEqual({ kind: 'attachable' })
  })

  test('a record with this origin is not fetched again', async () => {
    const { fetchImpl, urls } = site({})
    const report = await classifyUploadedScans(
      [entry({ sessionId: 's1', uploadedOrigin: origin })],
      {
        origin,
        fetchImpl,
      },
    )
    expect(report.statuses.get('s1')).toEqual({ kind: 'attachable' })
    expect(urls.some((url) => url.startsWith('/api/artifacts/'))).toBe(false)
  })

  test('a network error does not hide a scan', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/artifacts/')) throw new TypeError('offline')
      return Response.json({ scenes: [] })
    }) as typeof fetch
    const report = await classifyUploadedScans([entry({ sessionId: 's1' })], { origin, fetchImpl })
    expect(report.statuses.get('s1')).toEqual({ kind: 'attachable' })
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
        entry({ sessionId: 's1', uploadedOrigin: origin }),
        entry({
          sessionId: 's2',
          uploadedOrigin: origin,
          manifestUrl: `/api/artifacts/${'c'.repeat(64)}`,
        }),
        entry({ sessionId: 's3', uploadedOrigin: origin }),
      ],
      { origin, fetchImpl },
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
})
