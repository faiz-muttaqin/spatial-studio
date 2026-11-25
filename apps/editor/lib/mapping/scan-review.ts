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
}

export const DEFAULT_HEIGHT = 2.5
export const MIN_HEIGHT = 1.8
export const MAX_HEIGHT = 6
/** A corner the person placed by hand: its two edges are trusted to a few centimetres. */
const PLACED_SIGMA = 0.03

export function startReview(proposal: ProposalReview): ReviewState {
  const n = proposal.polygon.length
  return {
    proposal,
    base: proposal.polygon.map(([x, z]) => [x, z]),
    placed: new Array<boolean>(n).fill(false),
    tapes: {},
    rightAngles: new Array<boolean>(n).fill(false),
    height: clampHeight(proposal.height?.value ?? DEFAULT_HEIGHT),
  }
}

export function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HEIGHT
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value))
}

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
  return list
}

export function trustOf(state: ReviewState): OutlineEdgeTrust[] {
  const n = state.base.length
  return state.proposal.edges.map((edge, i) =>
    state.placed[i] || state.placed[(i + 1) % n]
      ? { sigma: PLACED_SIGMA }
      : { confidence: edge.confidence, basis: edge.basis, likelyGlass: edge.likelyGlass },
  )
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
