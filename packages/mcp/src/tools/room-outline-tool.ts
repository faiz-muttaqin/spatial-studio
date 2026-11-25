import type { McpServer } from '@modelcontextprotocol/server'
import { refuse, solveRoomOutlineTool } from '@pascal-app/core/agent-tools'
import {
  type OutlineConstraint,
  type OutlinePoint,
  OutlineSolverInputError,
  solveRoomOutline,
} from '@pascal-app/core/capture'
import { register } from './scan-tools'

const round = (value: number, places = 3) => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** `solve_room_outline`: pure, reads no scan and writes nothing, so every server offers it. */
export function registerRoomOutlineTool(server: McpServer): void {
  register(server, solveRoomOutlineTool, async (input) => {
    let solution: ReturnType<typeof solveRoomOutline>
    try {
      solution = solveRoomOutline({
        polygon: input.polygon as unknown as OutlinePoint[],
        edges: input.edges,
        constraints: input.constraints as OutlineConstraint[] | undefined,
      })
    } catch (error) {
      if (error instanceof OutlineSolverInputError) refuse('invalid_outline', error.message)
      throw error
    }
    return {
      polygon: solution.polygon.map(([x, z]) => [round(x), round(z)]),
      scale: round(solution.scale, 4),
      converged: solution.converged,
      selfIntersecting: solution.selfIntersecting,
      edges: solution.edges.map((edge) => ({
        index: edge.index,
        proposedLength: round(edge.proposedLength),
        length: round(edge.length),
        sigma: round(edge.sigma),
        measured: edge.measured,
      })),
      residuals: solution.residuals.map((entry) => ({
        ...entry,
        error: round(entry.error),
        sigmas: round(entry.sigmas, 1),
      })),
      conflicts: solution.conflicts.map((entry) => ({
        ...entry,
        error: round(entry.error),
        sigmas: round(entry.sigmas, 1),
      })),
      measureNext: solution.measureNext
        ? { ...solution.measureNext, sigma: round(solution.measureNext.sigma) }
        : null,
      note: 'A draft: the person confirms the corrected outline on site before create_room builds it.',
    }
  })
}
