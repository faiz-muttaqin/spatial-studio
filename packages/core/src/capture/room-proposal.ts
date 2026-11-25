import {
  analysePlanes,
  captureToLevel,
  IDENTITY_SCAN_TRANSFORM,
  type PlaneAnalysis,
  type ScanTransform,
  type Vec2,
  type WallSegment,
} from './plane-analysis'
import type { CapturePlane, ManualMeasurements } from './streams'

/**
 * A room outline proposed from a scan, for a person to verify. Nothing here is measured by this
 * code: plane-derived values are estimates from the capture's plane detection, manual values are
 * what someone typed in, and every closing edge guessed from missing evidence says `assumed`.
 */

export type EdgeBasis = 'plane-estimate' | 'manual-measurement' | 'assumed'
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
  /** Why the confidence is what it is. */
  reason: string
}

export type RoomProposal = {
  method: 'planes' | 'manual-measurements' | 'none'
  /** Corners in level coordinates, `[x, z]` in metres, counter-clockwise seen from above (+Y). Null when no outline could be made. */
  polygon: Vec2[] | null
  height: { value: number; basis: 'plane-estimate' | 'manual-measurement' } | null
  edges: RoomProposalEdge[]
  /** What the scan did not show, and what was guessed to fill it. */
  unknowns: string[]
  floorY: number | null
  planesUsed: string[]
  planesIgnored: Array<{ planeId: string; reason: string }>
  /** Always true: every value is an estimate or a guess until a person confirms it on site. */
  needsVerification: true
}

export type RoomProposalInput = {
  planes: readonly CapturePlane[] | null
  measurements: ManualMeasurements | null
  transform?: ScanTransform
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

type Line = {
  /** A point on the line and its unit direction. */
  q: Vec2
  d: Vec2
  tMin: number
  tMax: number
  length: number
  planeIds: string[]
}

export function proposeRoomFromPlanes(
  planes: readonly CapturePlane[],
  transform: ScanTransform = IDENTITY_SCAN_TRANSFORM,
): RoomProposal {
  const analysis = analysePlanes(planes, transform)
  return fromAnalysis(analysis)
}

/**
 * Plane set first, manual measurements as a rectangle when the planes give no outline. Writes
 * nothing; the caller creates the room after the person has checked the numbers.
 */
export function proposeRoom(input: RoomProposalInput): RoomProposal {
  const transform = input.transform ?? IDENTITY_SCAN_TRANSFORM
  const analysis = input.planes ? analysePlanes(input.planes, transform) : null
  const fromPlanes = analysis ? fromAnalysis(analysis) : null
  const manual = input.measurements
  const unknowns: string[] = []

  let proposal: RoomProposal
  if (fromPlanes?.polygon) {
    proposal = fromPlanes
  } else {
    const rectangle = manual ? manualRectangle(manual, transform) : null
    if (rectangle) {
      proposal = {
        ...rectangle,
        unknowns: [
          ...(analysis
            ? [`Planes gave no outline: ${fromPlanes?.unknowns.join(' ') ?? 'no planes'}`]
            : ['The scan has no plane set.']),
          ...rectangle.unknowns,
        ],
        planesIgnored: fromPlanes?.planesIgnored ?? [],
      }
    } else {
      proposal = {
        method: 'none',
        polygon: null,
        height: null,
        edges: [],
        unknowns: [
          ...(fromPlanes?.unknowns ?? ['The scan has no plane set.']),
          'No usable manual width and length either.',
          'Ask the person for the room width, length and height, or rescan.',
        ],
        floorY: fromPlanes?.floorY ?? null,
        planesUsed: [],
        planesIgnored: fromPlanes?.planesIgnored ?? [],
        needsVerification: true,
      }
    }
  }

  // The height planes gave wins; a manual one fills the gap and is checked against it.
  const manualHeight = manual?.room.height ?? null
  if (proposal.height === null && manualHeight !== null) {
    proposal = { ...proposal, height: { value: manualHeight, basis: 'manual-measurement' } }
  } else if (
    proposal.height?.basis === 'plane-estimate' &&
    manualHeight !== null &&
    Math.abs(manualHeight - proposal.height.value) > 0.1
  ) {
    unknowns.push(
      `Planes give a height of ${proposal.height.value} m but the manual measurement says ${manualHeight} m. Check on site.`,
    )
  }
  if (proposal.height === null && !proposal.unknowns.some((text) => text.includes('ceiling'))) {
    unknowns.push('No ceiling height: no ceiling plane and no manual height.')
  }
  return { ...proposal, unknowns: [...proposal.unknowns, ...unknowns] }
}

function manualRectangle(
  measurements: ManualMeasurements,
  transform: ScanTransform,
): RoomProposal | null {
  const { width, length } = measurements.room
  if (width === null || length === null) return null
  const corners = (
    [
      [0, 0],
      [width, 0],
      [width, length],
      [0, length],
    ] as const
  ).map(([x, z]): Vec2 => {
    const point = captureToLevel(transform, [x, 0, z])
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
        reason: 'Length is a typed-in measurement; where the room sits is assumed.',
      }
    }),
    unknowns: [
      'Only width and length were measured by hand, so the outline is a rectangle.',
      'Placement and rotation are assumed: the rectangle starts at the capture origin. Move it to the real room before building on it.',
    ],
    floorY: null,
    planesUsed: [],
    planesIgnored: [],
    needsVerification: true,
  }
}

function fromAnalysis(analysis: PlaneAnalysis): RoomProposal {
  const unknowns: string[] = []
  const planesIgnored = [...analysis.skipped]
  const height =
    analysis.height === null ? null : { value: analysis.height, basis: 'plane-estimate' as const }
  if (!analysis.floor) unknowns.push('No floor plane was seen, so floor level is unknown.')
  if (!analysis.ceiling)
    unknowns.push('No ceiling plane was seen, so the ceiling height is unknown.')

  const lines = mergeWalls(analysis.walls)
  const base = {
    height,
    floorY: analysis.floor?.y ?? null,
    planesIgnored,
    needsVerification: true as const,
  }
  if (lines.length < 3) {
    return {
      ...base,
      method: 'planes',
      polygon: null,
      edges: [],
      unknowns: [
        ...unknowns,
        `Only ${lines.length} wall line${lines.length === 1 ? '' : 's'} found; at least three are needed to outline a room.`,
      ],
      planesUsed: [],
    }
  }

  const walk = bestWalk(lines)
  if (!walk) {
    return {
      ...base,
      method: 'planes',
      polygon: null,
      edges: [],
      unknowns: [
        ...unknowns,
        'The wall lines do not meet at corners, so no outline could be built.',
      ],
      planesUsed: [],
    }
  }

  const used = new Set(walk.order)
  lines.forEach((line, index) => {
    if (used.has(index)) return
    for (const planeId of line.planeIds) {
      planesIgnored.push({ planeId, reason: 'a wall line that does not join the outline' })
    }
  })

  const built = buildOutline(lines, walk)
  unknowns.push(...built.unknowns)
  const ordered = counterClockwise(built.points, built.edges)
  if (selfIntersects(ordered.points)) {
    unknowns.push('The outline crosses itself; treat it as a rough guide and check the corners.')
  }
  return {
    ...base,
    method: 'planes',
    polygon: ordered.points,
    edges: ordered.edges,
    unknowns,
    planesUsed: [...new Set(walk.order.flatMap((index) => lines[index]!.planeIds))],
  }
}

function mergeWalls(walls: readonly WallSegment[]): Line[] {
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
    return { q, d, tMin, tMax, length: tMax - tMin, planeIds: group.map((wall) => wall.planeId) }
  })
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
      if (
        !best ||
        walk.order.length > best.order.length ||
        (walk.order.length === best.order.length && Number(walk.closed) > Number(best.closed)) ||
        (walk.order.length === best.order.length &&
          walk.closed === best.closed &&
          walk.totalGap < best.totalGap - 1e-9)
      ) {
        best = walk
      }
    }
  }
  return best
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
        reason: 'No wall plane was seen on this side; the edge closes the outline.',
      })
      continue
    }
    const step = steps[i]!
    const line = lines[step.line]!
    const startGap = i === 0 && !closed ? null : cornerGap(step)
    const endGap =
      i + 1 < steps.length ? cornerGap(steps[i + 1]!) : closed ? cornerGap(steps[0]!) : null
    const { confidence, reason } = rateEdge(length, line.length, startGap, endGap)
    edges.push({
      index: i,
      from: roundPoint(from),
      to: roundPoint(to),
      length,
      basis: 'plane-estimate',
      confidence,
      evidencePlaneIds: line.planeIds,
      reason,
    })
  }
  return { points: points.map(roundPoint), edges, unknowns }
}

function cornerGap(step: Step): number {
  return Math.max(step.gaps[0], step.gaps[1])
}

function rateEdge(
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
      reason: `The planes cover ${round(observedLength, 2)} m of this ${edgeLength} m edge.`,
    }
  }
  return { confidence: 'high', reason: 'Both corners are next to seen wall planes.' }
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
