import { type AnyNodeId, runAsSingleSceneHistoryStep, useScene } from '@pascal-app/core'
import { applyAgentOutcome, createRoom } from '@pascal-app/core/agent-operations'
import { isAgentRefusal } from '@pascal-app/core/agent-tools'
import { createAgentHost, liveSceneRuntime } from '@pascal-app/core/runtime'
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
  | {
      ok: true
      zoneId: string
      wallCount: number
      areaSqMeters: number
      slabId: string | null
      ceilingId: string | null
    }
  | { ok: false; code: string; message: string }

/**
 * Builds the room's walls, zone, floor and ceiling through the editor's own room command
 * (`create_room`'s operation), applied as one undo step with the optional scan placement. It never
 * goes through MCP.
 */
export function buildRoomFromOutline(input: BuildRoomInput): BuildRoomResult {
  const host = createAgentHost(liveSceneRuntime)
  let answer: Record<string, unknown> | undefined
  try {
    // The host reconciles the scene after the walls and zone, which derives the floor plate and the
    // ceiling, and runs the operation's follow-up. The scan placement joins the same undo step.
    runAsSingleSceneHistoryStep(useScene, () => {
      const outcome = createRoom(
        host.getNodes(),
        {
          levelId: input.levelId,
          name: input.name,
          polygon: input.polygon.map(([x, z]) => [x, z]),
          wallHeight: input.height,
        },
        { activeLevelId: input.levelId },
      )
      answer = applyAgentOutcome(outcome, host)
      if (input.scan) {
        useScene.getState().updateNode(input.scan.id as AnyNodeId, {
          position: input.scan.transform.position,
          rotation: input.scan.transform.rotation,
          scale: input.scan.transform.scale,
        })
      }
    })
  } catch (error) {
    if (isAgentRefusal(error)) return { ok: false, code: error.code, message: error.message }
    throw error
  }
  const result = answer as {
    zoneId: string
    wallIds: Array<string | null>
    areaSqMeters: number
    slabId?: string | null
    ceilingId?: string | null
  }
  return {
    ok: true,
    zoneId: result.zoneId,
    wallCount: new Set(result.wallIds.filter(Boolean)).size,
    areaSqMeters: result.areaSqMeters,
    slabId: result.slabId ?? null,
    ceilingId: result.ceilingId ?? null,
  }
}
