import {
  type BeyondEdge,
  type DepthFrameInput,
  type DepthWallEvidence,
  deriveDepthWalls,
  distanceFromPath,
  floorPolygonsFromPlanes,
  floorSeenAlongEdge,
  measureBeyondEdge,
  pathOutside,
  pointInPolygon,
} from './depth-walls'
import { type CarvedOutline, carveRoomOutline } from './free-space-carving'
import { confirmPartialWalls, type PartialWall, type PartialWallSources } from './partial-walls'
import {
  analysePlanes,
  captureToLevel,
  IDENTITY_SCAN_TRANSFORM,
  type PlaneAnalysis,
  type ScanTransform,
  selectRoomWalls,
  type Vec2,
  type WallSegment,
} from './plane-analysis'
import type { CapturePlane, ManualMeasurements } from './streams'

/**
 * A room outline proposed from a scan, for a person to verify. Nothing here is measured by this
 * code: plane-derived values are estimates from the capture's plane detection, manual values are
 * what someone typed in, and every closing edge guessed from missing evidence says `assumed`.
 */

export type EdgeBasis =
  | 'plane-estimate'
  | 'depth-fit'
  | 'floor-boundary'
  | 'carved'
  | 'manual-measurement'
  | 'assumed'
/** How well the evidence supports an edge. It is not an accuracy in metres. */
export type EdgeConfidence = 'high' | 'medium' | 'low'

export type RoomProposalEdge = {
  /** Edge `index` runs from polygon point `index` to the next, wrapping at the end. */
  index: number
  from: Vec2
  to: Vec2
  length: number
  basis: EdgeBasis
  confidence: EdgeConfidence
  /** Plane ids behind the edge; empty for an assumed or manual edge. */
  evidencePlaneIds: string[]
  /** Every id behind the edge: plane ids, `depth-fit:N`, `floor-boundary:N` and `carved:N` candidates. */
  evidenceIds: string[]
  /** Why the confidence is what it is. */
  reason: string
  /** True when depth runs well past an edge that depth itself did not see: clear glass or an open side. */
  likelyGlass: boolean
  /** Depth structure found past the edge; null when no depth was read. */
  seenBeyond: (BeyondEdge & { note?: string }) | null
}

export type RoomProposal = {
  method: 'planes' | 'depth' | 'planes+depth' | 'carved' | 'manual-measurements' | 'none'
  /** Corners in level coordinates, `[x, z]` in metres, ordered so the shoelace area in (x, z) is positive, which is clockwise seen from above (+Y). Null when no outline could be made. */
  polygon: Vec2[] | null
  height: {
    value: number
    basis: 'plane-estimate' | 'depth-estimate' | 'manual-measurement'
  } | null
  edges: RoomProposalEdge[]
  /** What the scan did not show, and what was guessed to fill it. */
  unknowns: string[]
  floorY: number | null
  planesUsed: string[]
  /** Ids left out with the reason; plane ids, and `depth-fit:N` or `floor-boundary:N` candidates. */
  planesIgnored: Array<{ planeId: string; reason: string }>
  /** What the depth pass found, or null when no depth was read. Fitted lines are inferences, not measured walls. */
  depth: DepthSummary | null
  /**
   * A scan-node transform that puts the detected floor at the level floor (y 0), keeping x, z,
   * rotation and scale, so the polygon stays valid. A suggestion only: nothing is written until the
   * person confirms. North alignment is not included; it is applied only when asked for.
   */
  suggestedScanTransform: {
    position: [number, number, number]
    rotation: [number, number, number]
    scale: number
    /** Low when the floor level is estimated from depth heights or depth disagrees with the plane. */
    confidence: 'low' | 'medium'
    floorBasis: 'plane' | 'depth-histogram'
    note: string
  } | null
  /** Always true: every value is an estimate or a guess until a person confirms it on site. */
  needsVerification: true
}

export type DepthSummary = {
  floorY: number | null
  ceilingY: number | null
  floorBasis: 'given' | 'depth-histogram' | null
  ceilingBasis: 'given' | 'depth-histogram' | null
  framesUsed: number
  candidates: Array<{
    id: string
    basis: 'depth-fit' | 'floor-boundary'
    length: number
    support: number
    rmse: number
    frameIds: string[]
    used: boolean
  }>
  rejected: Array<{ id: string; reason: string }>
  seenThrough: Array<{ id: string; behindId: string; gap: number }>
  /** Whether the walked path was used to check the outline. */
  pathChecked: boolean
  /** The free-space carving pass, when it ran: whether its outline was used and how it compares. */
  carving?: CarvingSummary
}

export type CarvingSummary = {
  used: boolean
  /** Overlap of the carved and line-based outlines as a share of their union, 0 to 1; null when one is missing. */
  agreement: number | null
  /** Why the carved outline was or was not chosen. */
  decision: string
  framesUsed: number
  cellSize: number
  snapAngleDeg: number | null
  necksCut: boolean
}

export type RoomProposalInput = {
  planes: readonly CapturePlane[] | null
  measurements: ManualMeasurements | null
  transform?: ScanTransform
  /** Raw depth frames with the pose of their rgb keyframe, in the capture world. */
  depthFrames?: readonly DepthFrameInput[] | null
  /** The walked path in the capture world, `[x, y, z]` per sample. */
  walkedPath?: ReadonlyArray<readonly [number, number, number]> | null
}

const MERGE_ANGLE = (5 * Math.PI) / 180
const MERGE_OFFSET = 0.15
const MERGE_GAP = 0.75
/** Lines closer to parallel than this (sine of the angle) have no corner. */
const MIN_CORNER_SINE = Math.sin((15 * Math.PI) / 180)
/** How far a wall may run past a corner, and how far it may fall short of one, in metres. */
const CORNER_OVERSHOOT = 0.5
const CORNER_GAP = 1.5
const GOOD_GAP = 0.3
/** Depth structure past an edge that marks clear glass or an open side. */
const BEYOND_MIN_CELLS = 15
const BEYOND_GLASS_SHARE = 0.12
/** A depth-fit edge this far from the walked path, or without floor seen up to it, is rated low. */
const FAR_FROM_PATH = 4
const FLOOR_SEEN_SHARE = 0.5

type Line = {
  /** A point on the line and its unit direction. */
  q: Vec2
  d: Vec2
  tMin: number
  tMax: number
  length: number
  /** Ids of every segment merged into the line. */
  planeIds: string[]
  /** The strongest basis among them: planes over depth fits over floor boundaries. */
  basis: LineBasis
  /** The members that are real plane ids; the others are depth or floor-boundary candidates. */
  realPlaneIds: string[]
  /**
   * Set when the line's only planes cover part of the wall height: the highest confidence its edge
   * may get and why the planes were used. Null when a full-height plane backs it, or no plane does.
   */
  partial: {
    cap: 'medium' | 'low'
    ids: string[]
    reasons: string[]
    /** Unit normal towards the room, from the planes; null when they could not tell. */
    front: Vec2 | null
  } | null
}

/** The vertical planes taken as walls, and the rest with the reason. */
type ChosenWalls = {
  walls: WallSegment[]
  partial: PartialWall[]
  rejected: Array<{ planeId: string; reason: string }>
}

/** Planes must cover this much of a merged line before it counts as plane-based. */
const PLANE_SHARE = 0.6

type LineBasis = 'plane-estimate' | 'depth-fit' | 'floor-boundary'
const BASIS_RANK: Record<LineBasis, number> = {
  'plane-estimate': 3,
  'depth-fit': 2,
  'floor-boundary': 1,
}

/** Where each wall segment id came from; plane ids are the default. */
type SegmentSources = ReadonlyMap<string, LineBasis>

const basisOfId = (sources: SegmentSources, id: string): LineBasis =>
  sources.get(id) ?? 'plane-estimate'

export function proposeRoomFromPlanes(
  planes: readonly CapturePlane[],
  transform: ScanTransform = IDENTITY_SCAN_TRANSFORM,
): RoomProposal {
  const analysis = analysePlanes(planes, transform)
  return fromAnalysis(
    analysis,
    confirmWalls(selectRoomWalls(analysis), {
      depth: null,
      carved: null,
      floorPolygons: analysis.floor
        ? floorPolygonsFromPlanes(planes, transform, analysis.floor.y)
        : [],
      path: new Float32Array(0),
    }),
  )
}

/** Full-height planes as walls, plus the partial planes `confirmPartialWalls` takes as wall evidence. */
function confirmWalls(
  selected: ReturnType<typeof selectRoomWalls>,
  sources: Omit<PartialWallSources, 'walls'>,
): ChosenWalls {
  const confirmed = confirmPartialWalls(selected.partial, { ...sources, walls: selected.walls })
  return {
    walls: selected.walls,
    partial: confirmed.partial,
    rejected: [...selected.rejected, ...confirmed.rejected],
  }
}

/** True when the proposal has an outline with no assumed edge. */
function closes(proposal: RoomProposal | null): boolean {
  return Boolean(proposal?.polygon) && proposal!.edges.every((edge) => edge.basis !== 'assumed')
}

/**
 * Plane set first, manual measurements as a rectangle when the planes give no outline. Writes
 * nothing; the caller creates the room after the person has checked the numbers.
 */
export function proposeRoom(input: RoomProposalInput): RoomProposal {
  const transform = input.transform ?? IDENTITY_SCAN_TRANSFORM
  if (!(Number.isFinite(transform.scale) && transform.scale > 0)) {
    return emptyProposal([
      `The scan node's scale is ${transform.scale}; it must be above zero before anything can be placed. Fix the node, then ask again.`,
    ])
  }
  const analysis = input.planes ? analysePlanes(input.planes, transform) : null
  const manual = input.measurements
  const unknowns: string[] = []
  const path = walkedPathToLevel(input.walkedPath ?? null, transform)
  const floorPolygons =
    analysis?.floor && input.planes
      ? floorPolygonsFromPlanes(input.planes, transform, analysis.floor.y)
      : []

  // Planes alone first. Depth is read as well, for glass and path checks and to confirm planes that
  // cover part of a wall's height, but it only supplies walls when the planes leave the outline open
  // or missing.
  const selected = analysis ? selectRoomWalls(analysis) : null
  const fullPlanes =
    analysis && selected
      ? fromAnalysis(analysis, { walls: selected.walls, partial: [], rejected: selected.rejected })
      : null
  const depthFrames = input.depthFrames ?? []
  const evidence =
    depthFrames.length > 0
      ? deriveDepthWalls(depthFrames, {
          transform,
          floorY: analysis?.floor?.y ?? null,
          ceilingY: analysis?.ceiling?.y ?? null,
          typedHeight: manual?.room.height ?? null,
          path,
          floorPolygons,
        })
      : null

  // Free-space carving is a third evidence source for the outline, and tells a partial plane from
  // furniture standing in the room. It runs when full-height planes did not close the outline and
  // is chosen by `chooseOutline`.
  const carved =
    depthFrames.length > 0 && !closes(fullPlanes)
      ? carveRoomOutline(depthFrames, {
          transform,
          floorY: analysis?.floor?.y ?? null,
          ceilingY: analysis?.ceiling?.y ?? null,
          typedHeight: manual?.room.height ?? null,
          path,
          floorPolygons,
        })
      : null
  const chosen = selected
    ? confirmWalls(selected, { depth: evidence, carved, floorPolygons, path })
    : null
  const planesOnly =
    analysis && chosen && selected!.partial.length > 0 ? fromAnalysis(analysis, chosen) : fullPlanes
  // Planes on part of the wall height may be furniture fronts, so an outline that needs one of them
  // to close still lets depth lines in to contest those edges.
  const partialIds = new Set(chosen?.partial.map((wall) => wall.planeId))
  const planesClosed =
    closes(planesOnly) &&
    planesOnly!.edges.every((edge) => !edge.evidencePlaneIds.every((id) => partialIds.has(id)))
  const combined = evidence && !planesClosed ? fromAnalysis(analysis, chosen, evidence, path) : null
  const fromLines =
    combined && (combined.polygon || !planesOnly?.polygon) ? combined : (planesOnly ?? null)
  const choice = chooseOutline(fromLines, carved, path)
  const fromPlanes =
    choice.useCarved && carved ? proposalFromCarved(carved, fromLines, evidence, path) : fromLines

  let proposal: RoomProposal
  if (fromPlanes?.polygon) {
    proposal = fromPlanes
  } else {
    const rectangle = manual ? manualRectangle(manual, transform) : null
    const why = fromPlanes ? fromPlanes.unknowns : ['The scan has no plane set or depth.']
    if (rectangle) {
      proposal = {
        ...rectangle,
        unknowns: [...why.map((text) => `No outline from planes: ${text}`), ...rectangle.unknowns],
        planesIgnored: fromPlanes?.planesIgnored ?? [],
        depth: fromPlanes?.depth ?? null,
      }
    } else {
      proposal = {
        ...emptyProposal([
          ...why,
          'No usable manual width and length either.',
          'Ask the person for the room width, length and height, or rescan.',
        ]),
        floorY: fromPlanes?.floorY ?? null,
        planesIgnored: fromPlanes?.planesIgnored ?? [],
        depth: fromPlanes?.depth ?? null,
      }
    }
  }
  if (evidence && proposal.depth === null)
    proposal = { ...proposal, depth: summariseDepth(evidence, [], path.length > 0) }
  if (carved && proposal.depth) {
    proposal = {
      ...proposal,
      depth: {
        ...proposal.depth,
        carving: {
          used: choice.useCarved,
          agreement: choice.agreement,
          decision: choice.decision,
          framesUsed: carved.stats.framesUsed,
          cellSize: carved.stats.cellSize,
          snapAngleDeg: carved.stats.snapAngleDeg,
          necksCut: carved.stats.necksCut,
        },
      },
    }
  }

  if (analysis) unknowns.push(...analysis.notes)
  if (evidence) unknowns.push(...evidence.notes)
  if (evidence && !analysis?.floor) {
    unknowns.push(
      'No floor plane was detected, so clear glass cannot be ruled out: depth-fit edges may include space seen through glass.',
    )
  }
  for (const item of evidence?.ambiguous ?? []) {
    unknowns.push(
      `Ambiguous boundary: a wall was measured about ${item.wallDistance} m from the walked path (${item.wallId}), but the floor plane ends at about ${item.floorDistance} m (${item.floorBoundaryId}) with floor seen in between. The measured wall is used; if there is glass at the floor edge, the room is smaller. Check on site.`,
    )
  }
  if (evidence && proposal.polygon && proposal.method !== 'manual-measurements') {
    proposal = annotateEdges(proposal, evidence, unknowns, path)
  }
  if (path.length > 0 && proposal.polygon && proposal.method !== 'manual-measurements') {
    const { outside, total } = pathOutside(path, proposal.polygon)
    if (outside > 0) {
      unknowns.push(
        `The outline leaves ${outside} of ${total} walked-path points outside it. The phone cannot have walked through a wall, so at least one edge is wrong or a side is missing; do not build on it until it is checked.`,
      )
    }
  }

  // Typed values are real metres. The planes' height wins; a typed one fills the gap and is checked.
  const manualHeight = manual?.room.height ?? null
  if (proposal.height === null && manualHeight !== null) {
    proposal = { ...proposal, height: { value: manualHeight, basis: 'manual-measurement' } }
    unknowns.push('The height is a typed-in measurement; no plane confirmed it.')
  } else if (
    proposal.height?.basis === 'plane-estimate' &&
    manualHeight !== null &&
    Math.abs(manualHeight - proposal.height.value) > 0.1
  ) {
    unknowns.push(
      `Planes give a height of ${proposal.height.value} m but the manual measurement says ${manualHeight} m. Check on site.`,
    )
  }
  if (proposal.height === null) unknowns.push('No ceiling height is known: ask the person for it.')

  if (proposal.method === 'planes' && proposal.polygon && manual) {
    const mismatch = dimensionMismatch(proposal.polygon, manual)
    if (mismatch) unknowns.push(mismatch)
  }
  const floorY = proposal.floorY ?? analysis?.floor?.y ?? null
  return {
    ...proposal,
    floorY,
    suggestedScanTransform: suggestTransform(floorY, transform, {
      planeFloor: Boolean(analysis?.floor),
      mismatch: evidence?.vertical.floorMismatch ?? null,
    }),
    unknowns: [...proposal.unknowns, ...unknowns],
  }
}

/** Most walked-path points that may lie outside a carved outline before it is rejected. */
const CARVED_PATH_OUTSIDE = 0.02
/** At most this share of positions dropped by the doorway cut is excused from the path check. */
const CARVED_MAX_DROPPED = 0.1
/** Vetoes against a line outline that is mostly backed by walls. */
const CARVED_MIN_AGREEMENT = 0.7
const CARVED_MIN_AREA_SHARE = 0.8
const CARVED_MAX_CORNERS = 12
/** A carved outline with more than this share of likely-glass edges is mostly open or glass. */
const CARVED_GLASS_SHARE = 0.5

type OutlineChoice = { useCarved: boolean; agreement: number | null; decision: string }

/**
 * Which outline to use. The rule:
 * 1. A carved outline that crosses itself, leaves the walked path outside it, or is mostly
 *    glass-flagged is never used.
 * 2. With no outline from planes or fitted lines, the carved outline is used.
 * 3. With an outline whose every edge rests on a plane or a fitted line and is not rated low, that
 *    outline is kept: carving only reports how much it overlaps.
 * 4. Otherwise the walls are sparse (an assumed, floor-boundary or low edge) and the carved outline
 *    is used, unless it is vetoed: a carved outline with over 12 corners and under half its edges
 *    rated medium is not used, and neither is one that, against a line outline of which at least
 *    half the edges are backed by a plane or fitted line, agrees under 70% or has under 80% of its
 *    area (noise shrinks free-space outlines). The overlap between the two is reported either way.
 */
export function chooseOutline(
  lines: RoomProposal | null,
  carved: CarvedOutline | null,
  path: Float32Array,
): OutlineChoice {
  if (!carved) return { useCarved: false, agreement: null, decision: '' }
  const polygon = carved.polygon
  if (!polygon || polygon.length < 3) {
    return {
      useCarved: false,
      agreement: null,
      decision: `The carved outline was not used: ${carved.notes.at(-1) ?? 'no outline'}`,
    }
  }
  if (selfIntersects(polygon)) {
    return {
      useCarved: false,
      agreement: null,
      decision: 'The carved outline was not used: it crosses itself.',
    }
  }
  if (path.length > 0) {
    // Positions in a part the doorway cut dropped are left out on purpose and reported in the notes.
    const dropped =
      carved.stats.positions > 0 ? carved.stats.droppedPositions / carved.stats.positions : 0
    const { outside, total } = pathOutside(path, polygon)
    if (
      total > 0 &&
      outside / total > CARVED_PATH_OUTSIDE + Math.min(dropped, CARVED_MAX_DROPPED)
    ) {
      return {
        useCarved: false,
        agreement: null,
        decision: `The carved outline was not used: it leaves ${outside} of ${total} walked-path points outside it.`,
      }
    }
  }
  const agreement = lines?.polygon ? polygonAgreement(lines.polygon, polygon) : null
  const overlap =
    agreement === null
      ? ''
      : ` It overlaps the outline from planes and lines by ${Math.round(agreement * 100)}%.`
  const glassShare = carved.edges.filter((edge) => edge.likelyGlass).length / carved.edges.length
  if (glassShare > CARVED_GLASS_SHARE) {
    return {
      useCarved: false,
      agreement,
      decision: `The carved outline was not used: most of its edges are likely glass or open sides.${overlap}`,
    }
  }
  if (!lines?.polygon) {
    return {
      useCarved: true,
      agreement,
      decision: 'Planes and fitted lines gave no outline, so the carved outline was used.',
    }
  }
  const backed = lines.edges.every(
    (edge) =>
      (edge.basis === 'plane-estimate' || edge.basis === 'depth-fit') && edge.confidence !== 'low',
  )
  if (backed) {
    return {
      useCarved: false,
      agreement,
      decision: `Every edge of the outline from planes and lines rests on a wall, so it was kept.${overlap}`,
    }
  }
  const backedEdges = lines.edges.filter(
    (edge) => edge.basis === 'plane-estimate' || edge.basis === 'depth-fit',
  ).length
  const mostlyBacked = backedEdges >= lines.edges.length / 2
  const linesArea = polygonArea(lines.polygon)
  const carvedArea = polygonArea(polygon)
  const medium = carved.edges.filter((edge) => edge.confidence === 'medium').length
  const veto =
    polygon.length > CARVED_MAX_CORNERS && medium < carved.edges.length / 2
      ? `it has ${polygon.length} corners and under half its edges are rated medium`
      : mostlyBacked && agreement !== null && agreement < CARVED_MIN_AGREEMENT
        ? `it overlaps the line outline by only ${Math.round(agreement * 100)}%, and most of that outline's edges rest on a wall`
        : mostlyBacked && carvedArea < CARVED_MIN_AREA_SHARE * linesArea
          ? `its area (${round(carvedArea, 1)} m²) is under 80% of the line outline's (${round(linesArea, 1)} m²), which noise in free space causes, and most of that outline's edges rest on a wall`
          : null
  if (veto) {
    return { useCarved: false, agreement, decision: `The carved outline was not used: ${veto}.` }
  }
  return {
    useCarved: true,
    agreement,
    decision: `Walls are sparse: the outline from planes and lines has assumed, floor-boundary or low-confidence edges, so the carved outline was used.${overlap}`,
  }
}

function polygonArea(points: readonly Vec2[]): number {
  let sum = 0
  points.forEach(([x1, z1], index) => {
    const [x2, z2] = points[(index + 1) % points.length]!
    sum += x1 * z2 - x2 * z1
  })
  return Math.abs(sum) / 2
}

/** Overlap of two outlines as a share of their union, from points on a 0.1 m grid. */
function polygonAgreement(a: readonly Vec2[], b: readonly Vec2[]): number {
  const xs = [...a, ...b].map((p) => p[0])
  const zs = [...a, ...b].map((p) => p[1])
  const minX = Math.min(...xs)
  const minZ = Math.min(...zs)
  const step = Math.max(0.1, Math.max(Math.max(...xs) - minX, Math.max(...zs) - minZ) / 300)
  let both = 0
  let either = 0
  for (let x = minX + step / 2; x < Math.max(...xs); x += step) {
    for (let z = minZ + step / 2; z < Math.max(...zs); z += step) {
      const inA = pointInPolygon([x, z], a)
      const inB = pointInPolygon([x, z], b)
      if (inA || inB) either += 1
      if (inA && inB) both += 1
    }
  }
  return either === 0 ? 0 : round(both / either, 3)
}

/** The proposal for a carved outline, keeping what the line-based pass found for the rest. */
function proposalFromCarved(
  carved: CarvedOutline,
  lines: RoomProposal | null,
  evidence: DepthWallEvidence | null,
  path: Float32Array,
): RoomProposal {
  const polygon = carved.polygon!
  const edges = carved.edges.map(
    (edge): RoomProposalEdge => ({
      index: edge.index,
      from: edge.from,
      to: edge.to,
      length: edge.length,
      basis: 'carved',
      confidence: edge.confidence,
      evidencePlaneIds: [],
      evidenceIds: [`carved:${edge.index}`],
      reason: edge.reason,
      likelyGlass: edge.likelyGlass,
      seenBeyond: edge.beyond,
    }),
  )
  const ordered = counterClockwise(polygon, edges)
  const { floorY, ceilingY } = carved.vertical
  const unknowns = [
    "The outline is the free space the camera's depth rays crossed, traced and squared to the dominant wall direction. It is an inference from where the camera saw empty space, not measured walls; check every edge on site.",
    ...(carved.stats.snapAngleDeg === null
      ? ['No clear right-angle wall direction was found, so no wall was squared.']
      : [
          `Walls within 12 degrees of the dominant direction (about ${carved.stats.snapAngleDeg} degrees) were squared to it; walls clearly off it keep their own angle.`,
        ]),
    ...carved.notes,
  ]
  return {
    method: 'carved',
    polygon: ordered.points,
    height:
      lines?.height ??
      (floorY !== null && ceilingY !== null
        ? { value: round(ceilingY - floorY, 2), basis: 'depth-estimate' }
        : null),
    edges: ordered.edges,
    unknowns,
    floorY: lines?.floorY ?? floorY,
    planesUsed: [],
    planesIgnored: lines?.planesIgnored ?? [],
    depth: lines?.depth ?? (evidence ? summariseDepth(evidence, [], path.length > 0) : null),
    suggestedScanTransform: null,
    needsVerification: true,
  }
}

function suggestTransform(
  floorY: number | null,
  transform: ScanTransform,
  floor: { planeFloor: boolean; mismatch: number | null },
): RoomProposal['suggestedScanTransform'] {
  if (floorY === null || Math.abs(floorY) < 0.02) return null
  // A floor from a plane that depth agrees with is a medium-confidence suggestion; one estimated
  // from depth heights, or one depth disagrees with, is low and says so.
  const confidence = floor.planeFloor && floor.mismatch === null ? 'medium' : 'low'
  const why = !floor.planeFloor
    ? 'The floor level is estimated from depth heights, not a detected plane.'
    : floor.mismatch !== null
      ? `Depth heights disagree with the floor plane by ${floor.mismatch} m, so the floor level is uncertain.`
      : 'The floor is the largest detected upward plane.'
  return {
    position: [transform.position[0], round(transform.position[1] - floorY), transform.position[2]],
    rotation: [transform.rotation[0], transform.rotation[1], transform.rotation[2]],
    scale: transform.scale,
    confidence,
    floorBasis: floor.planeFloor ? 'plane' : 'depth-histogram',
    note: `Estimated floor at level y ${round(floorY)} m. Moving the scan node's y by ${round(-floorY)} m would put it on the level floor; the polygon's x and z do not change. ${why} Apply only after the person confirms.`,
  }
}

function emptyProposal(unknowns: string[]): RoomProposal {
  return {
    method: 'none',
    polygon: null,
    height: null,
    edges: [],
    unknowns,
    floorY: null,
    planesUsed: [],
    planesIgnored: [],
    depth: null,
    suggestedScanTransform: null,
    needsVerification: true,
  }
}

/** The outline's size along its longest edge and across it, against the typed width and length. */
function dimensionMismatch(polygon: readonly Vec2[], manual: ManualMeasurements): string | null {
  const { width, length } = manual.room
  if (width === null || length === null) return null
  let best: { dx: number; dz: number; size: number } | null = null
  polygon.forEach(([x1, z1], index) => {
    const [x2, z2] = polygon[(index + 1) % polygon.length]!
    const size = Math.hypot(x2 - x1, z2 - z1)
    if (!best || size > best.size) best = { dx: (x2 - x1) / size, dz: (z2 - z1) / size, size }
  })
  if (!best) return null
  const { dx, dz } = best as { dx: number; dz: number }
  const along = polygon.map(([x, z]) => x * dx + z * dz)
  const across = polygon.map(([x, z]) => -x * dz + z * dx)
  const extents = [
    Math.max(...along) - Math.min(...along),
    Math.max(...across) - Math.min(...across),
  ].sort((left, right) => right - left)
  const typed = [width, length].sort((left, right) => right - left)
  const off = extents.some(
    (value, index) =>
      Math.abs(value - typed[index]!) > 0.2 &&
      Math.abs(value - typed[index]!) / typed[index]! > 0.1,
  )
  return off
    ? `The plane outline is about ${round(extents[0]!, 2)} x ${round(extents[1]!, 2)} m but the typed room is ${typed[0]} x ${typed[1]} m. One of them is wrong; check on site.`
    : null
}

function manualRectangle(
  measurements: ManualMeasurements,
  transform: ScanTransform,
): RoomProposal | null {
  const { width, length } = measurements.room
  if (width === null || length === null) return null
  // Typed values are real metres, so only the node's origin and rotation place them, not its scale.
  const placement = { ...transform, scale: 1 }
  const corners = (
    [
      [0, 0],
      [width, 0],
      [width, length],
      [0, length],
    ] as const
  ).map(([x, z]): Vec2 => {
    const point = captureToLevel(placement, [x, 0, z])
    return [round(point[0]), round(point[2])]
  })
  const { points: polygon } = counterClockwise(corners)
  return {
    method: 'manual-measurements',
    polygon,
    height:
      measurements.room.height === null
        ? null
        : { value: measurements.room.height, basis: 'manual-measurement' },
    edges: polygon.map((from, index) => {
      const to = polygon[(index + 1) % polygon.length]!
      return {
        index,
        from,
        to,
        length: round(Math.hypot(to[0] - from[0], to[1] - from[1])),
        basis: 'manual-measurement',
        confidence: 'low',
        evidencePlaneIds: [],
        evidenceIds: [],
        reason: 'Length is a typed-in measurement; where the room sits is assumed.',
        likelyGlass: false,
        seenBeyond: null,
      }
    }),
    unknowns: [
      'Only width and length were measured by hand, so the outline is a rectangle.',
      'Placement and rotation are assumed: the rectangle starts at the scan node origin and follows its rotation. Move it to the real room before building on it.',
    ],
    floorY: null,
    planesUsed: [],
    planesIgnored: [],
    depth: null,
    suggestedScanTransform: null,
    needsVerification: true,
  }
}

function walkedPathToLevel(
  walked: ReadonlyArray<readonly [number, number, number]> | null,
  transform: ScanTransform,
): Float32Array {
  if (!walked) return new Float32Array(0)
  const out = new Float32Array(walked.length * 2)
  walked.forEach((point, index) => {
    const level = captureToLevel(transform, point)
    out[index * 2] = level[0]
    out[index * 2 + 1] = level[2]
  })
  return out
}

function summariseDepth(
  evidence: DepthWallEvidence,
  used: readonly string[],
  pathChecked: boolean,
): DepthSummary {
  const usedIds = new Set(used)
  return {
    ...evidence.vertical,
    framesUsed: evidence.stats.framesUsed,
    candidates: evidence.candidates.map((candidate) => ({
      id: candidate.id,
      basis: candidate.basis,
      length: candidate.length,
      support: candidate.support,
      rmse: candidate.rmse,
      frameIds: candidate.frameIds,
      used: usedIds.has(candidate.id),
    })),
    rejected: evidence.rejected.map(({ id, reason }) => ({ id, reason })),
    seenThrough: evidence.seenThrough,
    pathChecked,
  }
}

function fromAnalysis(
  analysis: PlaneAnalysis | null,
  chosen: ChosenWalls | null,
  depth: DepthWallEvidence | null = null,
  path: Float32Array = new Float32Array(0),
): RoomProposal {
  const unknowns: string[] = []
  const planesIgnored = analysis ? [...analysis.skipped] : []
  const planeHeight = analysis?.height ?? null
  const depthHeight =
    depth?.vertical.floorY !== null &&
    depth?.vertical.floorY !== undefined &&
    depth.vertical.ceilingY !== null
      ? depth.vertical.ceilingY - depth.vertical.floorY
      : null
  const height =
    planeHeight !== null
      ? { value: planeHeight, basis: 'plane-estimate' as const }
      : depthHeight !== null
        ? { value: round(depthHeight, 2), basis: 'depth-estimate' as const }
        : null

  const selected = chosen ?? { walls: [], partial: [], rejected: [] }
  planesIgnored.push(...selected.rejected)
  const sources = new Map<string, LineBasis>()
  const partialById = new Map(selected.partial.map((wall) => [wall.planeId, wall]))
  const segments: WallSegment[] = [...selected.walls, ...selected.partial]
  if (depth) {
    const floorY = analysis?.floor?.y ?? depth.vertical.floorY ?? 0
    const top = depth.vertical.ceilingY ?? floorY + 2.4
    for (const candidate of depth.candidates) {
      sources.set(candidate.id, candidate.basis)
      segments.push({
        planeId: candidate.id,
        a: candidate.a,
        b: candidate.b,
        length: candidate.length,
        bottom: floorY,
        top,
      })
    }
    for (const rejected of depth.rejected) {
      planesIgnored.push({ planeId: rejected.id, reason: rejected.reason })
    }
  }
  const competing = dropCompetingLines(mergeWalls(segments, sources, partialById))
  const lines = competing.lines
  for (const dropped of competing.dropped) planesIgnored.push(...dropped)
  const base = {
    height,
    floorY: analysis?.floor?.y ?? depth?.vertical.floorY ?? null,
    planesIgnored,
    suggestedScanTransform: null,
    needsVerification: true as const,
  }
  const hasPlaneLine = (indexes: Iterable<number>) =>
    [...indexes].some((index) => lines[index]!.basis === 'plane-estimate')
  const finish = (
    partial: Omit<RoomProposal, keyof typeof base | 'depth'>,
    usedLines: number[],
  ): RoomProposal => {
    const usedIds = [...new Set(usedLines.flatMap((index) => lines[index]!.planeIds))]
    const depthUsed = usedIds.filter((id) => sources.has(id))
    const method = depth
      ? depthUsed.length === 0
        ? 'planes'
        : hasPlaneLine(usedLines)
          ? 'planes+depth'
          : 'depth'
      : 'planes'
    return {
      ...base,
      ...partial,
      method: partial.polygon ? method : 'planes',
      depth: depth ? summariseDepth(depth, depthUsed, path.length > 0) : null,
    }
  }
  const walk = lines.length >= 3 ? bestWalk(lines) : null
  const pair = walk ? null : parallelPair(lines)
  if (!walk && !pair) {
    return finish(
      {
        method: 'planes',
        polygon: null,
        edges: [],
        unknowns: [
          lines.length < 3
            ? `Only ${lines.length} usable wall line${lines.length === 1 ? '' : 's'} found; at least three are needed to outline a room.`
            : 'The wall lines do not meet at corners, so no outline could be built.',
        ],
        planesUsed: [],
      },
      [],
    )
  }

  const order = walk ? walk.order : pair!.order
  const used = new Set(order)
  lines.forEach((line, index) => {
    if (used.has(index)) return
    for (const planeId of line.planeIds) {
      planesIgnored.push({ planeId, reason: 'a wall line that does not join the outline' })
    }
  })

  const built = walk ? buildOutline(lines, walk) : buildPairOutline(lines, pair!)
  unknowns.push(...built.unknowns)
  let ordered = counterClockwise(built.points, built.edges)
  if (path.length > 0) {
    const enclosed = enclosePath(ordered.points, ordered.edges, path)
    ordered = { points: enclosed.points, edges: enclosed.edges }
    unknowns.push(...enclosed.notes)
  }
  if (selfIntersects(ordered.points)) {
    unknowns.push('The outline crosses itself; treat it as a rough guide and check the corners.')
  }
  const usedIds = new Set(order.flatMap((index) => lines[index]!.planeIds))
  const partialUsed = [...usedIds].filter((id) => partialById.has(id))
  if (partialUsed.length > 0) {
    unknowns.push(
      `Wall plane${partialUsed.length === 1 ? '' : 's'} ${partialUsed.join(', ')} cover${partialUsed.length === 1 ? 's' : ''} only part of the wall height (ARCore often sees only the lower part of a plain wall). ${partialUsed.length === 1 ? 'It was' : 'They were'} used because another source agrees or ${partialUsed.length === 1 ? 'it is' : 'they are'} wide and outside the walked area, but a cabinet or bed front can look the same, so edges resting on them are rated medium at most. Check them on site.`,
    )
  }
  if (depth && [...usedIds].some((id) => sources.has(id))) {
    unknowns.push(
      'Some edges are lines fitted to depth points or floor-plane edges. They are inferences from points the camera saw, not measured walls; check them on site.',
    )
  }
  return finish(
    {
      method: 'planes',
      polygon: ordered.points,
      edges: ordered.edges,
      unknowns,
      planesUsed: [...usedIds].filter((id) => !sources.has(id)),
    },
    [...order],
  )
}

/** Parallel lines this close, overlapping along their run, compete for one wall. */
const COMPETE_OFFSET = 0.6
const COMPETE_OVERLAP = 0.3

/**
 * Where two parallel lines sit within `COMPETE_OFFSET` and overlap, they are one wall seen twice
 * (a furniture back, a mirror ghost, a second pass), not two walls: the longer line stays.
 */
function dropCompetingLines(lines: Line[]): {
  lines: Line[]
  dropped: Array<Array<{ planeId: string; reason: string }>>
} {
  // Planes outrank depth fits, which outrank floor boundaries; full-height planes outrank planes on
  // part of the wall height; within a rank the longer line wins.
  const rank = (line: Line) =>
    BASIS_RANK[line.basis] * 2 + (line.basis === 'plane-estimate' && line.partial ? 0 : 1)
  const order = lines
    .map((_, index) => index)
    .sort((i, j) => rank(lines[j]!) - rank(lines[i]!) || lines[j]!.length - lines[i]!.length)
  const kept: number[] = []
  const dropped: Array<Array<{ planeId: string; reason: string }>> = []
  for (const index of order) {
    const line = lines[index]!
    const rivals = kept.filter((other) => competes(lines[other]!, line))
    if (rivals.length === 0) {
      kept.push(index)
      continue
    }
    // A depth line behind planes that cover only part of the wall height is the wall, and the
    // planes are a furniture front, even where they outrank it.
    const behind = rivals.map((other) => depthBehindPartial(lines[other]!, line))
    if (behind.every((gap) => gap !== null)) {
      rivals.forEach((other, k) => {
        dropped.push(
          lines[other]!.planeIds.map((planeId) => ({
            planeId,
            reason: `a line fitted to depth points (${line.planeIds.join(', ')}) runs ${round(behind[k]!, 2)} m behind it, and it rests only on planes covering part of the wall height: furniture in front of the wall`,
          })),
        )
        kept.splice(kept.indexOf(other), 1)
      })
      kept.push(index)
      continue
    }
    const rival = rivals[0]!
    const gap = Math.abs(
      (line.q[0] - lines[rival]!.q[0]) * -lines[rival]!.d[1] +
        (line.q[1] - lines[rival]!.q[1]) * lines[rival]!.d[0],
    )
    dropped.push(
      line.planeIds.map((planeId) => ({
        planeId,
        reason: `runs parallel to a longer wall ${round(gap, 2)} m away: furniture or a ghost plane`,
      })),
    )
  }
  return { lines: kept.sort((i, j) => i - j).map((index) => lines[index]!), dropped }
}

/** How far a depth-fit line runs behind a line resting only on partial planes; null otherwise. */
function depthBehindPartial(partial: Line, depth: Line): number | null {
  const front = partial.basis === 'plane-estimate' ? partial.partial?.front : null
  if (!front || depth.basis !== 'depth-fit') return null
  const offset = (depth.q[0] - partial.q[0]) * front[0] + (depth.q[1] - partial.q[1]) * front[1]
  return offset < 0 ? -offset : null
}

function competes(a: Line, b: Line): boolean {
  const sine = Math.abs(a.d[0] * b.d[1] - a.d[1] * b.d[0])
  const cosine = Math.abs(a.d[0] * b.d[0] + a.d[1] * b.d[1])
  if (Math.atan2(sine, cosine) > MERGE_ANGLE) return false
  const offset = Math.abs((b.q[0] - a.q[0]) * -a.d[1] + (b.q[1] - a.q[1]) * a.d[0])
  if (offset > COMPETE_OFFSET) return false
  const sign = a.d[0] * b.d[0] + a.d[1] * b.d[1] < 0 ? -1 : 1
  const bStart = (b.q[0] - a.q[0]) * a.d[0] + (b.q[1] - a.q[1]) * a.d[1]
  const lo = bStart + (sign > 0 ? b.tMin : -b.tMax)
  const hi = bStart + (sign > 0 ? b.tMax : -b.tMin)
  return Math.min(a.tMax, hi) - Math.max(a.tMin, lo) >= COMPETE_OVERLAP
}

function mergeWalls(
  walls: readonly WallSegment[],
  sources: SegmentSources,
  partialById: ReadonlyMap<string, PartialWall>,
): Line[] {
  const parent = walls.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]!]!
    return index
  }
  const direction = (wall: WallSegment): Vec2 => {
    const dx = wall.b[0] - wall.a[0]
    const dz = wall.b[1] - wall.a[1]
    const length = Math.hypot(dx, dz)
    return [dx / length, dz / length]
  }
  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      const wi = walls[i]!
      const wj = walls[j]!
      const di = direction(wi)
      const dj = direction(wj)
      const sine = Math.abs(di[0] * dj[1] - di[1] * dj[0])
      const cosine = Math.abs(di[0] * dj[0] + di[1] * dj[1])
      if (Math.atan2(sine, cosine) > MERGE_ANGLE) continue
      const mid: Vec2 = [(wj.a[0] + wj.b[0]) / 2, (wj.a[1] + wj.b[1]) / 2]
      const offset = Math.abs((mid[0] - wi.a[0]) * -di[1] + (mid[1] - wi.a[1]) * di[0])
      if (offset > MERGE_OFFSET) continue
      const ti = [dot(wi.a, di), dot(wi.b, di)].sort((x, y) => x - y)
      const tj = [dot(wj.a, di), dot(wj.b, di)].sort((x, y) => x - y)
      const gap = Math.max(ti[0]! - tj[1]!, tj[0]! - ti[1]!)
      if (gap > MERGE_GAP) continue
      parent[find(j)] = find(i)
    }
  }

  const groups = new Map<number, WallSegment[]>()
  walls.forEach((wall, index) => {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), wall])
  })
  return [...groups.values()].map((group) => {
    const reference = direction(group[0]!)
    let dx = 0
    let dz = 0
    let qx = 0
    let qz = 0
    let weight = 0
    for (const wall of group) {
      const [ux, uz] = direction(wall)
      const sign = ux * reference[0] + uz * reference[1] < 0 ? -1 : 1
      dx += ux * sign * wall.length
      dz += uz * sign * wall.length
      qx += ((wall.a[0] + wall.b[0]) / 2) * wall.length
      qz += ((wall.a[1] + wall.b[1]) / 2) * wall.length
      weight += wall.length
    }
    const norm = Math.hypot(dx, dz)
    const d: Vec2 = [dx / norm, dz / norm]
    const q: Vec2 = [qx / weight, qz / weight]
    const ts = group.flatMap((wall) => [dot(sub(wall.a, q), d), dot(sub(wall.b, q), d)])
    const tMin = Math.min(...ts)
    const tMax = Math.max(...ts)
    const isPlane = (wall: WallSegment) => basisOfId(sources, wall.planeId) === 'plane-estimate'
    const planeLength = group.filter(isPlane).reduce((sum, wall) => sum + wall.length, 0)
    const others = group.filter((wall) => !isPlane(wall))
    // Planes keep the line only when they cover most of it; otherwise its strongest other basis stands.
    const basis: LineBasis =
      planeLength > 0 && (others.length === 0 || planeLength >= PLANE_SHARE * (tMax - tMin))
        ? 'plane-estimate'
        : others.some((wall) => basisOfId(sources, wall.planeId) === 'depth-fit')
          ? 'depth-fit'
          : others.length > 0
            ? 'floor-boundary'
            : 'plane-estimate'
    const realPlaneIds = group.filter(isPlane).map((wall) => wall.planeId)
    const partials = realPlaneIds.flatMap((id) => partialById.get(id) ?? [])
    return {
      q,
      d,
      tMin,
      tMax,
      length: tMax - tMin,
      planeIds: group.map((wall) => wall.planeId),
      basis,
      realPlaneIds,
      partial:
        partials.length > 0 && partials.length === realPlaneIds.length
          ? {
              cap: partials.some((wall) => wall.cap === 'medium') ? 'medium' : 'low',
              ids: partials.map((wall) => wall.planeId),
              reasons: partials.map((wall) => wall.reason),
              front: partials.find((wall) => wall.front)?.front ?? null,
            }
          : null,
    }
  })
}

type Pair = { order: [number, number] }

/**
 * Two roughly parallel walls with the walked path between them, for scans that saw a corridor or one
 * pair of sides. The ends are assumed. Null when no such pair exists.
 */
function parallelPair(lines: readonly Line[]): Pair | null {
  let best: { pair: Pair; score: number } | null = null
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i]!
      const b = lines[j]!
      const sine = Math.abs(a.d[0] * b.d[1] - a.d[1] * b.d[0])
      if (sine > Math.sin((20 * Math.PI) / 180)) continue
      const offset = Math.abs((b.q[0] - a.q[0]) * -a.d[1] + (b.q[1] - a.q[1]) * a.d[0])
      if (offset < 1) continue
      const sign = a.d[0] * b.d[0] + a.d[1] * b.d[1] < 0 ? -1 : 1
      const bStart = (b.q[0] - a.q[0]) * a.d[0] + (b.q[1] - a.q[1]) * a.d[1]
      const lo = bStart + (sign > 0 ? b.tMin : -b.tMax)
      const hi = bStart + (sign > 0 ? b.tMax : -b.tMin)
      const overlap = Math.min(a.tMax, hi) - Math.max(a.tMin, lo)
      if (overlap < 0.5 * Math.min(a.length, b.length)) continue
      const score = a.length + b.length
      if (!best || score > best.score) best = { pair: { order: [i, j] }, score }
    }
  }
  return best?.pair ?? null
}

function buildPairOutline(
  lines: readonly Line[],
  pair: Pair,
): { points: Vec2[]; edges: RoomProposalEdge[]; unknowns: string[] } {
  const a = lines[pair.order[0]]!
  const b = lines[pair.order[1]]!
  const at = (line: Line, t: number): Vec2 => [line.q[0] + line.d[0] * t, line.q[1] + line.d[1] * t]
  const sign = a.d[0] * b.d[0] + a.d[1] * b.d[1] < 0 ? -1 : 1
  const points: Vec2[] = [
    at(a, a.tMin),
    at(a, a.tMax),
    at(b, sign > 0 ? b.tMax : b.tMin),
    at(b, sign > 0 ? b.tMin : b.tMax),
  ]
  const edges: RoomProposalEdge[] = points.map((from, index) => {
    const to = points[(index + 1) % 4]!
    const length = round(Math.hypot(to[0] - from[0], to[1] - from[1]))
    const line = index === 0 ? a : index === 2 ? b : null
    return {
      index,
      from: roundPoint(from),
      to: roundPoint(to),
      length,
      basis: line ? line.basis : 'assumed',
      confidence: 'low',
      evidencePlaneIds: line ? line.realPlaneIds : [],
      evidenceIds: line ? line.planeIds : [],
      reason: line
        ? 'One of two parallel walls seen; its ends are where it was last seen, not corners.'
        : 'No wall was seen across this end; the edge closes the outline.',
      likelyGlass: false,
      seenBeyond: null,
    }
  })
  return {
    points: points.map(roundPoint),
    edges,
    unknowns: ['Only two roughly parallel walls were seen, so both ends of the room are assumed.'],
  }
}

/**
 * The phone cannot have walked through a wall, so an assumed edge that leaves walked-path points
 * outside is pushed outward until it encloses them, and the walls beside it run on to meet it. Edges
 * with evidence are left alone; the move is reported.
 */
function enclosePath(
  points: Vec2[],
  edges: RoomProposalEdge[],
  path: Float32Array,
): { points: Vec2[]; edges: RoomProposalEdge[]; notes: string[] } {
  const next = points.map((point): Vec2 => [point[0], point[1]])
  const notes: string[] = []
  const count = next.length
  for (let k = 0; k < count; k += 1) {
    if (edges[k]!.basis !== 'assumed') continue
    const from = next[k]!
    const to = next[(k + 1) % count]!
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    if (length === 0) continue
    const d: Vec2 = [(to[0] - from[0]) / length, (to[1] - from[1]) / length]
    const centroid = next.reduce<Vec2>(
      (sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count],
      [0, 0],
    )
    let normal: Vec2 = [-d[1], d[0]]
    if ((centroid[0] - from[0]) * normal[0] + (centroid[1] - from[1]) * normal[1] > 0) {
      normal = [-normal[0], -normal[1]]
    }
    let farthest = 0
    for (let i = 0; i < path.length; i += 2) {
      const px = path[i]! - from[0]
      const pz = path[i + 1]! - from[1]
      const t = px * d[0] + pz * d[1]
      if (t < -0.5 || t > length + 0.5) continue
      const out = px * normal[0] + pz * normal[1]
      if (out > farthest) farthest = out
    }
    if (farthest <= 0.1) continue
    const shift = farthest + 0.25
    const base: Vec2 = [from[0] + normal[0] * shift, from[1] + normal[1] * shift]
    const previous = [next[(k + count - 1) % count]!, from] as const
    const following = [to, next[(k + 2) % count]!] as const
    const meet = (line: readonly [Vec2, Vec2], fallback: Vec2): Vec2 => {
      const ldx = line[1][0] - line[0][0]
      const ldz = line[1][1] - line[0][1]
      const cross = d[0] * ldz - d[1] * ldx
      if (Math.abs(cross) < 0.2 * Math.hypot(ldx, ldz)) return fallback
      const t = ((line[0][0] - base[0]) * ldz - (line[0][1] - base[1]) * ldx) / cross
      const point: Vec2 = [base[0] + d[0] * t, base[1] + d[1] * t]
      return Math.hypot(point[0] - fallback[0], point[1] - fallback[1]) > shift + 3
        ? fallback
        : point
    }
    next[k] = meet(previous, base)
    next[(k + 1) % count] = meet(following, [to[0] + normal[0] * shift, to[1] + normal[1] * shift])
    notes.push(
      `Edge ${k} has no wall evidence and was pushed ${round(shift, 2)} m outward so the outline encloses the walked path; its position is a guess.`,
    )
  }
  if (notes.length === 0) return { points, edges, notes }
  return {
    points: next.map(roundPoint),
    edges: edges.map((edge, index) => {
      const from = next[index]!
      const to = next[(index + 1) % count]!
      const length = round(Math.hypot(to[0] - from[0], to[1] - from[1]))
      const grown = length - edge.length
      return {
        ...edge,
        from: roundPoint(from),
        to: roundPoint(to),
        length,
        ...(edge.basis !== 'assumed' && grown > 0.3
          ? {
              confidence: 'low' as const,
              reason: `${edge.reason} It was extended ${round(grown, 2)} m beyond the evidence to meet a moved neighbouring edge.`,
            }
          : {}),
      }
    }),
    notes,
  }
}

type Step = {
  line: number
  /** +1 walks toward `tMax`, -1 toward `tMin`. */
  sign: 1 | -1
  /** Where the walk meets the previous line, as a parameter of this line; null for the first. */
  entry: number | null
  /** Distance the previous line fell short of this corner, and this line's own gap to it. */
  gaps: [number, number]
}

type Walk = { order: number[]; steps: Step[]; closed: boolean; totalGap: number }

function bestWalk(lines: readonly Line[]): Walk | null {
  let best: Walk | null = null
  for (let start = 0; start < lines.length; start += 1) {
    for (const sign of [1, -1] as const) {
      const walk = walkFrom(lines, start, sign)
      if (!walk || walk.order.length < 3) continue
      if (!best || betterWalk(walk, best, lines)) {
        best = walk
      }
    }
  }
  return best
}

/** Closed loops first, then the most wall length covered (not line count), then the tightest corners. */
function betterWalk(walk: Walk, best: Walk, lines: readonly Line[]): boolean {
  if (walk.closed !== best.closed) return walk.closed
  const covered = (candidate: Walk) =>
    candidate.order.reduce((sum, index) => sum + lines[index]!.length, 0)
  const difference = covered(walk) - covered(best)
  if (Math.abs(difference) > 1e-6) return difference > 0
  return walk.totalGap < best.totalGap - 1e-9
}

function walkFrom(lines: readonly Line[], start: number, startSign: 1 | -1): Walk | null {
  const steps: Step[] = [{ line: start, sign: startSign, entry: null, gaps: [0, 0] }]
  const visited = new Set([start])
  let closed = false
  let totalGap = 0
  for (;;) {
    const current = steps[steps.length - 1]!
    const line = lines[current.line]!
    const end = current.sign > 0 ? line.tMax : line.tMin
    let pick: { step: Step; score: number } | null = null
    for (let index = 0; index < lines.length; index += 1) {
      const isStart = index === start
      if (visited.has(index) && !(isStart && steps.length >= 3)) continue
      const candidate = lines[index]!
      const corner = intersect(line, candidate)
      if (!corner) continue
      const forward = current.sign * (corner.t - end)
      if (forward < -CORNER_OVERSHOOT || forward > CORNER_GAP) continue
      const outside = Math.max(0, candidate.tMin - corner.u, corner.u - candidate.tMax)
      if (outside > CORNER_GAP) continue
      const toMin = Math.abs(corner.u - candidate.tMin)
      const toMax = Math.abs(candidate.tMax - corner.u)
      const sign = toMax >= toMin ? 1 : -1
      if (Math.max(toMin, toMax) < 0.3) continue
      const score = Math.max(0, forward) + outside
      if (!pick || score < pick.score) {
        pick = {
          step: { line: index, sign, entry: corner.u, gaps: [Math.max(0, forward), outside] },
          score,
        }
      }
    }
    if (!pick) break
    totalGap += pick.score
    if (pick.step.line === start) {
      // Close the loop: the corner between the last line and the first.
      steps[0] = { ...steps[0]!, entry: pick.step.entry, gaps: pick.step.gaps }
      closed = true
      break
    }
    steps.push(pick.step)
    visited.add(pick.step.line)
    if (steps.length > lines.length) break
  }
  return { order: steps.map((step) => step.line), steps, closed, totalGap }
}

function buildOutline(
  lines: readonly Line[],
  walk: Walk,
): { points: Vec2[]; edges: RoomProposalEdge[]; unknowns: string[] } {
  const { steps, closed } = walk
  const unknowns: string[] = []
  const at = (line: Line, t: number): Vec2 => [line.q[0] + line.d[0] * t, line.q[1] + line.d[1] * t]
  const points: Vec2[] = []

  // Corner k joins step k and the next; for a closed loop the last joins back to the first.
  const corners: Vec2[] = []
  for (let k = 0; k < steps.length - (closed ? 0 : 1); k += 1) {
    const next = steps[(k + 1) % steps.length]!
    corners.push(at(lines[next.line]!, next.entry!))
  }

  if (closed) {
    // Edge i lies on step i, from corner i - 1 to corner i.
    for (let i = 0; i < steps.length; i += 1)
      points.push(corners[(i + steps.length - 1) % steps.length]!)
  } else {
    const first = steps[0]!
    const firstLine = lines[first.line]!
    const last = steps[steps.length - 1]!
    const lastLine = lines[last.line]!
    points.push(at(firstLine, first.sign > 0 ? firstLine.tMin : firstLine.tMax), ...corners)
    points.push(at(lastLine, last.sign > 0 ? lastLine.tMax : lastLine.tMin))
    unknowns.push(
      'One side of the room was not seen. The closing edge is a straight guess between the last wall end and the first.',
    )
  }

  const edges: RoomProposalEdge[] = []
  const wallEdges = steps.length
  for (let i = 0; i < points.length; i += 1) {
    const from = points[i]!
    const to = points[(i + 1) % points.length]!
    const length = round(Math.hypot(to[0] - from[0], to[1] - from[1]))
    if (i >= wallEdges) {
      edges.push({
        index: i,
        from: roundPoint(from),
        to: roundPoint(to),
        length,
        basis: 'assumed',
        confidence: 'low',
        evidencePlaneIds: [],
        evidenceIds: [],
        reason: 'No wall was seen on this side; the edge closes the outline.',
        likelyGlass: false,
        seenBeyond: null,
      })
      continue
    }
    const step = steps[i]!
    const line = lines[step.line]!
    const startGap = i === 0 && !closed ? null : cornerGap(step)
    const endGap =
      i + 1 < steps.length ? cornerGap(steps[i + 1]!) : closed ? cornerGap(steps[0]!) : null
    const { confidence, reason } = rateEdge(length, line, startGap, endGap)
    edges.push({
      index: i,
      from: roundPoint(from),
      to: roundPoint(to),
      length,
      basis: line.basis,
      confidence,
      evidencePlaneIds: line.realPlaneIds,
      evidenceIds: line.planeIds,
      reason,
      likelyGlass: false,
      seenBeyond: null,
    })
  }
  return { points: points.map(roundPoint), edges, unknowns }
}

function cornerGap(step: Step): number {
  return Math.max(step.gaps[0], step.gaps[1])
}

function rateEdge(
  edgeLength: number,
  line: Line,
  startGap: number | null,
  endGap: number | null,
): { confidence: EdgeConfidence; reason: string } {
  const rated = rateBasis(edgeLength, line, startGap, endGap)
  if (!line.partial) return rated
  // A plane on part of the wall height may be a furniture front, so it never makes an edge high.
  return {
    confidence: line.partial.cap === 'low' || rated.confidence === 'low' ? 'low' : 'medium',
    reason: `Planes on part of the wall height: ${line.partial.reasons.join('; ')}. ${rated.reason}`,
  }
}

function rateBasis(
  edgeLength: number,
  { basis, length: observedLength }: Line,
  startGap: number | null,
  endGap: number | null,
): { confidence: EdgeConfidence; reason: string } {
  const rated = rateGeometry(edgeLength, observedLength, startGap, endGap)
  if (basis === 'floor-boundary') {
    return {
      confidence: 'low',
      reason: `Only the edge of the detected floor plane backs this edge; the floor may end short of the wall or at glass. ${rated.reason}`,
    }
  }
  if (basis === 'depth-fit') {
    // A fitted line is an inference from depth points, never a measured wall, so it is not rated high.
    return {
      confidence: rated.confidence === 'low' ? 'low' : 'medium',
      reason: `Line fitted to depth points, not a detected wall plane. ${rated.reason}`,
    }
  }
  return rated
}

function rateGeometry(
  edgeLength: number,
  observedLength: number,
  startGap: number | null,
  endGap: number | null,
): { confidence: EdgeConfidence; reason: string } {
  if (startGap === null || endGap === null) {
    return {
      confidence: 'low',
      reason: 'One end is where the wall was last seen, not a corner between two seen walls.',
    }
  }
  if (Math.max(startGap, endGap) > GOOD_GAP) {
    return {
      confidence: 'medium',
      reason: `A corner is ${round(Math.max(startGap, endGap), 2)} m from where the wall was seen; the corner is extrapolated.`,
    }
  }
  if (observedLength < 0.6 * edgeLength) {
    return {
      confidence: 'medium',
      reason: `The evidence covers ${round(observedLength, 2)} m of this ${edgeLength} m edge.`,
    }
  }
  return { confidence: 'high', reason: 'Both corners are next to seen wall evidence.' }
}

/** Depth found past each edge, and a glass flag where the edge itself has no depth behind it. */
function annotateEdges(
  proposal: RoomProposal,
  evidence: DepthWallEvidence,
  unknowns: string[],
  path: Float32Array,
): RoomProposal {
  const polygon = proposal.polygon!
  const edges = proposal.edges.map((edge): RoomProposalEdge => {
    const dx = edge.to[0] - edge.from[0]
    const dz = edge.to[1] - edge.from[1]
    const length = Math.hypot(dx, dz)
    if (length === 0) return edge
    const mid: Vec2 = [(edge.from[0] + edge.to[0]) / 2, (edge.from[1] + edge.to[1]) / 2]
    const normal: Vec2 = [-dz / length, dx / length]
    const outward: Vec2 = pointInPolygon(
      [mid[0] + normal[0] * 0.3, mid[1] + normal[1] * 0.3],
      polygon,
    )
      ? [-normal[0], -normal[1]]
      : normal
    const beyond = measureBeyondEdge(evidence, edge.from, edge.to, outward)
    const hidden = edge.evidenceIds.some((id) => evidence.likelyGlassIds.includes(id))
    const noDepthWall = edge.basis === 'floor-boundary' || edge.basis === 'assumed'
    const strongBeyond = beyond.cells >= BEYOND_MIN_CELLS && beyond.share >= BEYOND_GLASS_SHARE
    const likelyGlass = edge.likelyGlass || hidden || (noDepthWall && strongBeyond)
    let confidence = edge.confidence
    let capped: string | null = null
    if (edge.basis === 'depth-fit' || edge.basis === 'carved') {
      const far = path.length > 0 ? distanceFromPath(path, edge.from, edge.to) : 0
      const floorSeen = floorSeenAlongEdge(evidence, edge.from, edge.to, [-outward[0], -outward[1]])
      if (far > FAR_FROM_PATH) {
        capped = `This edge is ${round(far, 1)} m from anywhere the phone walked, far beyond the walked area.`
      } else if (floorSeen < FLOOR_SEEN_SHARE) {
        capped = `The floor was not seen up to this edge (${Math.round(floorSeen * 100)}% of it), so glass or space beyond the room cannot be ruled out.`
      }
      if (capped) confidence = 'low'
    }
    let note: string | undefined
    if (edge.basis === 'carved') {
      note = strongBeyond
        ? `Depth also runs ${beyond.maxDistance} m past this edge: a window, a glass section or a mirror may be in it.`
        : undefined
    } else if (likelyGlass) {
      note = `Depth reaches ${beyond.maxDistance} m past this edge, where no solid wall was measured: likely clear glass or an open side. The room boundary here is a guess from the ${edge.basis === 'assumed' ? 'closing edge' : 'floor plane edge'}, and what lies beyond may not be part of the room.`
    } else if (edge.basis === 'depth-fit' && strongBeyond) {
      note = `Depth also runs ${beyond.maxDistance} m past this wall: a window, a glass section or a mirror may be in it.`
    }
    return {
      ...edge,
      likelyGlass,
      confidence,
      // A carved edge keeps its own free-space measure, which is what flagged it.
      seenBeyond:
        edge.basis === 'carved' && edge.seenBeyond
          ? { ...edge.seenBeyond, ...(note ? { note } : {}) }
          : { ...beyond, ...(note ? { note } : {}) },
      reason: [edge.reason, capped, note && (likelyGlass || edge.basis === 'carved') ? note : null]
        .filter(Boolean)
        .join(' '),
    }
  })
  edges.forEach((edge) => {
    if (edge.likelyGlass && edge.basis === 'carved') {
      unknowns.push(
        `Edge ${edge.index} is likely glass or an open side. ${edge.reason} Confirm the boundary on site.`,
      )
    } else if (edge.likelyGlass) {
      unknowns.push(
        `Edge ${edge.index} is likely glass or an open side: depth runs ${edge.seenBeyond?.maxDistance} m past it. Confirm the boundary on site.`,
      )
    } else if (edge.seenBeyond?.note) unknowns.push(`Edge ${edge.index}: ${edge.seenBeyond.note}`)
  })
  return { ...proposal, edges }
}

function intersect(a: Line, b: Line): { t: number; u: number } | null {
  const cross = a.d[0] * b.d[1] - a.d[1] * b.d[0]
  if (Math.abs(cross) < MIN_CORNER_SINE) return null
  const dx = b.q[0] - a.q[0]
  const dz = b.q[1] - a.q[1]
  return { t: (dx * b.d[1] - dz * b.d[0]) / cross, u: (dx * a.d[1] - dz * a.d[0]) / cross }
}

function counterClockwise(
  points: Vec2[],
  edges?: RoomProposalEdge[],
): { points: Vec2[]; edges: RoomProposalEdge[] } {
  let area = 0
  points.forEach(([x1, z1], index) => {
    const [x2, z2] = points[(index + 1) % points.length]!
    area += x1 * z2 - x2 * z1
  })
  if (area >= 0) return { points, edges: edges ?? [] }
  // Reverse the corner order; edge k then runs from the reversed point k to k + 1.
  const reversed = [...points].reverse()
  const count = points.length
  const reorderedEdges = edges
    ? edges
        .map((edge) => ({ edge, index: (count - 2 - edge.index + count) % count }))
        .sort((left, right) => left.index - right.index)
        .map(({ edge, index }) => ({ ...edge, index, from: edge.to, to: edge.from }))
    : []
  return { points: reversed, edges: reorderedEdges }
}

function selfIntersects(points: readonly Vec2[]): boolean {
  const count = points.length
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (j === i + 1 || (i === 0 && j === count - 1)) continue
      if (
        segmentsCross(points[i]!, points[(i + 1) % count]!, points[j]!, points[(j + 1) % count]!)
      ) {
        return true
      }
    }
  }
  return false
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0
}

function dot(point: Vec2, direction: Vec2): number {
  return point[0] * direction[0] + point[1] * direction[1]
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]]
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function roundPoint(point: Vec2): Vec2 {
  return [round(point[0]), round(point[1])]
}
