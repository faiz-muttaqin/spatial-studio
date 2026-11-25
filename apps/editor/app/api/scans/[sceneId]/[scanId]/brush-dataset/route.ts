import { DiskArtifactStore, resolveDefaultDatabasePath } from '@pascal-app/mcp/storage'
import { BrushExportError, exportBrushDataset } from '@/lib/scan/brush-dataset-export'
import {
  guardSceneApiRequest,
  sceneApiJson,
  sceneApiPreflight,
  withSceneApiHeaders,
} from '@/lib/scene-api-security'
import { getSceneOperations } from '@/lib/scene-store-server'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ sceneId: string; scanId: string }> }

export function OPTIONS(request: Request) {
  return sceneApiPreflight(request)
}

/**
 * The scan as a Brush training dataset: a zip of `images/`, `transforms.json` and `points.ply`
 * (docs/spatial-studio/BRUSH_WORKFLOW.md). Same guard as the other scene API routes.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const guard = guardSceneApiRequest(request)
  if (guard) return guard
  const { sceneId, scanId } = await params

  const operations = await getSceneOperations()
  const scene = await operations.loadStoredScene(sceneId)
  if (!scene) return sceneApiJson(request, { error: 'not_found' }, { status: 404 })
  const node = (scene.graph.nodes as Record<string, { id: string; type?: string } | undefined>)[
    scanId
  ]
  if (node?.type !== 'scan') {
    return sceneApiJson(request, { error: 'scan_not_found' }, { status: 404 })
  }

  const store = new DiskArtifactStore(resolveDefaultDatabasePath())
  try {
    const result = await exportBrushDataset(node, {
      read: (sha256) => store.read(sha256),
      size: (sha256) => store.size(sha256),
    })
    const response = new Response(result.stream as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="brush-dataset-${scanId.replace(/[^A-Za-z0-9_-]/g, '_')}.zip"`,
        'Cache-Control': 'private, no-store',
        'X-Brush-Frames': String(result.frames),
        'X-Brush-Skipped-Frames': String(result.skipped.length),
        'X-Brush-Points': String(result.pointCount),
      },
    })
    return withSceneApiHeaders(request, response)
  } catch (error) {
    if (error instanceof BrushExportError) {
      return sceneApiJson(
        request,
        { error: error.code, message: error.message },
        { status: error.code === 'scan_not_found' ? 404 : 422 },
      )
    }
    throw error
  }
}
