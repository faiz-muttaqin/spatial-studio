import {
  type OutlineConstraint,
  type OutlineEdgeTrust,
  type OutlineSolution,
  solveRoomOutline,
} from '@pascal-app/core/capture'
import type { ProposalReview } from './scan-map-loader'

export type Point = [number, number]

/** What the person has done to the proposed outline so far. Everything else comes from the proposal. */
export type ReviewState = {
  proposal: ProposalReview
  /** The outline the solver starts from: the proposal with corners the person dragged. */
  base: Point[]
  /** Corners the person placed by hand; the edges on both sides are trusted more. */
  placed: boolean[]
  /** Tape lengths by edge index, in metres. */
  tapes: Record<number, number>
  /** Corners ticked as right angles. */
  rightAngles: boolean[]
  height: number
  /** A corner being dragged, pinned to the cursor while the rest of the outline follows. */
  drag: { corner: number; position: Point } | null
}

export const DEFAULT_HEIGHT = 2.5
export const MIN_HEIGHT = 1.8
export const MAX_HEIGHT = 6
/** A corner the person placed by hand: its two edges are trusted to a few centimetres. */
const PLACED_SIGMA = 0.03
const DRAGGED_SIGMA = 1

export function startReview(proposal: ProposalReview): ReviewState {
  const n = proposal.polygon.length
  return {
    proposal,
    base: proposal.polygon.map(([x, z]) => [x, z]),
    placed: new Array<boolean>(n).fill(false),
    tapes: {},
    rightAngles: new Array<boolean>(n).fill(false),
    height: clampHeight(proposal.height?.value ?? DEFAULT_HEIGHT),
    drag: null,
  }
}

export function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HEIGHT
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value))
}

/**
 * Starts a drag from what the person sees: the outline as last solved becomes the reference, so
 * nothing but the dragged corner and what the constraints pull along moves.
 */
export function beginDrag(
  state: ReviewState,
  solved: readonly Point[],
  corner: number,
): ReviewState {
  return {
    ...state,
    base: solved.map(([x, z]): Point => [x, z]),
    drag: { corner, position: [solved[corner]![0], solved[corner]![1]] },
  }
}

/** The dragged corner follows the cursor exactly; the solver moves the rest. */
export function dragTo(state: ReviewState, to: Point): ReviewState {
  return state.drag ? { ...state, drag: { ...state.drag, position: [to[0], to[1]] } } : state
}

/** Drops the corner where it is: it becomes a hand-placed corner of the reference outline. */
export function endDrag(state: ReviewState): ReviewState {
  if (!state.drag) return state
  const { corner, position } = state.drag
  return {
    ...state,
    base: state.base.map((point, i): Point => (i === corner ? position : point)),
    placed: state.placed.map((flag, i) => flag || i === corner),
    drag: null,
  }
}

/** Moves a corner of the reference outline directly, with no solve in between (tests, keyboard). */
export function moveCorner(state: ReviewState, corner: number, to: Point): ReviewState {
  const base = state.base.map((point, i): Point => (i === corner ? [to[0], to[1]] : point))
  const placed = state.placed.map((flag, i) => flag || i === corner)
  return { ...state, base, placed }
}

/** A tape length for an edge; null, zero or a non-number removes it. */
export function setTape(state: ReviewState, edge: number, value: number | null): ReviewState {
  const tapes = { ...state.tapes }
  if (value === null || !Number.isFinite(value) || value <= 0) delete tapes[edge]
  else tapes[edge] = value
  return { ...state, tapes }
}

export function setRightAngle(state: ReviewState, corner: number, on: boolean): ReviewState {
  return { ...state, rightAngles: state.rightAngles.map((flag, i) => (i === corner ? on : flag)) }
}

export function constraintsOf(state: ReviewState): OutlineConstraint[] {
  const n = state.base.length
  const list: OutlineConstraint[] = []
  for (const [edge, value] of Object.entries(state.tapes)) {
    const a = Number(edge)
    list.push({ type: 'distance', a, b: (a + 1) % n, value })
  }
  state.rightAngles.forEach((on, corner) => {
    if (on) list.push({ type: 'rightAngle', corner })
  })
  if (state.drag)
    list.push({ type: 'fixed', corner: state.drag.corner, position: state.drag.position })
  return list
}

export function trustOf(state: ReviewState): OutlineEdgeTrust[] {
  const n = state.base.length
  return state.proposal.edges.map((edge, i) => {
    // The edges of a corner being dragged give way, so the corner goes where the cursor is and the
    // rest of the outline stays put.
    if (state.drag && (state.drag.corner === i || state.drag.corner === (i + 1) % n))
      return { sigma: DRAGGED_SIGMA }
    if (state.placed[i] || state.placed[(i + 1) % n]) return { sigma: PLACED_SIGMA }
    return { confidence: edge.confidence, basis: edge.basis, likelyGlass: edge.likelyGlass }
  })
}

export function solveReview(state: ReviewState): OutlineSolution {
  return solveRoomOutline({
    polygon: state.base,
    edges: trustOf(state),
    constraints: constraintsOf(state),
  })
}

export type EdgeTone = 'high' | 'medium' | 'low' | 'assumed' | 'glass'

/** How an edge is coloured: glass and assumed edges stand apart from the confidence scale. */
export function edgeTone(state: ReviewState, edge: number): EdgeTone {
  const info = state.proposal.edges[edge]
  if (!info) return 'low'
  if (info.likelyGlass) return 'glass'
  if (info.basis === 'assumed') return 'assumed'
  return info.confidence
}

export const TONE_COLOURS: Record<EdgeTone, string> = {
  high: 'rgb(74, 222, 128)',
  medium: 'rgb(250, 204, 21)',
  low: 'rgb(251, 146, 60)',
  assumed: 'rgb(192, 132, 252)',
  glass: 'rgb(56, 189, 248)',
}

/** The corner within `radius` (level metres) of a point, nearest first; null when none. */
export function cornerAt(polygon: readonly Point[], point: Point, radius: number): number | null {
  let best: number | null = null
  let bestDistance = radius
  polygon.forEach(([x, z], i) => {
    const d = Math.hypot(x - point[0], z - point[1])
    if (d <= bestDistance) {
      best = i
      bestDistance = d
    }
  })
  return best
}

/** The edge within `radius` of a point; null when none. */
export function edgeAt(polygon: readonly Point[], point: Point, radius: number): number | null {
  let best: number | null = null
  let bestDistance = radius
  const n = polygon.length
  for (let i = 0; i < n; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % n]!
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const lengthSq = dx * dx + dz * dz
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSq))
    const d = Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dz))
    if (d <= bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return best
}

/** Parses a typed length in metres: a comma or point decimal, optional trailing m. */
export function parseMetres(text: string): number | null {
  const cleaned = text.trim().replace(/m$/i, '').trim().replace(',', '.')
  if (cleaned === '') return null
  const value = Number(cleaned)
  return Number.isFinite(value) && value > 0 && value <= 200 ? value : null
}

/** The range a ceiling height may take, and whether a typed value is inside it. */
export function heightInRange(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_HEIGHT && value <= MAX_HEIGHT
}

/**
 * The scan placement that lowers the detected floor to the level floor, taken from the scan's
 * placement now: the suggestion is a move in y relative to the placement it was computed for, so a
 * scan the person has moved since is not snapped back to an old position.
 */
export function scanPlacementNow(
  review: ProposalReview,
  live: { position: [number, number, number]; rotation: [number, number, number]; scale: number },
): {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number
} | null {
  const suggested = review.suggestedScanTransform
  if (!suggested) return null
  const dy = suggested.position[1] - review.scanTransform.position[1]
  return {
    position: [live.position[0], live.position[1] + dy, live.position[2]],
    rotation: live.rotation,
    scale: live.scale,
  }
}
