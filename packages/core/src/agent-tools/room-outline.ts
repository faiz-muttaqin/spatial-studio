import { z } from 'zod'

const coordinate = z.number().min(-100_000).max(100_000)
const point = z.array(coordinate).length(2)
const corner = z.number().int().min(0).max(47)

/** Most corners one solve_room_outline call takes; the solver's own bound. */
export const ROOM_OUTLINE_MAX_CORNERS = 48
export const ROOM_OUTLINE_MAX_CONSTRAINTS = 4 * ROOM_OUTLINE_MAX_CORNERS + 32
/** Largest corner coordinate in metres. */
export const ROOM_OUTLINE_MAX_COORDINATE = 100_000

export const solveRoomOutlineTool = {
  name: 'solve_room_outline',
  title: 'Solve room outline',
  description:
    "Correct a proposed room outline with what the person knows, writing nothing: a least-squares fit over the corners. Give the polygon from propose_room_from_scan (corners as [x, z] in metres, in order), optionally each edge's confidence, basis and likelyGlass, and constraints: tape distances between two corners (an edge i runs from corner i to corner i + 1, wrapping), right angles at a corner, parallel or equal-length edge pairs, and corners that must stay put. The proposal's shape is kept as a vector per edge times one scale, so one tape measure stretches the walls nobody measured in proportion; low-confidence edges move first, tapes and ticked right angles are trusted most. Walls that are not square stay as they are unless a constraint says otherwise. Returns the corrected polygon (same corner order, ready for create_room), the scale, per-edge length with its standard deviation in metres, each constraint's residual, conflicts (a tape the fit could not honour, such as two tapes that contradict each other, with the error in metres), measureNext (the edge whose length is least certain, to ask the person to measure next, or null when every edge is known to about 2 cm) whether the result crosses itself or touches itself, and whether the fit converged (when it did not, say so and do not present the result as settled). One tape fixes the scale of the whole outline, so when the person gives only one, ask for a second tape on the other wall direction (measureNext names the edge); one tape cannot correct a room that is drawn wrong in one direction only. Corrected values are still a draft until the person confirms them on site. Refusal codes: invalid_outline.",
  input: {
    polygon: z
      .array(point)
      .min(3)
      .max(ROOM_OUTLINE_MAX_CORNERS)
      .describe('The proposed corners in order, as [x, z] in metres.'),
    edges: z
      .array(
        z.object({
          confidence: z.enum(['high', 'medium', 'low']).optional(),
          basis: z
            .enum([
              'plane-estimate',
              'depth-fit',
              'floor-boundary',
              'carved',
              'manual-measurement',
              'assumed',
            ])
            .optional(),
          likelyGlass: z.boolean().optional(),
          sigma: z
            .number()
            .positive()
            .max(5)
            .optional()
            .describe('How far this edge is trusted, in metres; overrides the confidence.'),
        }),
      )
      .max(ROOM_OUTLINE_MAX_CORNERS)
      .optional()
      .describe(
        'One entry per edge, in edge order: the edges of propose_room_from_scan fit as given.',
      ),
    constraints: z
      .array(
        z.discriminatedUnion('type', [
          z.object({
            type: z.literal('distance'),
            a: corner,
            b: corner,
            value: z.number().positive().max(200).describe('Tape length in metres.'),
          }),
          z.object({ type: z.literal('rightAngle'), corner }),
          z.object({ type: z.literal('parallel'), edgeA: corner, edgeB: corner }),
          z.object({ type: z.literal('equalLength'), edgeA: corner, edgeB: corner }),
          z.object({
            type: z.literal('fixed'),
            corner,
            position: point.optional().describe('Where it stays; default its place in polygon.'),
          }),
        ]),
      )
      .max(ROOM_OUTLINE_MAX_CONSTRAINTS)
      .optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const
