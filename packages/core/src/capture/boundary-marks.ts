import { z } from 'zod'
import { CaptureMatrix4Schema } from './streams'

/**
 * Payload of the v1.2 `boundary-marks` stream in
 * `docs/spatial-studio/CAPTURE_CONTRACT.md` ("Boundary marks (v1.2)"): walls,
 * glass, mirrors, openings and doors whose floor line the user marked by
 * tapping the floor at both ends. Bounds match the contract.
 */

export const CAPTURE_MAX_BOUNDARY_MARKS = 200
export const CAPTURE_BOUNDARY_MIN_LENGTH = 0.05
export const CAPTURE_BOUNDARY_MAX_LENGTH = 50
export const CAPTURE_BOUNDARY_MAX_BASE_SLOPE = 0.5
export const CAPTURE_BOUNDARY_MIN_HEIGHT = 0.1
export const CAPTURE_BOUNDARY_MAX_HEIGHT = 10
export const CAPTURE_BOUNDARY_MAX_NOTES = 500

/** How far the point may differ from the pose translation, in metres. */
const POINT_POSE_TOLERANCE = 0.001

const finite = z.number().finite()

export const BoundaryKindSchema = z.enum(['wall', 'glass', 'mirror', 'opening', 'door'])
export const BoundaryHeightSourceSchema = z.enum(['ceiling-plane', 'typed', 'unknown'])
export const BoundaryMarkSourceSchema = z.literal('manual-ar-marking')

export const BoundaryBasePointSchema = z
  .object({
    /** ARCore world metres. */
    point: z.tuple([finite, finite, finite]),
    /** Column-major hit pose. */
    pose: CaptureMatrix4Schema,
    /** The horizontal plane that was hit; may be absent from the plane-set stream. */
    planeId: z.string().min(1).nullable(),
    /** Device clock, nanoseconds. */
    timestamp: finite.nonnegative(),
  })
  .refine(
    ({ point, pose }) =>
      Math.abs(point[0] - (pose[12] ?? Number.NaN)) <= POINT_POSE_TOLERANCE &&
      Math.abs(point[1] - (pose[13] ?? Number.NaN)) <= POINT_POSE_TOLERANCE &&
      Math.abs(point[2] - (pose[14] ?? Number.NaN)) <= POINT_POSE_TOLERANCE,
    { message: 'point must equal the translation of pose.', path: ['point'] },
  )

export const BoundaryHeightSchema = z
  .object({
    metres: finite.min(CAPTURE_BOUNDARY_MIN_HEIGHT).max(CAPTURE_BOUNDARY_MAX_HEIGHT).nullable(),
    source: BoundaryHeightSourceSchema,
    ceilingPlaneId: z.string().min(1).nullable(),
  })
  .superRefine((height, context) => {
    if ((height.source === 'unknown') !== (height.metres === null)) {
      context.addIssue({
        code: 'custom',
        message: 'metres is null exactly when source is "unknown".',
        path: ['metres'],
      })
    }
    if (height.source !== 'ceiling-plane' && height.ceilingPlaneId !== null) {
      context.addIssue({
        code: 'custom',
        message: 'ceilingPlaneId is only set when source is "ceiling-plane".',
        path: ['ceilingPlaneId'],
      })
    }
  })

export const BoundaryMarkSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: BoundaryKindSchema,
    base: z.tuple([BoundaryBasePointSchema, BoundaryBasePointSchema]),
    height: BoundaryHeightSchema,
    source: BoundaryMarkSourceSchema,
    /** Wall clock, unix milliseconds. */
    createdAt: finite.nonnegative(),
    notes: z.string().max(CAPTURE_BOUNDARY_MAX_NOTES).nullable(),
  })
  .superRefine((mark, context) => {
    const [start, end] = mark.base
    const length = Math.hypot(end.point[0] - start.point[0], end.point[2] - start.point[2])
    if (length < CAPTURE_BOUNDARY_MIN_LENGTH || length > CAPTURE_BOUNDARY_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `The base must be ${CAPTURE_BOUNDARY_MIN_LENGTH} to ${CAPTURE_BOUNDARY_MAX_LENGTH} m long.`,
        path: ['base'],
      })
    }
    if (Math.abs(end.point[1] - start.point[1]) > CAPTURE_BOUNDARY_MAX_BASE_SLOPE) {
      context.addIssue({
        code: 'custom',
        message: `The base points may differ in height by at most ${CAPTURE_BOUNDARY_MAX_BASE_SLOPE} m.`,
        path: ['base'],
      })
    }
  })

export const BoundaryMarksPayloadSchema = z
  .object({ marks: z.array(BoundaryMarkSchema).max(CAPTURE_MAX_BOUNDARY_MARKS) })
  .superRefine((payload, context) => {
    const seen = new Set<string>()
    payload.marks.forEach((mark, index) => {
      if (seen.has(mark.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate mark id: ${mark.id}`,
          path: ['marks', index, 'id'],
        })
      }
      seen.add(mark.id)
    })
  })

export type BoundaryKind = z.infer<typeof BoundaryKindSchema>
export type BoundaryBasePoint = z.infer<typeof BoundaryBasePointSchema>
export type BoundaryHeight = z.infer<typeof BoundaryHeightSchema>
export type BoundaryMark = z.infer<typeof BoundaryMarkSchema>
export type BoundaryMarksPayload = z.infer<typeof BoundaryMarksPayloadSchema>
