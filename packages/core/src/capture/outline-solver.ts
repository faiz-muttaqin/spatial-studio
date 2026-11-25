/**
 * Least-squares correction of a proposed room outline from what a person knows: tape lengths,
 * right angles, parallel or equal walls and corners they trust.
 *
 * Adapted from Plan3D's solver (`src/solver.ts` in apiel/plan3d at commit `8d0692f4a496`): every
 * fact is a residual divided by its standard deviation, and Levenberg-Marquardt finds the corner
 * positions that minimise the sum of squares. The proposal's shape is kept as each edge's vector
 * times one unknown scale, so a scan that is 10% short is 10% short everywhere and one tape
 * measurement stretches the walls nobody measured in proportion. The inverse of the normal matrix
 * at the solution gives how uncertain each edge's length still is, which names the wall to measure
 * next. Re-implemented here for outlines in level `[x, z]` metres; nothing is copied verbatim.
 *
 * Pure, deterministic (no randomness, fixed iteration cap) and bounded (at most 48 corners).
 */
import type { EdgeBasis, EdgeConfidence } from './room-proposal'

export type OutlinePoint = readonly [number, number]

/** What a person states about the outline. Corner `i` is polygon point `i`; edge `i` runs from corner `i` to `i + 1`, wrapping. */
export type OutlineConstraint =
  /** A tape distance between two corners (an edge when `b = a + 1`, a diagonal otherwise), in metres. */
  | { type: 'distance'; a: number; b: number; value: number }
  /** The walls on both sides of this corner meet at 90 degrees. */
  | { type: 'rightAngle'; corner: number }
  /** Two edges run the same way (or opposite ways). */
  | { type: 'parallel'; edgeA: number; edgeB: number }
  /** Two edges have the same length. */
  | { type: 'equalLength'; edgeA: number; edgeB: number }
  /** The corner stays where it is in `polygon` (or at `position`). */
  | { type: 'fixed'; corner: number; position?: OutlinePoint }

/** Trust in one proposed edge; the standard deviation wins when given. */
export type OutlineEdgeTrust = {
  sigma?: number
  confidence?: EdgeConfidence
  basis?: EdgeBasis
  likelyGlass?: boolean
}

export type OutlineSolverInput = {
  polygon: readonly OutlinePoint[]
  /** One entry per edge; missing entries are treated as low confidence. */
  edges?: readonly (OutlineEdgeTrust | undefined)[]
  constraints?: readonly OutlineConstraint[]
  /** Let one scale stretch the whole shape (default true). */
  estimateScale?: boolean
  maxIterations?: number
}

export type OutlineEdgeResult = {
  index: number
  from: [number, number]
  to: [number, number]
  proposedLength: number
  length: number
  /** One standard deviation of the length after the fit, in metres. */
  sigma: number
  /** True when a tape distance sits on this edge. */
  measured: boolean
}

export type OutlineResidual = {
  /** Index in the input `constraints`. */
  constraint: number
  type: OutlineConstraint['type']
  /** Metres for distances and equal lengths, degrees for angles and parallels, metres moved for a fixed corner. */
  error: number
  /** The error in standard deviations: the size of the disagreement relative to trust. */
  sigmas: number
  satisfied: boolean
}

export type OutlineSolution = {
  polygon: Array<[number, number]>
  /** The scale applied to the proposal's shape; 1 when not estimated. */
  scale: number
  iterations: number
  converged: boolean
  edges: OutlineEdgeResult[]
  residuals: OutlineResidual[]
  /** Constraints the solution could not honour: conflicting tapes, or an angle the tapes forbid. */
  conflicts: OutlineResidual[]
  /** The edge whose length is least certain, with a reason; null when every edge is known to 2 cm. */
  measureNext: { edge: number; sigma: number; reason: string } | null
  /** True when two non-adjacent edges of the corrected outline cross. */
  selfIntersecting: boolean
}

export class OutlineSolverInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutlineSolverInputError'
  }
}

/** Standard deviations (metres, or cosine / sine for angles), as in Plan3D's SIGMA. */
export const OUTLINE_SIGMA = {
  distance: 0.003,
  angle: 0.002,
  equal: 0.003,
  fixed: 0.001,
  /** The proposal's centre stays where it was. */
  centre: 0.05,
  /**
   * A phone scan's overall scale: loose enough that one tape moves it, tight enough that an outline
   * nobody measured is not rated uncertain by its own length. Plan3D leaves it at 1; the shape
   * residuals cannot observe it, so this prior is what an unmeasured edge's sigma rests on.
   */
  scale: 0.05,
} as const

export const OUTLINE_MAX_CORNERS = 48
const DEFAULT_MAX_ITERATIONS = 60
/** A tape the fit misses by more than this is reported as a conflict. */
const CONFLICT_DISTANCE = 0.01
const CONFLICT_ANGLE_DEG = 1
/** An edge uncertain by no more than this needs no further tape. */
const KNOWN_SIGMA = 0.02
const EPS = 1e-9

const CONFIDENCE_SIGMA: Record<EdgeConfidence, number> = { high: 0.05, medium: 0.1, low: 0.2 }

/** How far the proposal's edge vector is trusted, in metres per component. */
export function edgeSigma(trust: OutlineEdgeTrust | undefined): number {
  if (trust?.sigma !== undefined && trust.sigma > 0) return trust.sigma
  let sigma = CONFIDENCE_SIGMA[trust?.confidence ?? 'low']
  if (trust?.basis === 'assumed') sigma = Math.max(sigma, 0.4)
  if (trust?.likelyGlass) sigma *= 2
  return sigma
}

function validate(input: OutlineSolverInput): void {
  const n = input.polygon.length
  if (n < 3) throw new OutlineSolverInputError('The outline needs at least 3 corners.')
  if (n > OUTLINE_MAX_CORNERS)
    throw new OutlineSolverInputError(`The outline has more than ${OUTLINE_MAX_CORNERS} corners.`)
  for (const [x, z] of input.polygon)
    if (!(Number.isFinite(x) && Number.isFinite(z)))
      throw new OutlineSolverInputError('Every corner must be two finite numbers.')
  const corner = (value: number, what: string) => {
    if (!Number.isInteger(value) || value < 0 || value >= n)
      throw new OutlineSolverInputError(`${what} ${value} is not a corner (0 to ${n - 1}).`)
  }
  for (const constraint of input.constraints ?? []) {
    switch (constraint.type) {
      case 'distance':
        corner(constraint.a, 'Corner')
        corner(constraint.b, 'Corner')
        if (constraint.a === constraint.b)
          throw new OutlineSolverInputError('A distance needs two different corners.')
        if (!(Number.isFinite(constraint.value) && constraint.value > 0))
          throw new OutlineSolverInputError('A distance must be a positive number of metres.')
        break
      case 'rightAngle':
        corner(constraint.corner, 'Corner')
        break
      case 'fixed':
        corner(constraint.corner, 'Corner')
        break
      default:
        corner(constraint.edgeA, 'Edge')
        corner(constraint.edgeB, 'Edge')
        if (constraint.edgeA === constraint.edgeB)
          throw new OutlineSolverInputError('A pair needs two different edges.')
    }
  }
}

export function solveRoomOutline(input: OutlineSolverInput): OutlineSolution {
  validate(input)
  const constraints = input.constraints ?? []
  const n = input.polygon.length
  const np = n * 2
  const estimateScale = input.estimateScale !== false
  const unknowns = np + 1
  const sensor = input.polygon.map(([x, z]) => ({ x, z }))
  const sensorCentre = {
    x: sensor.reduce((sum, p) => sum + p.x, 0) / n,
    z: sensor.reduce((sum, p) => sum + p.z, 0) / n,
  }
  const sigmas = Array.from({ length: n }, (_, i) => edgeSigma(input.edges?.[i]))

  const x = new Float64Array(unknowns)
  sensor.forEach((p, i) => {
    x[2 * i] = p.x
    x[2 * i + 1] = p.z
  })
  x[np] = 1

  const residuals = (v: Float64Array): number[] => {
    const r: number[] = []
    let cx = 0
    let cz = 0
    for (let i = 0; i < n; i++) {
      cx += v[2 * i]!
      cz += v[2 * i + 1]!
    }
    r.push((cx / n - sensorCentre.x) / OUTLINE_SIGMA.centre)
    r.push((cz / n - sensorCentre.z) / OUTLINE_SIGMA.centre)
    r.push(estimateScale ? (v[np]! - 1) / OUTLINE_SIGMA.scale : (v[np]! - 1) / 1e-6)
    const s = v[np]!
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      r.push((v[2 * j]! - v[2 * i]! - s * (sensor[j]!.x - sensor[i]!.x)) / sigmas[i]!)
      r.push((v[2 * j + 1]! - v[2 * i + 1]! - s * (sensor[j]!.z - sensor[i]!.z)) / sigmas[i]!)
    }
    for (const c of constraints) pushConstraint(r, v, c)
    return r
  }

  const at = (v: Float64Array, i: number) => ({ x: v[2 * i]!, z: v[2 * i + 1]! })
  const edgeVector = (v: Float64Array, e: number) => {
    const a = at(v, e)
    const b = at(v, (e + 1) % n)
    return { x: b.x - a.x, z: b.z - a.z }
  }
  function pushConstraint(r: number[], v: Float64Array, c: OutlineConstraint): void {
    switch (c.type) {
      case 'distance': {
        const a = at(v, c.a)
        const b = at(v, c.b)
        r.push((Math.hypot(b.x - a.x, b.z - a.z) - c.value) / OUTLINE_SIGMA.distance)
        break
      }
      case 'rightAngle': {
        // Cosine of the angle at the corner between the two walls: zero at 90 degrees.
        const p = at(v, (c.corner + n - 1) % n)
        const q = at(v, c.corner)
        const s = at(v, (c.corner + 1) % n)
        const ux = p.x - q.x
        const uz = p.z - q.z
        const wx = s.x - q.x
        const wz = s.z - q.z
        const cos = (ux * wx + uz * wz) / Math.max(Math.hypot(ux, uz) * Math.hypot(wx, wz), EPS)
        r.push(cos / OUTLINE_SIGMA.angle)
        break
      }
      case 'parallel': {
        // Sine of the angle between the edges: zero when they run the same way or opposite ways.
        const u = edgeVector(v, c.edgeA)
        const w = edgeVector(v, c.edgeB)
        const lu = Math.max(Math.hypot(u.x, u.z), EPS)
        const lw = Math.max(Math.hypot(w.x, w.z), EPS)
        r.push((u.x * w.z - u.z * w.x) / (lu * lw) / OUTLINE_SIGMA.angle)
        break
      }
      case 'equalLength': {
        const u = edgeVector(v, c.edgeA)
        const w = edgeVector(v, c.edgeB)
        r.push((Math.hypot(u.x, u.z) - Math.hypot(w.x, w.z)) / OUTLINE_SIGMA.equal)
        break
      }
      case 'fixed': {
        const target = c.position ?? input.polygon[c.corner]!
        r.push((v[2 * c.corner]! - target[0]) / OUTLINE_SIGMA.fixed)
        r.push((v[2 * c.corner + 1]! - target[1]) / OUTLINE_SIGMA.fixed)
        break
      }
    }
  }

  const sumSq = (r: readonly number[]) => r.reduce((total, value) => total + value * value, 0)

  let r = residuals(x)
  let cost = sumSq(r)

  /** Normal equations at x with a forward-difference Jacobian. */
  const normal = () => {
    const m = r.length
    const jac: Float64Array[] = []
    for (let k = 0; k < unknowns; k++) {
      const column = new Float64Array(m)
      const h = 1e-6
      const saved = x[k]!
      x[k] = saved + h
      const shifted = residuals(x)
      x[k] = saved
      for (let i = 0; i < m; i++) column[i] = (shifted[i]! - r[i]!) / h
      jac.push(column)
    }
    const A = Array.from({ length: unknowns }, () => new Array<number>(unknowns).fill(0))
    const g = new Array<number>(unknowns).fill(0)
    for (let a = 0; a < unknowns; a++) {
      for (let i = 0; i < m; i++) g[a]! -= jac[a]![i]! * r[i]!
      for (let b = a; b < unknowns; b++) {
        let total = 0
        for (let i = 0; i < m; i++) total += jac[a]![i]! * jac[b]![i]!
        A[a]![b] = total
        A[b]![a] = total
      }
    }
    return { A, g }
  }

  const maxIterations = Math.min(input.maxIterations ?? DEFAULT_MAX_ITERATIONS, 200)
  let lambda = 1e-3
  let iterations = 0
  let converged = false
  for (; iterations < maxIterations; iterations++) {
    const { A, g } = normal()
    let improved = false
    for (let attempt = 0; attempt < 12; attempt++) {
      const damped = A.map((row, i) => row.map((value, j) => (i === j ? value + lambda : value)))
      const dx = gaussSolve(damped, g)
      if (!dx) {
        lambda *= 10
        continue
      }
      const trial = Float64Array.from(x, (value, i) => value + dx[i]!)
      const trialResiduals = residuals(trial)
      const trialCost = sumSq(trialResiduals)
      if (trialCost < cost) {
        const step = Math.max(...dx.map(Math.abs))
        const gain = cost - trialCost
        x.set(trial)
        r = trialResiduals
        cost = trialCost
        lambda = Math.max(lambda / 10, 1e-12)
        improved = true
        if (step < 1e-9 || gain < 1e-12) converged = true
        break
      }
      lambda *= 10
    }
    if (!improved) {
      converged = true
      break
    }
    if (converged) break
  }

  const polygon: Array<[number, number]> = []
  for (let i = 0; i < n; i++) polygon.push([x[2 * i]!, x[2 * i + 1]!])

  const lengthOf = (pts: readonly OutlinePoint[], a: number, b: number) =>
    Math.hypot(pts[b]![0] - pts[a]![0], pts[b]![1] - pts[a]![1])

  // Residual report, in the unit a person reads.
  const report: OutlineResidual[] = constraints.map((c, index) => {
    const row: number[] = []
    pushConstraint(row, x, c)
    const z = Math.hypot(...row)
    let error: number
    switch (c.type) {
      case 'distance':
        error = lengthOf(polygon, c.a, c.b) - c.value
        break
      case 'rightAngle': {
        const p = at(x, (c.corner + n - 1) % n)
        const q = at(x, c.corner)
        const s = at(x, (c.corner + 1) % n)
        const angle = Math.atan2(
          Math.abs((p.x - q.x) * (s.z - q.z) - (p.z - q.z) * (s.x - q.x)),
          (p.x - q.x) * (s.x - q.x) + (p.z - q.z) * (s.z - q.z),
        )
        error = (angle * 180) / Math.PI - 90
        break
      }
      case 'parallel': {
        const u = edgeVector(x, c.edgeA)
        const w = edgeVector(x, c.edgeB)
        const sine =
          (u.x * w.z - u.z * w.x) / Math.max(Math.hypot(u.x, u.z) * Math.hypot(w.x, w.z), EPS)
        error = (Math.asin(Math.max(-1, Math.min(1, sine))) * 180) / Math.PI
        break
      }
      case 'equalLength':
        error =
          lengthOf(polygon, c.edgeA, (c.edgeA + 1) % n) -
          lengthOf(polygon, c.edgeB, (c.edgeB + 1) % n)
        break
      case 'fixed': {
        const target = c.position ?? input.polygon[c.corner]!
        error = Math.hypot(x[2 * c.corner]! - target[0], x[2 * c.corner + 1]! - target[1])
        break
      }
    }
    const limit =
      c.type === 'rightAngle' || c.type === 'parallel' ? CONFLICT_ANGLE_DEG : CONFLICT_DISTANCE
    return {
      constraint: index,
      type: c.type,
      error,
      sigmas: z,
      satisfied: Math.abs(error) <= limit,
    }
  })

  // Covariance of the unknowns is the inverse of J^T J (the residuals are already divided by their
  // sigma); an edge's length varies along the unit vector between its ends.
  const { A } = normal()
  const ridge = A.map((row, i) => row.map((value, j) => (i === j ? value + 1e-9 : value)))
  const cov = invert(ridge)
  const measured = new Set<number>()
  for (const c of constraints) {
    if (c.type !== 'distance') continue
    if (c.b === (c.a + 1) % n) measured.add(c.a)
    else if (c.a === (c.b + 1) % n) measured.add(c.b)
  }
  const edges: OutlineEdgeResult[] = Array.from({ length: n }, (_, i) => {
    const j = (i + 1) % n
    const dx = polygon[j]![0] - polygon[i]![0]
    const dz = polygon[j]![1] - polygon[i]![1]
    const length = Math.hypot(dx, dz)
    let variance = Number.POSITIVE_INFINITY
    if (cov) {
      const unit = Math.max(length, EPS)
      const idx = [2 * i, 2 * i + 1, 2 * j, 2 * j + 1]
      const grad = [-dx / unit, -dz / unit, dx / unit, dz / unit]
      variance = 0
      for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++) variance += grad[a]! * cov[idx[a]!]![idx[b]!]! * grad[b]!
    }
    return {
      index: i,
      from: polygon[i]!,
      to: polygon[j]!,
      proposedLength: lengthOf(input.polygon, i, j),
      length,
      sigma: Math.sqrt(Math.max(variance, 0)),
      measured: measured.has(i),
    }
  })

  let next: OutlineSolution['measureNext'] = null
  for (const edge of edges) {
    if (edge.measured || edge.sigma <= KNOWN_SIGMA) continue
    if (!next || edge.sigma > next.sigma + 1e-9)
      next = {
        edge: edge.index,
        sigma: edge.sigma,
        reason: `Edge ${edge.index} is the least certain (±${edge.sigma.toFixed(2)} m); a tape here pins the most.`,
      }
  }

  return {
    polygon,
    scale: x[np]!,
    iterations,
    converged,
    edges,
    residuals: report,
    conflicts: report.filter((entry) => !entry.satisfied),
    measureNext: next,
    selfIntersecting: crosses(polygon),
  }
}

function crosses(polygon: readonly OutlinePoint[]): boolean {
  const n = polygon.length
  const side = (a: OutlinePoint, b: OutlinePoint, c: OutlinePoint) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const a = polygon[i]!
      const b = polygon[(i + 1) % n]!
      const c = polygon[j]!
      const d = polygon[(j + 1) % n]!
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true
    }
  }
  return false
}

/** Inverse by Gauss-Jordan elimination; undefined when singular. */
function invert(A: number[][]): number[][] | undefined {
  const n = A.length
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++)
      if (Math.abs(M[row]![col]!) > Math.abs(M[pivot]![col]!)) pivot = row
    if (Math.abs(M[pivot]![col]!) < 1e-14) return undefined
    ;[M[col], M[pivot]] = [M[pivot]!, M[col]!]
    const p = M[col]![col]!
    for (let k = 0; k < 2 * n; k++) M[col]![k]! /= p
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const f = M[row]![col]!
      if (f === 0) continue
      for (let k = 0; k < 2 * n; k++) M[row]![k]! -= f * M[col]![k]!
    }
  }
  return M.map((row) => row.slice(n))
}

/** Solves A x = b by Gaussian elimination with partial pivoting; undefined when singular. */
function gaussSolve(A: number[][], b: number[]): number[] | undefined {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++)
      if (Math.abs(M[row]![col]!) > Math.abs(M[pivot]![col]!)) pivot = row
    if (Math.abs(M[pivot]![col]!) < 1e-14) return undefined
    ;[M[col], M[pivot]] = [M[pivot]!, M[col]!]
    for (let row = col + 1; row < n; row++) {
      const f = M[row]![col]! / M[col]![col]!
      for (let k = col; k <= n; k++) M[row]![k]! -= f * M[col]![k]!
    }
  }
  const result = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let total = M[row]![n]!
    for (let k = row + 1; k < n; k++) total -= M[row]![k]! * result[k]!
    result[row] = total / M[row]![row]!
  }
  return result
}
