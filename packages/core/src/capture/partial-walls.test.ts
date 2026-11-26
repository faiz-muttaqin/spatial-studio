import { describe, expect, test } from 'bun:test'
import type { DepthWallEvidence } from './depth-walls'
import { confirmPartialWalls, type PartialWallSources } from './partial-walls'
import type { PartialWallCandidate, Vec2, WallSegment } from './plane-analysis'

// Synthetic geometry only: walls along z, the room on the +z side, the phone walking at z 1.5 to 3.

function segment(id: string, a: Vec2, b: Vec2, bottom = 0, top = 0.9): WallSegment {
  return { planeId: id, a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]), bottom, top }
}

function candidate(
  id: string,
  a: Vec2,
  b: Vec2,
  bottom = 0,
  top = 0.9,
  floating: number | null = null,
): PartialWallCandidate {
  return { ...segment(id, a, b, bottom, top), floating }
}

/** Depth evidence holding only depth-fit lines. */
function depthLines(...lines: Array<[string, Vec2, Vec2]>): DepthWallEvidence {
  return {
    candidates: lines.map(([id, a, b]) => ({
      id,
      basis: 'depth-fit',
      a,
      b,
      length: Math.hypot(b[0] - a[0], b[1] - a[1]),
      support: 100,
      rmse: 0.02,
      frameIds: [],
    })),
    rejected: [],
    seenThrough: [],
    likelyGlassIds: [],
    ambiguous: [],
    floorCells: new Float64Array(0),
    vertical: {
      floorY: 0,
      ceilingY: 2.6,
      floorBasis: 'given',
      ceilingBasis: 'given',
      floorMismatch: null,
      lowerLevelY: null,
    },
    notes: [],
    stats: { framesUsed: 1, framesSkipped: 0, pointsUsed: 0, cells: 0, tallCells: 0 },
    cells: new Float32Array(0),
  }
}

const walked = new Float32Array(
  Array.from({ length: 40 }, (_, index) => [
    0.5 + (index % 10) * 0.45,
    1.5 + Math.floor(index / 10) * 0.5,
  ]).flat(),
)

const sources = (extra: Partial<PartialWallSources>): PartialWallSources => ({
  walls: [],
  depth: null,
  carved: null,
  floorPolygons: [],
  path: walked,
  ...extra,
})

describe('confirmPartialWalls: a wall behind the plane', () => {
  const front = candidate('front', [1, 0.6], [2.6, 0.6])

  test('a depth line 0.6 m behind it, and nothing else, makes it furniture', () => {
    const result = confirmPartialWalls(
      [front],
      sources({ depth: depthLines(['depth-fit:1', [0, 0], [5, 0]]) }),
    )
    expect(result.partial).toEqual([])
    expect(result.rejected).toEqual([
      {
        planeId: 'front',
        reason:
          'a 0.9 m tall vertical plane with the line fitted to depth points depth-fit:1 0.6 m behind it: furniture, not a room wall',
      },
    ])
  })

  test('a full-height wall plane 1.4 m behind it makes it furniture', () => {
    const result = confirmPartialWalls(
      [front],
      sources({ walls: [segment('w0', [0, -0.8], [5, -0.8], 0, 2.6)] }),
    )
    expect(result.rejected[0]?.reason).toBe(
      'a 0.9 m tall vertical plane with the full-height wall plane w0 1.4 m behind it: furniture, not a room wall',
    )
  })

  test('a wall beyond 1.5 m, or within 0.25 m, is not read as a wall behind it', () => {
    for (const z of [-1, 0.4]) {
      const result = confirmPartialWalls(
        [front],
        sources({ depth: depthLines(['depth-fit:1', [0, z], [5, z]]) }),
      )
      expect(result.rejected).toEqual([])
      // Nothing agrees either, so the 1.6 m wide plane outside the walked area stands alone, low.
      expect(result.partial.map((wall) => [wall.planeId, wall.cap])).toEqual([['front', 'low']])
    }
  })
})

describe('confirmPartialWalls: what agrees with the plane', () => {
  const lower = candidate('lower', [0.05, 0], [4.95, 0])
  const floor: Vec2[] = [
    [0.1, 0.1],
    [4.9, 0.1],
    [4.9, 3.9],
    [0.1, 3.9],
  ]

  test('only a depth line on the same face rates it low', () => {
    const result = confirmPartialWalls(
      [lower],
      sources({ depth: depthLines(['depth-fit:1', [0, 0.05], [5, 0.05]]) }),
    )
    expect(result.partial).toHaveLength(1)
    expect(result.partial[0]!.cap).toBe('low')
    expect(result.partial[0]!.reason).toBe(
      'lower, 0.9 m tall: only the line fitted to depth points depth-fit:1 agrees with it, and a depth line may be fitted to the same furniture face',
    )
  })

  test('a floor-plane edge is independent of the plane and rates it medium', () => {
    const result = confirmPartialWalls(
      [lower],
      sources({ depth: depthLines(['depth-fit:1', [0, 0.05], [5, 0.05]]), floorPolygons: [floor] }),
    )
    expect(result.partial[0]!.cap).toBe('medium')
    expect(result.partial[0]!.reason).toBe(
      'lower, 0.9 m tall: the edge of the floor plane and the line fitted to depth points depth-fit:1 agree with it',
    )
  })

  test('with no walked path a lone plane is not used', () => {
    const result = confirmPartialWalls([lower], sources({ path: new Float32Array(0) }))
    expect(result.partial).toEqual([])
    expect(result.rejected[0]!.reason).toContain(
      'no walked path shows it lies outside the walked area',
    )
  })
})

describe('confirmPartialWalls: a plane that floats and reaches the ceiling', () => {
  const upper = candidate('upper', [2.6, 0], [4.95, 0], 1.4, 2.6, 1.4)

  test('stays a mirror or ghost with no independent evidence, even with a depth line on it', () => {
    for (const depth of [null, depthLines(['depth-fit:1', [0, 0], [5, 0]])]) {
      const result = confirmPartialWalls([upper], sources({ depth }))
      expect(result.partial).toEqual([])
      expect(result.rejected[0]!.reason).toBe(
        'a vertical plane 1.4 m above the floor: a mirror, shelf or ghost; it reaches the ceiling, but no wall plane, carved boundary or floor-plane edge agrees with it',
      )
    }
  })

  test('is wall evidence when a full-height plane on the same wall agrees', () => {
    const result = confirmPartialWalls(
      [upper],
      sources({ walls: [segment('w0a', [0.05, 0], [2.1, 0], 0, 2.6)] }),
    )
    expect(result.partial).toHaveLength(1)
    expect(result.partial[0]).not.toHaveProperty('floating')
    expect(result.partial[0]!.cap).toBe('medium')
    expect(result.partial[0]!.reason).toBe(
      'upper, 1.2 m tall: the full-height wall plane w0a agrees with it',
    )
  })
})
