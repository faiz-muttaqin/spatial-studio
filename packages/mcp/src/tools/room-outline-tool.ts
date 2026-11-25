import type { McpServer } from '@modelcontextprotocol/server'
import { refuse, solveRoomOutlineTool } from '@pascal-app/core/agent-tools'
import {
  type OutlineConstraint,
  type OutlinePoint,
  OutlineSolverInputError,
  solveRoomOutline,
} from '@pascal-app/core/capture'
import { register } from './scan-tools'

type Residual = ReturnType<typeof solveRoomOutline>['residuals'][number]

/** Names the edge, corner or tape a conflict is about, with edges numbered from 0 as the input is. */
function describeConflict(entry: Residual): string {
  const c = entry.detail
  const amount = Math.abs(entry.error).toFixed(3)
  switch (c.type) {
    case 'distance':
      return `The tape ${c.value} m between corners ${c.a} and ${c.b} is off by ${amount} m in the fit; it conflicts with the other tapes or angles.`
    case 'rightAngle':
      return `The right angle at corner ${c.corner} is off by ${amount} degrees; the tapes do not allow it.`
    case 'parallel':
      return `Edges ${c.edgeA} and ${c.edgeB} are ${amount} degrees from parallel.`
    case 'equalLength':
      return `Edges ${c.edgeA} and ${c.edgeB} differ by ${amount} m instead of being equal.`
    case 'fixed':
      return `Corner ${c.corner} moved ${amount} m although it was fixed.`
  }
}

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
        message: describeConflict(entry),
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
