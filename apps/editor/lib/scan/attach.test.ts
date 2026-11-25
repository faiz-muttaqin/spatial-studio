import { describe, expect, test } from 'bun:test'
import { DEFAULT_LEVEL_HEIGHT } from '@pascal-app/core'
import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'
import { BuildingNode, LevelNode, SiteNode, WallNode } from '@pascal-app/core/schema'
import { apiGraphSchema } from '../graph-schema'
import {
  AttachError,
  attachScanToGraph,
  attachScanToProject,
  createProjectWithScan,
} from './attach'

const manifestUrl = `/api/artifacts/${'d'.repeat(64)}`
const attachment = { name: 'Room scan 2026-11-25 08:00', sessionId: 'capture_1', manifestUrl }

function populatedGraph(): SceneGraph {
  const site = SiteNode.parse({ id: 'site_a' })
  const building = BuildingNode.parse({ id: 'building_a', parentId: site.id })
  const upper = LevelNode.parse({ id: 'level_upper', parentId: building.id, level: 1, height: 3 })
  const ground = LevelNode.parse({ id: 'level_ground', parentId: building.id, level: 0, height: 3 })
  const wall = WallNode.parse({ id: 'wall_a', parentId: ground.id, start: [0, 0], end: [4, 0] })
  return {
    nodes: {
      [site.id]: { ...site, children: [building.id] },
      [building.id]: { ...building, children: [upper.id, ground.id] },
      [upper.id]: upper,
      [ground.id]: { ...ground, children: [wall.id] },
      [wall.id]: wall,
    } as SceneGraph['nodes'],
    rootNodeIds: [site.id] as SceneGraph['rootNodeIds'],
  }
}

describe('attachScanToGraph', () => {
  test('adds a scan reference under the ground level without touching other nodes', async () => {
    const before = populatedGraph()
    const snapshot = JSON.stringify(before)
    const { graph, scanId, levelId } = await attachScanToGraph(before, attachment)

    expect(JSON.stringify(before)).toBe(snapshot)
    expect(levelId).toBe('level_ground')
    const scan = graph.nodes[scanId as keyof typeof graph.nodes] as Record<string, unknown>
    expect(scan).toMatchObject({
      type: 'scan',
      name: attachment.name,
      parentId: 'level_ground',
      url: null,
      captureSession: { sessionId: 'capture_1', schemaVersion: 2, manifestUrl },
    })
    expect((graph.nodes['level_ground' as never] as { children: string[] }).children).toEqual([
      'wall_a',
      scanId,
    ])
    expect(graph.nodes['wall_a' as never]).toEqual(before.nodes['wall_a' as never])
  })

  test('produces a graph the scene API accepts', async () => {
    const { graph } = await attachScanToGraph(populatedGraph(), attachment)
    const parsed = apiGraphSchema.safeParse(graph)
    expect(parsed.success).toBe(true)
  })

  test('gives an empty project the Site, Building and Level the editor creates', async () => {
    const { graph, levelId } = await attachScanToGraph({ nodes: {}, rootNodeIds: [] }, attachment)
    const [rootId] = graph.rootNodeIds
    const site = graph.nodes[rootId!] as { type: string; children: string[] }
    const building = graph.nodes[site.children[0] as never] as { type: string; children: string[] }
    expect(site.type).toBe('site')
    expect(building.type).toBe('building')
    expect(building.children).toEqual([levelId])
    expect(graph.nodes[levelId as never]).toMatchObject({
      type: 'level',
      level: 0,
      height: DEFAULT_LEVEL_HEIGHT,
    })
    expect(apiGraphSchema.safeParse(graph).success).toBe(true)
  })

  test('refuses a populated graph with no level instead of inventing one', async () => {
    const site = SiteNode.parse({ id: 'site_only' })
    await expect(
      attachScanToGraph(
        { nodes: { [site.id]: site } as SceneGraph['nodes'], rootNodeIds: [site.id] as never },
        attachment,
      ),
    ).rejects.toThrow(AttachError)
  })

  test('rejects a manifest URL outside the asset allowlist', async () => {
    await expect(
      attachScanToGraph(populatedGraph(), { ...attachment, manifestUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow()
  })
})

type Call = { url: string; method: string; headers: Headers; body: unknown }

function sceneServer(responses: Array<(call: Call) => Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    const respond = responses[calls.length - 1]
    if (!respond) throw new Error(`Unexpected request ${call.method} ${call.url}`)
    return respond(call)
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('attachScanToProject', () => {
  test('writes through PUT /api/scenes/{id} with the read version as If-Match', async () => {
    const { calls, fetchImpl } = sceneServer([
      () => Response.json({ id: 'scene-1', version: 7, graph: populatedGraph() }),
      () => Response.json({ id: 'scene-1', version: 8 }),
    ])
    const result = await attachScanToProject('scene-1', attachment, { fetchImpl })

    expect(result.version).toBe(8)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/scenes/scene-1',
      'PUT /api/scenes/scene-1',
    ])
    expect(calls[1]!.headers.get('If-Match')).toBe('"7"')
    const body = calls[1]!.body as { graph: SceneGraph; name?: string }
    expect(body.name).toBeUndefined()
    expect(body.graph.nodes[result.scanId as never]).toBeDefined()
  })

  test('re-reads and re-applies after a version conflict', async () => {
    const { calls, fetchImpl } = sceneServer([
      () => Response.json({ version: 7, graph: populatedGraph() }),
      () => Response.json({ error: 'version_conflict', currentVersion: 8 }, { status: 409 }),
      () => Response.json({ version: 8, graph: populatedGraph() }),
      () => Response.json({ version: 9 }),
    ])
    const result = await attachScanToProject('scene-1', attachment, { fetchImpl })
    expect(result.version).toBe(9)
    expect(calls[3]!.headers.get('If-Match')).toBe('"8"')
  })

  test('gives up after repeated conflicts', async () => {
    const conflict = () => Response.json({ error: 'version_conflict' }, { status: 409 })
    const read = () => Response.json({ version: 1, graph: populatedGraph() })
    const { fetchImpl } = sceneServer([read, conflict, read, conflict])
    const error = await attachScanToProject('scene-1', attachment, {
      fetchImpl,
      maxAttempts: 2,
    }).catch((cause: unknown) => cause)
    expect((error as AttachError).code).toBe('conflict')
  })

  test('reports a missing project', async () => {
    const { fetchImpl } = sceneServer([
      () => Response.json({ error: 'not_found' }, { status: 404 }),
    ])
    const error = await attachScanToProject('nope', attachment, { fetchImpl }).catch(
      (cause: unknown) => cause,
    )
    expect((error as AttachError).status).toBe(404)
  })
})

describe('createProjectWithScan', () => {
  test('creates the project and its scan in one POST', async () => {
    const { calls, fetchImpl } = sceneServer([
      () => Response.json({ id: 'scene-new', version: 1 }, { status: 201 }),
    ])
    const result = await createProjectWithScan('Flat survey', attachment, fetchImpl)
    expect(result.sceneId).toBe('scene-new')
    expect(calls[0]!.method).toBe('POST')
    const body = calls[0]!.body as { name: string; graph: SceneGraph }
    expect(body.name).toBe('Flat survey')
    expect(apiGraphSchema.safeParse(body.graph).success).toBe(true)
  })
})
