import { describe, expect, it } from 'bun:test'
import {
  edgeSigma,
  OUTLINE_MAX_CORNERS,
  type OutlinePoint,
  OutlineSolverInputError,
  solveRoomOutline,
} from './outline-solver'

const rect = (w: number, d: number): OutlinePoint[] => [
  [0, 0],
  [w, 0],
  [w, d],
  [0, d],
]
const len = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)
const medium = { confidence: 'medium' as const }

describe('outline checks', () => {
  const crossesFor = (polygon: OutlinePoint[]) => solveRoomOutline({ polygon }).selfIntersecting
  it('flags a bow tie, a corner touching another edge, a collinear overlap and a fold back', () => {
    expect(
      crossesFor([
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 4],
      ]),
    ).toBe(true)
    expect(
      crossesFor([
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
      ]),
    ).toBe(true)
    expect(
      crossesFor([
        [0, 0],
        [4, 0],
        [4, 2],
        [2, 0],
        [1, 0],
        [0, 2],
      ]),
    ).toBe(true)
    expect(
      crossesFor([
        [0, 0],
        [4, 0],
        [2, 0],
        [2, 3],
      ]),
    ).toBe(true)
  })
  it('does not flag simple outlines', () => {
    expect(crossesFor(rect(5, 4))).toBe(false)
    expect(
      crossesFor([
        [0, 0],
        [6, 0],
        [6, 2],
        [3, 2],
        [3, 5],
        [0, 5],
      ]),
    ).toBe(false)
  })
  it('refuses too many constraints, a bad iteration count and huge coordinates', () => {
    const many = Array.from({ length: 4 * 4 + 33 }, () => ({
      type: 'rightAngle' as const,
      corner: 0,
    }))
    expect(() => solveRoomOutline({ polygon: rect(5, 4), constraints: many })).toThrow(
      OutlineSolverInputError,
    )
    for (const maxIterations of [Number.NaN, 0, -3, 2.5])
      expect(() => solveRoomOutline({ polygon: rect(5, 4), maxIterations })).toThrow(
        OutlineSolverInputError,
      )
    expect(() => solveRoomOutline({ polygon: rect(1e200, 4) })).toThrow(OutlineSolverInputError)
  })
  it('reports convergence and names the constraint behind a conflict', () => {
    const ok = solveRoomOutline({
      polygon: rect(5, 4),
      constraints: [{ type: 'distance', a: 0, b: 1, value: 5.2 }],
    })
    expect(ok.converged).toBe(true)
    const bad = solveRoomOutline({
      polygon: rect(5, 4),
      constraints: [
        { type: 'distance', a: 0, b: 1, value: 5 },
        { type: 'distance', a: 2, b: 3, value: 6 },
        { type: 'equalLength', edgeA: 0, edgeB: 2 },
      ],
    })
    expect(bad.conflicts.every((c) => c.detail.type === c.type)).toBe(true)
  })
  it('pins what one tape does: a 5% short 4x3 room with a 4.00 m tape stays within 3 cm', () => {
    const drawn: OutlinePoint[] = [
      [0, 0],
      [3.8, 0],
      [3.8, 2.85],
      [0, 2.85],
    ]
    const trust = [
      { confidence: 'medium' as const },
      { confidence: 'medium' as const },
      { confidence: 'medium' as const },
      { confidence: 'medium' as const },
    ]
    const one = solveRoomOutline({
      polygon: drawn,
      edges: trust,
      constraints: [{ type: 'distance', a: 0, b: 1, value: 4 }],
    })
    expect(one.edges[0]!.length).toBeCloseTo(4, 2)
    // opposite wall follows; the other direction is only scaled, so it stays off by about 2.5 cm
    expect(Math.abs(one.edges[2]!.length - 4)).toBeLessThan(0.03)
    expect(Math.abs(one.edges[1]!.length - 3)).toBeLessThan(0.1)
    expect(Math.abs(one.edges[1]!.length - 3)).toBeGreaterThan(0.005)
    // the wall direction nobody measured is the one to measure next
    expect([1, 3]).toContain(one.measureNext!.edge)
  })
})

describe('solveRoomOutline', () => {
  it('leaves an outline alone when nothing is stated', () => {
    const polygon = rect(5, 4)
    const solution = solveRoomOutline({ polygon, edges: [medium, medium, medium, medium] })
    solution.polygon.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(polygon[i]![0], 3)
      expect(p[1]).toBeCloseTo(polygon[i]![1], 3)
    })
    expect(solution.conflicts).toHaveLength(0)
    expect(solution.selfIntersecting).toBe(false)
  })

  it('stretches a rectangle in proportion from one tape length', () => {
    const solution = solveRoomOutline({
      polygon: rect(5, 4),
      edges: [medium, medium, medium, medium],
      constraints: [{ type: 'distance', a: 0, b: 1, value: 5.5 }],
    })
    expect(solution.edges[0]!.length).toBeCloseTo(5.5, 2)
    // the walls nobody measured follow the same scale: 4 * 1.1
    expect(solution.edges[1]!.length).toBeGreaterThan(4.3)
    expect(solution.edges[1]!.length).toBeLessThan(4.4)
    expect(solution.scale).toBeGreaterThan(1.05)
    expect(solution.edges[0]!.measured).toBe(true)
    expect(solution.conflicts).toHaveLength(0)
    // the proposal's right angles survive
    const [a, b, c] = solution.polygon
    const dot = (a![0] - b![0]) * (c![0] - b![0]) + (a![1] - b![1]) * (c![1] - b![1])
    expect(Math.abs(dot) / (len(a!, b!) * len(c!, b!))).toBeLessThan(0.02)
  })

  it('squares a skewed corner with a right-angle tick and keeps the tape', () => {
    const skewed: OutlinePoint[] = [
      [0, 0],
      [5, 0.4],
      [5, 4.4],
      [0, 4],
    ]
    const solution = solveRoomOutline({
      polygon: skewed,
      edges: [medium, medium, medium, medium],
      constraints: [
        { type: 'rightAngle', corner: 0 },
        { type: 'rightAngle', corner: 1 },
        { type: 'rightAngle', corner: 2 },
        { type: 'distance', a: 0, b: 1, value: 5 },
      ],
    })
    expect(solution.edges[0]!.length).toBeCloseTo(5, 2)
    for (const entry of solution.residuals.filter((r) => r.type === 'rightAngle'))
      expect(Math.abs(entry.error)).toBeLessThan(0.5)
    expect(solution.conflicts).toHaveLength(0)
  })

  it('solves an L-shape with a tape on the long wall, and names the wall to measure next', () => {
    const l: OutlinePoint[] = [
      [0, 0],
      [6, 0],
      [6, 2],
      [3, 2],
      [3, 5],
      [0, 5],
    ]
    const trust = [
      { confidence: 'high' as const },
      { confidence: 'high' as const },
      { confidence: 'low' as const },
      { confidence: 'low' as const },
      { confidence: 'low' as const },
      { confidence: 'high' as const },
    ]
    const solution = solveRoomOutline({
      polygon: l,
      edges: trust,
      constraints: [
        { type: 'distance', a: 0, b: 1, value: 6.3 },
        { type: 'rightAngle', corner: 2 },
        { type: 'rightAngle', corner: 3 },
        { type: 'rightAngle', corner: 4 },
      ],
    })
    expect(solution.edges[0]!.length).toBeCloseTo(6.3, 2)
    expect(solution.selfIntersecting).toBe(false)
    expect(solution.measureNext).not.toBeNull()
    expect(solution.measureNext!.edge).not.toBe(0)
    // the measured edge is the most certain one
    const measured = solution.edges[0]!.sigma
    expect(measured).toBeLessThan(solution.measureNext!.sigma)
    // the notch stays a notch
    expect(solution.edges[3]!.length).toBeGreaterThan(3)
  })

  it('reports conflicting tapes instead of hiding them', () => {
    const solution = solveRoomOutline({
      polygon: rect(5, 4),
      constraints: [
        { type: 'distance', a: 0, b: 1, value: 5 },
        { type: 'distance', a: 2, b: 3, value: 6 },
        { type: 'equalLength', edgeA: 0, edgeB: 2 },
      ],
    })
    expect(solution.conflicts.length).toBeGreaterThan(0)
    expect(solution.conflicts.every((c) => !c.satisfied && Math.abs(c.error) > 0.01)).toBe(true)
  })

  it('leaves non-orthogonal walls alone unless constrained', () => {
    const quad: OutlinePoint[] = [
      [0, 0],
      [5, 0],
      [4, 3.5],
      [0.5, 4],
    ]
    const angleAt = (pts: readonly (readonly number[])[], i: number) => {
      const p = pts[(i + pts.length - 1) % pts.length]!
      const q = pts[i]!
      const s = pts[(i + 1) % pts.length]!
      const u = [p[0]! - q[0]!, p[1]! - q[1]!]
      const w = [s[0]! - q[0]!, s[1]! - q[1]!]
      return Math.acos((u[0]! * w[0]! + u[1]! * w[1]!) / (Math.hypot(...u) * Math.hypot(...w)))
    }
    const solution = solveRoomOutline({
      polygon: quad,
      edges: [medium, medium, medium, medium],
      constraints: [{ type: 'distance', a: 0, b: 1, value: 5.2 }],
    })
    for (let i = 0; i < 4; i++)
      expect(angleAt(solution.polygon, i)).toBeCloseTo(angleAt(quad, i), 1)
    const squared = solveRoomOutline({
      polygon: quad,
      edges: [medium, medium, medium, medium],
      constraints: [{ type: 'rightAngle', corner: 1 }],
    })
    expect(Math.abs(squared.residuals[0]!.error)).toBeLessThan(0.5)
  })

  it('honours a fixed corner and a parallel pair', () => {
    const trapezium: OutlinePoint[] = [
      [0, 0],
      [5, 0],
      [4.6, 4],
      [0, 4],
    ]
    const solution = solveRoomOutline({
      polygon: trapezium,
      edges: [medium, medium, medium, medium],
      constraints: [
        { type: 'fixed', corner: 0 },
        { type: 'parallel', edgeA: 1, edgeB: 3 },
      ],
    })
    expect(solution.polygon[0]![0]).toBeCloseTo(0, 2)
    expect(solution.polygon[0]![1]).toBeCloseTo(0, 2)
    expect(solution.residuals[1]!.satisfied).toBe(true)
  })

  it('is deterministic and bounded', () => {
    const input = {
      polygon: rect(5, 4),
      constraints: [{ type: 'distance' as const, a: 0, b: 1, value: 5.3 }],
    }
    expect(solveRoomOutline(input)).toEqual(solveRoomOutline(input))
    expect(solveRoomOutline({ ...input, maxIterations: 1000 }).iterations).toBeLessThanOrEqual(200)
    const many: OutlinePoint[] = Array.from({ length: OUTLINE_MAX_CORNERS }, (_, i) => [
      Math.cos((i / OUTLINE_MAX_CORNERS) * Math.PI * 2) * 5,
      Math.sin((i / OUTLINE_MAX_CORNERS) * Math.PI * 2) * 5,
    ])
    const started = Date.now()
    solveRoomOutline({ polygon: many, constraints: [{ type: 'distance', a: 0, b: 1, value: 0.7 }] })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(() => solveRoomOutline({ polygon: [...many, [9, 9]] })).toThrow(OutlineSolverInputError)
  })

  it('refuses malformed input', () => {
    expect(() =>
      solveRoomOutline({
        polygon: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toThrow(OutlineSolverInputError)
    expect(() =>
      solveRoomOutline({ polygon: rect(2, 2), constraints: [{ type: 'rightAngle', corner: 9 }] }),
    ).toThrow(OutlineSolverInputError)
    expect(() =>
      solveRoomOutline({
        polygon: rect(2, 2),
        constraints: [{ type: 'distance', a: 0, b: 1, value: -1 }],
      }),
    ).toThrow(OutlineSolverInputError)
  })

  it('turns confidence into trust', () => {
    expect(edgeSigma({ confidence: 'high' })).toBeLessThan(edgeSigma({ confidence: 'low' }))
    expect(edgeSigma({ confidence: 'low', basis: 'assumed' })).toBeGreaterThan(
      edgeSigma({ confidence: 'low' }),
    )
    expect(edgeSigma({ confidence: 'low', likelyGlass: true })).toBeGreaterThan(
      edgeSigma({ confidence: 'low' }),
    )
    expect(edgeSigma({ sigma: 0.01, confidence: 'low' })).toBe(0.01)
  })
})
