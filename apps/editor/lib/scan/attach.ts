import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'

/**
 * Storey height of a level created for an empty project. Equal to core's
 * `DEFAULT_LEVEL_HEIGHT` (asserted in attach.test.ts), which only core's main
 * entry exports.
 */
const NEW_LEVEL_HEIGHT = 2.5

/**
 * The node schemas import most of core (systems, stores, geometry), so the
 * phone page loads them when it attaches a scan, not when it opens.
 */
const loadNodeSchemas = () => import('@pascal-app/core/schema')

export type ScanAttachment = {
  name: string
  sessionId: string
  manifestUrl: string
}

export class AttachError extends Error {
  readonly code: 'no_level' | 'conflict' | 'request_failed'
  readonly status?: number

  constructor(code: AttachError['code'], message: string, status?: number) {
    super(message)
    this.name = 'AttachError'
    this.code = code
    this.status = status
  }
}

type GraphNode = { id: string; type?: string; children?: unknown; level?: unknown }

/**
 * Adds a `scan` node pointing at a capture manifest under the scene's ground
 * level, the way the editor's own upload does (`createNode(scan, levelId)`):
 * parent link on the scan, id appended to the level's children. An empty
 * scene first gets the Site → Building → Level hierarchy the editor creates
 * on load. Returns a new graph; the input is not modified.
 */
export async function attachScanToGraph(
  graph: SceneGraph,
  attachment: ScanAttachment,
): Promise<{ graph: SceneGraph; scanId: string; levelId: string }> {
  const { BuildingNode, LevelNode, ScanNode, SiteNode } = await loadNodeSchemas()
  let nodes = { ...graph.nodes } as Record<string, GraphNode>
  let rootNodeIds = [...graph.rootNodeIds] as string[]
  let levelId = findGroundLevel(nodes, rootNodeIds)

  if (!levelId) {
    if (Object.keys(nodes).length > 0) {
      throw new AttachError('no_level', 'The project has no level to attach the scan to.')
    }
    const site = SiteNode.parse({})
    const building = BuildingNode.parse({ parentId: site.id })
    const level = LevelNode.parse({
      parentId: building.id,
      level: 0,
      children: [],
      height: NEW_LEVEL_HEIGHT,
    })
    nodes = {
      [site.id]: { ...site, children: [building.id] },
      [building.id]: { ...building, children: [level.id] },
      [level.id]: level,
    }
    rootNodeIds = [site.id]
    levelId = level.id
  }

  const scan = ScanNode.parse({
    name: attachment.name,
    parentId: levelId,
    captureSession: {
      sessionId: attachment.sessionId,
      schemaVersion: 2,
      manifestUrl: attachment.manifestUrl,
    },
  })
  const level = nodes[levelId]!
  const children = Array.isArray(level.children) ? (level.children as string[]) : []
  nodes = {
    ...nodes,
    [levelId]: { ...level, children: [...children, scan.id] },
    [scan.id]: scan,
  }

  return {
    graph: { ...graph, nodes: nodes as SceneGraph['nodes'], rootNodeIds: rootNodeIds as never },
    scanId: scan.id,
    levelId,
  }
}

/** First level numbered 0 in tree order from the roots, else the first level found. */
function findGroundLevel(nodes: Record<string, GraphNode>, rootNodeIds: string[]): string | null {
  const levels: GraphNode[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const node = nodes[id]
    if (!node) return
    if (node.type === 'level') {
      levels.push(node)
      return
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) if (typeof child === 'string') visit(child)
    }
  }
  rootNodeIds.forEach(visit)
  if (levels.length === 0) {
    levels.push(...Object.values(nodes).filter((node) => node.type === 'level'))
  }
  return (levels.find((node) => node.level === 0) ?? levels[0])?.id ?? null
}

export type ProjectSummary = { id: string; name: string; updatedAt: string; nodeCount: number }

export async function listProjects(fetchImpl: typeof fetch = fetch): Promise<ProjectSummary[]> {
  const response = await fetchImpl('/api/scenes?limit=50')
  if (!response.ok) throw requestFailed(response.status)
  const body = (await response.json()) as { scenes: ProjectSummary[] }
  return body.scenes.map(({ id, name, updatedAt, nodeCount }) => ({
    id,
    name,
    updatedAt,
    nodeCount,
  }))
}

/** Creates a project that already holds the scan, in one write. */
export async function createProjectWithScan(
  projectName: string,
  attachment: ScanAttachment,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sceneId: string; scanId: string }> {
  const { graph, scanId } = await attachScanToGraph({ nodes: {}, rootNodeIds: [] }, attachment)
  const response = await fetchImpl('/api/scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName, graph }),
  })
  if (!response.ok) throw requestFailed(response.status)
  const meta = (await response.json()) as { id: string }
  return { sceneId: meta.id, scanId }
}

/**
 * Adds the scan to a saved project through the scene API's revision check:
 * read the graph and its version, write with `If-Match`. A concurrent save
 * (409) re-reads and re-applies the addition, so nothing the other writer
 * saved is overwritten.
 */
export async function attachScanToProject(
  sceneId: string,
  attachment: ScanAttachment,
  options: { fetchImpl?: typeof fetch; maxAttempts?: number } = {},
): Promise<{ sceneId: string; scanId: string; version: number }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxAttempts = options.maxAttempts ?? 3
  const sceneUrl = `/api/scenes/${encodeURIComponent(sceneId)}`

  for (let attempt = 1; ; attempt += 1) {
    const current = await fetchImpl(sceneUrl)
    if (!current.ok) throw requestFailed(current.status)
    const scene = (await current.json()) as { version: number; graph: SceneGraph }
    const { graph, scanId } = await attachScanToGraph(scene.graph, attachment)

    const response = await fetchImpl(sceneUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${scene.version}"` },
      body: JSON.stringify({ graph }),
    })
    if (response.ok) {
      const meta = (await response.json()) as { version: number }
      return { sceneId, scanId, version: meta.version }
    }
    if (response.status === 409 && attempt < maxAttempts) continue
    if (response.status === 409) {
      throw new AttachError(
        'conflict',
        'The project kept changing while the scan was attached.',
        409,
      )
    }
    throw requestFailed(response.status)
  }
}

function requestFailed(status: number): AttachError {
  return new AttachError('request_failed', `Scene request failed (${status}).`, status)
}
