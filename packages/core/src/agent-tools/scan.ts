import { z } from 'zod'
import { SCAN_SEMANTICS_TOOL_CONTRACTS } from './scan-semantics'

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const scanId = z.string().min(1).max(128).describe('A scan node id from list_scans.')

export const listScansTool = {
  name: 'list_scans',
  title: 'List scans',
  description:
    'List the scan nodes in this scene that carry a capture session: provider, creation time, device, the stream kinds present, the keyframe count, and whether manual measurements and planes exist. A scan is a reference layer: it creates no walls. Refusal code: scan_unavailable.',
  input: {},
  annotations: read,
} as const

export const readScanTool = {
  name: 'read_scan',
  title: 'Read scan',
  description:
    "Summarise one scan, compactly: capture metadata (camera axis convention, warnings), manual measurements, a plane summary (floor and ceiling heights, wall lines with lengths in capture-world and in level coordinates through the scan node's transform), keyframe ids with timestamps and tracking state, depth presence and tracking-loss count. It never returns meshes, point arrays or image data. Plane values are detections, not measurements. Refusal codes: scan_unavailable, scan_not_found, scan_has_no_capture, scan_manifest_missing, scan_manifest_invalid.",
  input: { scanId },
  annotations: read,
} as const

export const viewScanPhotosTool = {
  name: 'view_scan_photos',
  title: 'View scan photos',
  description:
    'Return up to 4 keyframe photos of a scan as images, each followed by its pose and intrinsics as text (pose is a column-major camera-to-world matrix in capture-world; level-coordinate position and heading are added when the camera axis convention is known). Name frames by id (frameIds, from read_scan) or let it sample evenly (count, default 3). Total image size is capped; frames left out for size are listed. Refusal codes: scan_unavailable, scan_not_found, scan_has_no_capture, scan_manifest_missing, scan_manifest_invalid, no_keyframes, frame_not_found.',
  input: {
    scanId,
    frameIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(4)
      .optional()
      .describe('Keyframe ids from read_scan. Omit to sample evenly.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe('How many frames to sample evenly when frameIds is omitted. Default 3.'),
  },
  annotations: read,
} as const

export const proposeRoomFromScanTool = {
  name: 'propose_room_from_scan',
  title: 'Propose room from scan',
  description:
    "Propose a room outline from a scan, writing nothing: a closed polygon as [x, z] in metres in the scan's level coordinates, a floor-to-ceiling height, per-edge basis and confidence with the plane ids behind each edge, and unknowns (unseen sides, missing ceiling, assumed placement). Built from the plane set and, when the scan has raw depth, from lines fitted to depth points and the floor plane's outer edge (scans where ARCore found no vertical planes); falls back to a rectangle from manual width and length. Each edge has a basis (plane-estimate, depth-fit, floor-boundary, assumed, manual-measurement), a confidence, evidence ids and a likelyGlass flag; fitted lines are inferences, never measured walls. Every value is an estimate or a guess until the person confirms it on site: show it to them, then call create_room with the polygon (use levelId from this result). Refusal codes: scan_unavailable, scan_not_found, scan_has_no_capture, scan_manifest_missing, scan_manifest_invalid.",
  input: { scanId },
  annotations: read,
} as const

export const viewScanMapTool = {
  name: 'view_scan_map',
  title: 'View scan map',
  description:
    "Return a top-down colour map of a scan as a PNG image (at most about 1024 px on the longest side), built from the scan's raw depth and photo keyframes fused into a coloured point cloud, so walls, floor colour and furniture can be checked by eye before building. Text gives the scale in metres per pixel, the level-coordinate position of the image's top-left corner (+x to the right, +z down the image, like a plan seen from above) and, when it can be computed, the outline from propose_room_from_scan drawn in magenta and listed as [x, z] corners. Layer 'top' shows what is seen from above with the ceiling cut away; 'floor' shows only the floor. Work is bounded in time and bytes: long scans use an even sample of keyframes and the text says what was left out. Needs depth and photo keyframes with poses; the map is an estimate, not a measurement. Refusal codes: scan_unavailable, scan_not_found, scan_has_no_capture, scan_manifest_missing, scan_manifest_invalid, no_depth, no_map.",
  input: {
    scanId,
    layer: z
      .enum(['top', 'floor'])
      .optional()
      .describe(
        "'top' (default) shows everything below the ceiling; 'floor' shows the floor only.",
      ),
    minConfidence: z
      .number()
      .int()
      .min(0)
      .max(255)
      .optional()
      .describe(
        'Lowest depth confidence kept, 0 to 255. Default 128. Many phones report low confidence on most pixels, so a sparse map may improve at 40 to 64 with more noise.',
      ),
    outline: z
      .boolean()
      .optional()
      .describe('Draw the proposed room outline over the map. Default true.'),
  },
  annotations: read,
} as const

/** Offered by a host that can read capture artifacts; it passes them to `createPascalMcpServer`. */
export const SCAN_TOOL_CONTRACTS = [
  listScansTool,
  readScanTool,
  viewScanPhotosTool,
  proposeRoomFromScanTool,
  viewScanMapTool,
  ...SCAN_SEMANTICS_TOOL_CONTRACTS,
] as const
export type ScanToolName = (typeof SCAN_TOOL_CONTRACTS)[number]['name']
