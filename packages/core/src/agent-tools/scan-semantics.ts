import { z } from 'zod'

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const scanId = z.string().min(1).max(128).describe('A scan node id from list_scans.')

/** Most frames and detections one lift_scan_semantics call reads. */
export const SEMANTICS_MAX_FRAMES = 40
export const SEMANTICS_MAX_DETECTIONS = 200

export const planScanSemanticsTool = {
  name: 'plan_scan_semantics',
  title: 'Plan scan semantics',
  description:
    "Choose which scan photos to look at to find doors, windows and furniture, writing nothing. For each wall (the scene walls on the scan's level, else the walls of propose_room_from_scan) it returns up to 4 keyframe ids that stand 1 to 4 m away, face the wall square on and have it in frame, with the distance, angle and coverage behind each choice, plus instructions: view those photos with view_scan_photos (4 per call), mark what you see with a tight 2D box in full-size image pixels, then call lift_scan_semantics. Needs photo keyframes with poses and an OpenGL camera convention. Refusal codes: scan_unavailable, scan_not_found, scan_has_no_capture, scan_manifest_missing, scan_manifest_invalid, no_keyframes, no_walls, camera_convention_unknown.",
  input: {
    scanId,
    perWall: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe('Most keyframes chosen per wall. Default 3.'),
  },
  annotations: read,
} as const

export const liftScanSemanticsTool = {
  name: 'lift_scan_semantics',
  title: 'Lift scan semantics',
  description: `Lift doors, windows and furniture you marked in scan photos to 3D, writing nothing. Each detection is { frameId, label, kind (door | window | opening | furniture), box2d [x0, y0, x1, y1] in pixels of the full-size keyframe, confidence 0 to 1 }. At most ${SEMANTICS_MAX_DETECTIONS} detections on at most ${SEMANTICS_MAX_FRAMES} frames. Each box is mapped into the raw depth (160x90); doors and windows snap to the wall most of the depth beside the box lies on and return position along the wall, width, height and sill; furniture returns a yawed box from the depth points inside the box. Detections of the same thing in several photos merge: two or more photos make it confirmed, one makes it uncertain. A box over a depth hole, an unknown frame or no wall nearby is listed in unlifted with the reason, never guessed. Results are estimates in level metres, with evidence frame ids and the suggested add_door, add_window, search_assets and place_items calls; furniture sizes cover only the surfaces the camera saw. Show them to the person, then create. Refusal codes: scan_unavailable, scan_not_found, scan_has_no_capture, scan_manifest_missing, scan_manifest_invalid, no_keyframes, no_depth, no_walls, too_many_frames, camera_convention_unknown.`,
  input: {
    scanId,
    detections: z
      .array(
        z.object({
          frameId: z.string().min(1).max(128).describe('A keyframe id from plan_scan_semantics.'),
          label: z.string().min(1).max(64).describe('What it is, e.g. "door", "sofa".'),
          kind: z.enum(['door', 'window', 'opening', 'furniture']),
          box2d: z
            .tuple([
              z.number().finite(),
              z.number().finite(),
              z.number().finite(),
              z.number().finite(),
            ])
            .refine(([x0, y0, x1, y1]) => x0 < x1 && y0 < y1, {
              message: 'box2d must be [x0, y0, x1, y1] with x0 < x1 and y0 < y1',
            })
            .describe('[x0, y0, x1, y1] in pixels of the full-size keyframe, origin top left.'),
          confidence: z.number().min(0).max(1),
        }),
      )
      .min(1)
      .max(SEMANTICS_MAX_DETECTIONS),
  },
  annotations: read,
} as const

export const SCAN_SEMANTICS_TOOL_CONTRACTS = [planScanSemanticsTool, liftScanSemanticsTool] as const
