import { describe, expect, test } from 'bun:test'
import type { ProposalReview } from './scan-map-loader'
import {
  beginDrag,
  cornerAt,
  dragTo,
  edgeAt,
  edgeTone,
  endDrag,
  moveCorner,
  parseMetres,
  scanPlacementNow,
  setRightAngle,
  setTape,
  solveReview,
  startReview,
} from './scan-review'

const proposal: ProposalReview = {
  polygon: [
    [0, 0],
    [5, 0],
    [5, 4],
    [0, 4],
  ],
  edges: [
    { confidence: 'high', basis: 'plane-estimate', likelyGlass: false, length: 5 },
    { confidence: 'medium', basis: 'depth-fit', likelyGlass: false, length: 4 },
    { confidence: 'low', basis: 'assumed', likelyGlass: false, length: 5 },
    { confidence: 'low', basis: 'carved', likelyGlass: true, length: 4 },
  ],
  height: { value: 2.6, basis: 'depth-estimate' },
  suggestedScanTransform: null,
  unknowns: [],
  scanTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
}

describe('scan review state', () => {
  test('starts from the proposal with its height', () => {
    const state = startReview(proposal)
    expect(state.height).toBe(2.6)
    expect(solveReview(state).edges.map((e) => Math.round(e.length * 100) / 100)).toEqual([
      5, 4, 5, 4,
    ])
  })

  test('a tape changes the measured edge and the live result', () => {
    const state = setTape(startReview(proposal), 0, 5.4)
    const solved = solveReview(state)
    expect(solved.edges[0]!.length).toBeCloseTo(5.4, 2)
    expect(solved.edges[0]!.measured).toBe(true)
    expect(setTape(state, 0, null).tapes).toEqual({})
  })

  test('a dragged corner moves the outline and counts as placed', () => {
    const state = moveCorner(startReview(proposal), 2, [5.5, 4.5])
    expect(state.placed).toEqual([false, false, true, false])
    const solved = solveReview(state)
    expect(solved.polygon[2]![0]).toBeGreaterThan(5.3)
  })

  test('a dragged corner stays on the cursor and the outline does not turn', () => {
    const start = startReview(proposal)
    let state = beginDrag(start, solveReview(start).polygon, 2)
    state = dragTo(state, [5.4, 4.3])
    const solved = solveReview(state)
    expect(solved.polygon[2]![0]).toBeCloseTo(5.4, 2)
    expect(solved.polygon[2]![1]).toBeCloseTo(4.3, 2)
    // the rest of the outline stays near where it was and does not turn
    expect(Math.hypot(solved.polygon[0]![0], solved.polygon[0]![1])).toBeLessThan(0.25)
    const turn = Math.atan2(
      solved.polygon[1]![1] - solved.polygon[0]![1],
      solved.polygon[1]![0] - solved.polygon[0]![0],
    )
    expect(Math.abs(turn)).toBeLessThan(0.02)
    const dropped = endDrag(state)
    expect(dropped.drag).toBeNull()
    expect(dropped.base[2]).toEqual([5.4, 4.3])
    expect(dropped.placed[2]).toBe(true)
  })

  test('the scan placement is taken from the scan as it is now', () => {
    const review = {
      ...proposal,
      scanTransform: {
        position: [1, 0.5, 2] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: 1,
      },
      suggestedScanTransform: {
        position: [1, 0.2, 2] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: 1,
        confidence: 'medium' as const,
        floorBasis: 'plane' as const,
      },
    }
    const moved = scanPlacementNow(review, { position: [3, 0.5, 4], rotation: [0, 1, 0], scale: 1 })
    expect(moved?.position[0]).toBe(3)
    expect(moved?.position[1]).toBeCloseTo(0.2, 6)
    expect(moved?.rotation).toEqual([0, 1, 0])
    expect(
      scanPlacementNow(proposal, { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }),
    ).toBeNull()
  })

  test('a right angle squares a skewed corner', () => {
    let state = moveCorner(startReview(proposal), 1, [5, 0.6])
    state = setRightAngle(state, 0, true)
    const solved = solveReview(state)
    expect(Math.abs(solved.residuals[0]!.error)).toBeLessThan(1)
  })

  test('edge tones separate glass and assumed from the confidence scale', () => {
    const state = startReview(proposal)
    expect([0, 1, 2, 3].map((i) => edgeTone(state, i))).toEqual([
      'high',
      'medium',
      'assumed',
      'glass',
    ])
  })

  test('hit tests and typed lengths', () => {
    expect(cornerAt(proposal.polygon, [5.1, 0.1], 0.3)).toBe(1)
    expect(cornerAt(proposal.polygon, [2, 2], 0.3)).toBeNull()
    expect(edgeAt(proposal.polygon, [2.5, 0.05], 0.2)).toBe(0)
    expect(parseMetres('5,25 m')).toBe(5.25)
    expect(parseMetres('abc')).toBeNull()
    expect(parseMetres('-2')).toBeNull()
    expect(parseMetres('')).toBeNull()
  })
})
