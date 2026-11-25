import type { ScanNode } from '@pascal-app/core'

type LooseNode = {
  id: string
  type?: string
  parentId?: string | null
  start?: [number, number]
  end?: [number, number]
  thickness?: number
  polygon?: Array<[number, number]>
  name?: string
  visible?: boolean
}

export type OverlayWall = {
  id: string
  a: [number, number]
  b: [number, number]
  thickness: number
}
export type OverlayZone = { id: string; name: string; polygon: Array<[number, number]> }

export type SceneOverlays = { walls: OverlayWall[]; zones: OverlayZone[] }

const DEFAULT_THICKNESS = 0.1

/**
 * Walls and zones of one level, in level x, z: the same numbers the 2D plan draws, so nothing is
 * converted and the overlay cannot drift from the plan.
 */
export function sceneOverlays(
  nodes: Readonly<Record<string, unknown>>,
  levelId: string | null,
): SceneOverlays {
  const walls: OverlayWall[] = []
  const zones: OverlayZone[] = []
  if (!levelId) return { walls, zones }
  for (const value of Object.values(nodes)) {
    const node = value as LooseNode
    if (node.parentId !== levelId || node.visible === false) continue
    if (node.type === 'wall' && node.start && node.end) {
      walls.push({
        id: node.id,
        a: [node.start[0], node.start[1]],
        b: [node.end[0], node.end[1]],
        thickness: node.thickness ?? DEFAULT_THICKNESS,
      })
    } else if (node.type === 'zone' && node.polygon && node.polygon.length >= 3) {
      zones.push({ id: node.id, name: node.name ?? '', polygon: node.polygon })
    }
  }
  return { walls, zones }
}

/** The building turn, in radians about y, of the level's parent; 0 when it has none. */
export function buildingRotationOf(
  nodes: Readonly<Record<string, unknown>>,
  levelId: string | null,
): number {
  const level = levelId ? (nodes[levelId] as LooseNode | undefined) : undefined
  const building = level?.parentId
    ? (nodes[level.parentId] as { type?: string; rotation?: number[] } | undefined)
    : undefined
  return building?.type === 'building' ? (building.rotation?.[1] ?? 0) : 0
}

export type CaptureScan = {
  id: string
  name: string
  levelId: string | null
  manifestUrl: string
  transform: {
    position: [number, number, number]
    rotation: [number, number, number]
    scale: number
  }
}

/** Scan nodes that carry a capture session with a manifest, in scene order. */
export function captureScans(nodes: Readonly<Record<string, unknown>>): CaptureScan[] {
  const scans: CaptureScan[] = []
  for (const value of Object.values(nodes)) {
    const node = value as Partial<ScanNode> & { name?: string }
    if (node.type !== 'scan' || !node.id || !node.captureSession?.manifestUrl) continue
    if ((node as { visible?: boolean }).visible === false) continue
    scans.push({
      id: node.id,
      name: node.name ?? node.id,
      levelId: node.parentId ?? null,
      manifestUrl: node.captureSession.manifestUrl,
      transform: {
        position: node.position ?? [0, 0, 0],
        rotation: node.rotation ?? [0, 0, 0],
        scale: node.scale ?? 1,
      },
    })
  }
  return scans
}

/** The level x, z extent of everything the map shows, for fitting the view. */
export function overlayBounds(
  points: ReadonlyArray<readonly [number, number]>,
): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  if (points.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const [x, z] of points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  return { minX, minZ, maxX, maxZ }
}
