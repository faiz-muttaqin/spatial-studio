import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'
import type { ScanListEntry } from './native-bridge'

/**
 * What the scan page may offer for a scan the companion says is uploaded:
 * - `attachable`: its manifest is on this site and no project holds it;
 * - `elsewhere`: uploaded to another server (a local test server, say), so attaching would break;
 * - `in-project`: a project already has a scan node for this capture session or manifest.
 */
export type UploadedScanStatus =
  | { kind: 'attachable' }
  | { kind: 'elsewhere' }
  | { kind: 'in-project'; sceneId: string; name: string }

export type UploadedScanReport = {
  statuses: Map<string, UploadedScanStatus>
  /** Project names by scene id, for labelling the project a scan was started for. */
  projectNames: Map<string, string>
}

type SceneSummary = { id: string; name: string }

/** A scan node of the capture session or manifest in the graph, if any. */
export function findScanNodeFor(
  graph: SceneGraph,
  target: { sessionId: string; manifestUrl?: string },
): string | null {
  for (const node of Object.values(graph.nodes) as Array<{
    id: string
    type?: string
    captureSession?: { sessionId?: string; manifestUrl?: string } | null
  }>) {
    if (node.type !== 'scan' || !node.captureSession) continue
    if (node.captureSession.sessionId === target.sessionId) return node.id
    if (target.manifestUrl && node.captureSession.manifestUrl === target.manifestUrl) return node.id
  }
  return null
}

/** Newest projects checked for an existing scan node; older ones are not searched. */
const MAX_PROJECTS_SEARCHED = 30

/**
 * Classifies uploaded scans before the page offers "Attach". An entry without `uploadedOrigin` (an older
 * record) has its manifest fetched from this site: only a 404 proves it is elsewhere; a network error
 * leaves it attachable rather than hiding a real scan.
 */
export async function classifyUploadedScans(
  entries: ScanListEntry[],
  options: { origin: string; fetchImpl?: typeof fetch },
): Promise<UploadedScanReport> {
  const fetchImpl = options.fetchImpl ?? fetch
  const statuses = new Map<string, UploadedScanStatus>()
  const projectNames = new Map<string, string>()
  const candidates: ScanListEntry[] = []

  for (const entry of entries) {
    if (entry.uploadedOrigin && entry.uploadedOrigin !== options.origin) {
      statuses.set(entry.sessionId, { kind: 'elsewhere' })
    } else if (entry.uploadedOrigin || !entry.manifestUrl) {
      candidates.push(entry)
    } else {
      const present = await manifestPresent(entry.manifestUrl, fetchImpl)
      if (present) candidates.push(entry)
      else statuses.set(entry.sessionId, { kind: 'elsewhere' })
    }
  }

  const scenes = await listScenes(fetchImpl)
  for (const scene of scenes) projectNames.set(scene.id, scene.name)

  const pending = new Set(candidates.map((entry) => entry.sessionId))
  for (const scene of scenes.slice(0, MAX_PROJECTS_SEARCHED)) {
    if (pending.size === 0) break
    const graph = await loadGraph(scene.id, fetchImpl)
    if (!graph) continue
    for (const entry of candidates) {
      if (!pending.has(entry.sessionId)) continue
      if (findScanNodeFor(graph, { sessionId: entry.sessionId, manifestUrl: entry.manifestUrl })) {
        statuses.set(entry.sessionId, { kind: 'in-project', sceneId: scene.id, name: scene.name })
        pending.delete(entry.sessionId)
      }
    }
  }
  for (const id of pending) statuses.set(id, { kind: 'attachable' })
  return { statuses, projectNames }
}

async function manifestPresent(manifestUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(manifestUrl)
    return response.status !== 404
  } catch {
    return true
  }
}

async function listScenes(fetchImpl: typeof fetch): Promise<SceneSummary[]> {
  try {
    const response = await fetchImpl(`/api/scenes?limit=${MAX_PROJECTS_SEARCHED}`)
    if (!response.ok) return []
    const body = (await response.json()) as { scenes?: Array<{ id?: unknown; name?: unknown }> }
    return (body.scenes ?? []).flatMap((scene) =>
      typeof scene.id === 'string'
        ? [{ id: scene.id, name: typeof scene.name === 'string' ? scene.name : scene.id }]
        : [],
    )
  } catch {
    return []
  }
}

async function loadGraph(sceneId: string, fetchImpl: typeof fetch): Promise<SceneGraph | null> {
  try {
    const response = await fetchImpl(`/api/scenes/${encodeURIComponent(sceneId)}`)
    if (!response.ok) return null
    return ((await response.json()) as { graph: SceneGraph }).graph
  } catch {
    return null
  }
}
