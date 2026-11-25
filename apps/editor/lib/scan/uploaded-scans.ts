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
  /** The checks could not finish (rate limit, server error, offline): fail closed, no Attach. */
  | { kind: 'unknown' }

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
const MAX_CONCURRENT_CHECKS = 4
const MANIFEST_URL = /^\/api\/artifacts\/([0-9a-f]{64})$/

type ManifestCheck = 'present' | 'missing' | 'unknown'

/** Definitive answers only, by manifest sha: a 404 or a 200 does not change within a visit. */
const manifestCache = new Map<string, 'present' | 'missing'>()

/**
 * Classifies uploaded scans before the page offers "Attach". Every entry is checked, whatever origin the
 * companion recorded: its manifest must exist on this site (a same-site path only, never an absolute URL),
 * and no project may already hold the scan. Anything that cannot be settled (429, 5xx, offline) is
 * `unknown`, never `attachable`.
 */
export async function classifyUploadedScans(
  entries: ScanListEntry[],
  options: { fetchImpl?: typeof fetch; cache?: Map<string, 'present' | 'missing'> },
): Promise<UploadedScanReport> {
  const fetchImpl = options.fetchImpl ?? fetch
  const cache = options.cache ?? manifestCache
  const statuses = new Map<string, UploadedScanStatus>()
  const projectNames = new Map<string, string>()

  const checks = await mapWithLimit(entries, MAX_CONCURRENT_CHECKS, async (entry) => {
    const match = entry.manifestUrl ? MANIFEST_URL.exec(entry.manifestUrl) : null
    if (!match?.[1] || !entry.manifestUrl) return 'unknown' as ManifestCheck
    return checkManifest(match[1], entry.manifestUrl, fetchImpl, cache)
  })

  const candidates: ScanListEntry[] = []
  entries.forEach((entry, index) => {
    const check = checks[index]
    if (check === 'missing') statuses.set(entry.sessionId, { kind: 'elsewhere' })
    else if (check === 'present') candidates.push(entry)
    else statuses.set(entry.sessionId, { kind: 'unknown' })
  })

  const listed = await listScenes(fetchImpl)
  if (!listed) {
    for (const entry of candidates) statuses.set(entry.sessionId, { kind: 'unknown' })
    return { statuses, projectNames }
  }
  for (const scene of listed) projectNames.set(scene.id, scene.name)

  // The project a scan was started for is the likeliest holder: look there first.
  const preferred = new Set(
    candidates.flatMap((entry) => (entry.projectId ? [entry.projectId] : [])),
  )
  const scenes = [
    ...listed.filter((scene) => preferred.has(scene.id)),
    ...listed.filter((scene) => !preferred.has(scene.id)),
  ].slice(0, MAX_PROJECTS_SEARCHED)

  const pending = new Set(candidates.map((entry) => entry.sessionId))
  let incomplete = false
  for (const scene of scenes) {
    if (pending.size === 0) break
    const graph = await loadGraph(scene.id, fetchImpl)
    if (graph === 'failed') {
      incomplete = true
      continue
    }
    if (!graph) continue
    for (const entry of candidates) {
      if (!pending.has(entry.sessionId)) continue
      if (findScanNodeFor(graph, { sessionId: entry.sessionId, manifestUrl: entry.manifestUrl })) {
        statuses.set(entry.sessionId, { kind: 'in-project', sceneId: scene.id, name: scene.name })
        pending.delete(entry.sessionId)
      }
    }
  }
  // A project that could not be read might hold the scan: fail closed.
  for (const id of pending)
    statuses.set(id, incomplete ? { kind: 'unknown' } : { kind: 'attachable' })
  return { statuses, projectNames }
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

/** HEAD first; a server that refuses it gets a one-byte ranged GET. Only a definitive answer is cached. */
async function checkManifest(
  sha: string,
  manifestUrl: string,
  fetchImpl: typeof fetch,
  cache: Map<string, 'present' | 'missing'>,
): Promise<ManifestCheck> {
  const cached = cache.get(sha)
  if (cached) return cached
  try {
    let response = await fetchImpl(manifestUrl, { method: 'HEAD' })
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(manifestUrl, { headers: { Range: 'bytes=0-0' } })
    }
    if (response.status === 404) {
      cache.set(sha, 'missing')
      return 'missing'
    }
    if (response.ok) {
      cache.set(sha, 'present')
      return 'present'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Null when the list could not be read. */
async function listScenes(fetchImpl: typeof fetch): Promise<SceneSummary[] | null> {
  try {
    const response = await fetchImpl(`/api/scenes?limit=${MAX_PROJECTS_SEARCHED}`)
    if (!response.ok) return null
    const body = (await response.json()) as { scenes?: Array<{ id?: unknown; name?: unknown }> }
    return (body.scenes ?? []).flatMap((scene) =>
      typeof scene.id === 'string'
        ? [{ id: scene.id, name: typeof scene.name === 'string' ? scene.name : scene.id }]
        : [],
    )
  } catch {
    return null
  }
}

/** The graph, null when the project is gone (404), `failed` when it could not be read. */
async function loadGraph(
  sceneId: string,
  fetchImpl: typeof fetch,
): Promise<SceneGraph | null | 'failed'> {
  try {
    const response = await fetchImpl(`/api/scenes/${encodeURIComponent(sceneId)}`)
    if (response.status === 404) return null
    if (!response.ok) return 'failed'
    return ((await response.json()) as { graph: SceneGraph }).graph
  } catch {
    return 'failed'
  }
}
