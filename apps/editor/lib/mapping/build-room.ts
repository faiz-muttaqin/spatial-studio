import { type AnyNodeId, runAsSingleSceneHistoryStep, useScene } from '@pascal-app/core'
import { createRoom } from '@pascal-app/core/agent-operations'
import { isAgentRefusal } from '@pascal-app/core/agent-tools'
import type { Point } from './scan-review'

export type BuildRoomInput = {
  levelId: string
  name: string
  polygon: readonly Point[]
  /** Wall height in metres, floor to ceiling. */
  height: number
  /** When set, the scan node moves by this transform in the same undo step. */
  scan?: { id: string; transform: ScanPlacement }
}

export type ScanPlacement = {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number
}

export type BuildRoomResult =
  | { ok: true; zoneId: string; wallCount: number; areaSqMeters: number }
  | { ok: false; code: string; message: string }

/**
 * Builds the room's walls, zone, floor and ceiling through the editor's own room command
 * (`create_room`'s operation), applied as one undo step with the optional scan placement. It never
 * goes through MCP.
 */
export function buildRoomFromOutline(input: BuildRoomInput): BuildRoomResult {
  const store = useScene.getState()
  let outcome: ReturnType<typeof createRoom>
  try {
    outcome = createRoom(
      store.nodes as Parameters<typeof createRoom>[0],
      {
        levelId: input.levelId,
        name: input.name,
        polygon: input.polygon.map(([x, z]) => [x, z]),
        wallHeight: input.height,
      },
      { activeLevelId: input.levelId },
    )
  } catch (error) {
    if (isAgentRefusal(error)) return { ok: false, code: error.code, message: error.message }
    throw error
  }
  const result = outcome.result as {
    zoneId: string
    wallIds: Array<string | null>
    areaSqMeters: number
  }
  runAsSingleSceneHistoryStep(useScene, () => {
    useScene
      .getState()
      .applyNodeChanges(
        (outcome.changes ?? {}) as Parameters<
          ReturnType<typeof useScene.getState>['applyNodeChanges']
        >[0],
      )
    if (input.scan) {
      useScene.getState().updateNode(input.scan.id as AnyNodeId, {
        position: input.scan.transform.position,
        rotation: input.scan.transform.rotation,
        scale: input.scan.transform.scale,
      })
    }
  })
  return {
    ok: true,
    zoneId: result.zoneId,
    wallCount: new Set(result.wallIds.filter(Boolean)).size,
    areaSqMeters: result.areaSqMeters,
  }
}
