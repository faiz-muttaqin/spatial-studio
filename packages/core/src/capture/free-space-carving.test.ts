import { describe, expect, test } from 'bun:test'
import { carveRoomOutline } from './free-space-carving'
import type { Vec2 } from './plane-analysis'
import { chooseOutline, proposeRoom, type RoomProposal } from './room-proposal'
import {
  area,
  loop,
  type Noise,
  polygonWalls,
  type World,
  walk,
} from './synthetic-depth.test-helpers'

// Synthetic depth only: the ray caster from `synthetic-depth.test-helpers`, no real capture data.

const flat = (path: Array<[number, number, number]>) =>
  new Float32Array(path.flatMap(([x, , z]) => [x, z]))

const rotate = (points: Vec2[], angle: number): Vec2[] =>
  points.map(([x, z]) => [
    x * Math.cos(angle) - z * Math.sin(angle),
    x * Math.sin(angle) + z * Math.cos(angle),
  ])

const rectangle: Vec2[] = [
  [0, 0],
  [5, 0],
  [5, 4],
  [0, 4],
]

describe('free-space carving', () => {
  test('rectangle: four corners at the walls, squared, medium confidence at most', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const carved = carveRoomOutline(frames, { path: flat(path) })
    expect(carved.polygon).toHaveLength(4)
    expect(area(carved.polygon!)).toBeGreaterThan(18.5)
    expect(area(carved.polygon!)).toBeLessThan(21.5)
    const xs = carved.polygon!.map((p) => p[0])
    const zs = carved.polygon!.map((p) => p[1])
    expect(Math.min(...xs)).toBeGreaterThan(-0.2)
    expect(Math.max(...xs)).toBeLessThan(5.2)
    expect(Math.min(...zs)).toBeGreaterThan(-0.2)
    expect(Math.max(...zs)).toBeLessThan(4.2)
    expect(carved.vertical.floorY).toBeCloseTo(0, 1)
    expect(carved.vertical.ceilingY).toBeCloseTo(2.6, 1)
    for (const edge of carved.edges) {
      expect(edge.snap).toBe('axis')
      expect(edge.wallSupport).toBeGreaterThan(0.6)
      expect(edge.likelyGlass).toBe(false)
      expect(edge.confidence).toBe('medium')
    }
  })

  test('L-shape: six corners and the notch stays out', () => {
    const outline: Vec2[] = [
      [0, 0],
      [6, 0],
      [6, 2],
      [3, 2],
      [3, 4],
      [0, 4],
    ]
    const world: World = { walls: polygonWalls(outline), height: 2.6 }
    const positions: Vec2[] = [...loop(0.8, 0.8, 5.2, 1.2, 0.7), ...loop(0.8, 1.6, 2.2, 3.2, 0.7)]
    const { frames, path } = walk(world, positions)
    const carved = carveRoomOutline(frames, { path: flat(path) })
    expect(carved.polygon).toHaveLength(6)
    expect(area(carved.polygon!)).toBeGreaterThan(17)
    expect(area(carved.polygon!)).toBeLessThan(19.5)
  })

  test('rotated room: walls keep their angle and the corners stay four', () => {
    const angle = (30 * Math.PI) / 180
    const outline = rotate(rectangle, angle)
    const world: World = { walls: polygonWalls(outline), height: 2.6 }
    const positions = rotate(loop(0.8, 0.8, 4.2, 3.2), angle)
    const { frames, path } = walk(world, positions)
    const carved = carveRoomOutline(frames, { path: flat(path) })
    expect(carved.polygon).toHaveLength(4)
    expect(area(carved.polygon!)).toBeGreaterThan(18.5)
    expect(area(carved.polygon!)).toBeLessThan(21.5)
    expect(carved.stats.snapAngleDeg).not.toBeNull()
    const longest = carved.edges.reduce((a, b) => (b.length > a.length ? b : a))
    const heading =
      ((((Math.atan2(longest.to[1] - longest.from[1], longest.to[0] - longest.from[0]) * 180) /
        Math.PI) %
        180) +
        180) %
      180
    expect(Math.abs(heading - 30)).toBeLessThan(3)
  })

  test('a doorway into a second room: the outline stays with the room the phone walked', () => {
    const roomA: Vec2[] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]
    // Wall x = 4 has a 0.9 m doorway at z 1.5 to 2.4; room B is 3 m deep behind it.
    const walls = [
      ...polygonWalls(roomA).filter((w) => !(w.a[0] === 4 && w.b[0] === 4)),
      { a: [4, 0] as Vec2, b: [4, 1.5] as Vec2 },
      { a: [4, 2.4] as Vec2, b: [4, 4] as Vec2 },
      ...polygonWalls([
        [4, 0],
        [7, 0],
        [7, 4],
        [4, 4],
      ]).filter((w) => !(w.a[0] === 4 && w.b[0] === 4)),
    ]
    const { frames, path } = walk({ walls, height: 2.6 }, loop(0.8, 0.8, 3.2, 3.2), 12)
    const carved = carveRoomOutline(frames, { path: flat(path) })
    expect(carved.polygon).not.toBeNull()
    expect(area(carved.polygon!)).toBeGreaterThan(14)
    expect(area(carved.polygon!)).toBeLessThan(18.5)
    expect(Math.max(...carved.polygon!.map((p) => p[0]))).toBeLessThan(4.4)
  })

  test('a glass wall with far points: the far side is bounded, flagged and rated low', () => {
    // Solid walls enclose a 4 x 4 room and a 3 m strip behind a clear glass wall at x = 4.
    const walls = [
      ...polygonWalls([
        [0, 0],
        [7, 0],
        [7, 4],
        [0, 4],
      ]),
    ]
    const glass = [{ a: [4, 0] as Vec2, b: [4, 4] as Vec2 }]
    const world: World = { walls, glass, height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 3.2, 3.2), 12)
    const floorPolygons: Vec2[][] = [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
    ]
    const carved = carveRoomOutline(frames, { path: flat(path), floorPolygons })
    expect(carved.polygon).not.toBeNull()
    const glassy = carved.edges.filter((edge) => edge.likelyGlass)
    expect(glassy.length).toBeGreaterThan(0)
    expect(glassy.every((edge) => edge.confidence === 'low')).toBe(true)
    expect(carved.edges.every((edge) => edge.reason.length > 0)).toBe(true)
  })

  test('sparse coverage: no edge is rated above medium and unsupported edges are low', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    // The phone stays in one corner looking one way.
    const { frames, path } = walk(
      world,
      [
        [1, 1],
        [1.5, 1.2],
        [1.8, 1],
      ],
      6,
      0.3,
      1,
    )
    const carved = carveRoomOutline(frames, { path: flat(path) })
    if (carved.polygon === null) {
      expect(carved.notes.length).toBeGreaterThan(0)
      return
    }
    for (const edge of carved.edges) {
      if (edge.wallSupport < 0.6) expect(edge.confidence).toBe('low')
    }
  })

  test('too few points gives no outline and says why', () => {
    const carved = carveRoomOutline([], {})
    expect(carved.polygon).toBeNull()
    expect(carved.notes.join(' ')).toContain('Too few')
  })

  test('is bounded: the ray count is capped and the grid stays small', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2, 0.3), 4)
    expect(frames.length).toBeGreaterThan(150)
    const started = performance.now()
    const carved = carveRoomOutline(frames, { path: flat(path), maxRays: 100_000 })
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(carved.stats.framesUsed).toBe(120)
    expect(carved.stats.rays).toBeLessThanOrEqual(120 * 14400 * 0.4)
    expect(carved.stats.gridWidth).toBeLessThanOrEqual(505)
  })
})

describe('carved outline in the room proposal', () => {
  test('a fully backed line outline is kept, and the carved overlap is reported', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.method).toBe('depth')
    expect(proposal.depth?.carving?.used).toBe(false)
    expect(proposal.depth?.carving?.agreement).toBeGreaterThan(0.85)
    expect(proposal.depth?.carving?.decision).toContain('kept')
  })

  test('sparse walls: a carved outline is labelled carved, never high and never measured', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, [[1, 1]], 6, 0, Math.PI / 2)
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.depth?.carving).toBeDefined()
    if (proposal.method === 'carved') {
      expect(proposal.depth?.carving?.used).toBe(true)
      expect(proposal.edges.every((edge) => edge.basis === 'carved')).toBe(true)
      expect(proposal.edges.every((edge) => edge.confidence !== 'high')).toBe(true)
      expect(proposal.edges.every((edge) => edge.evidenceIds[0]?.startsWith('carved:'))).toBe(true)
      expect(proposal.unknowns.join(' ')).toContain('not measured walls')
    }
    expect(proposal.needsVerification).toBe(true)
  })

  test('glass: the carved outline does not grow to the far wall, and glass edges are low', () => {
    const world: World = {
      walls: polygonWalls([
        [0, 0],
        [9, 0],
        [9, 4],
        [0, 4],
      ]),
      glass: [{ a: [5, 0], b: [5, 4] }],
      height: 2.6,
      indoorUntilX: 5,
    }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(Math.max(...proposal.polygon!.map((p) => p[0]))).toBeLessThan(6.5)
    for (const edge of proposal.edges.filter((e) => e.likelyGlass)) {
      expect(edge.confidence).toBe('low')
    }
  })
})

const noise = (relative: number): Noise => ({
  relative,
  fixed: 0.01,
  dropout: 0.2,
  lowConfidence: 0.4,
  wander: { position: 0.08, yaw: 0.05 },
})

describe('free-space carving with sensor noise', () => {
  const lShape: Vec2[] = [
    [0, 0],
    [6, 0],
    [6, 2],
    [3, 2],
    [3, 4],
    [0, 4],
  ]

  test.each([0.02, 0.04])(
    'rectangle at %p range noise keeps its size and four corners',
    (relative) => {
      const world: World = { walls: polygonWalls(rectangle), height: 2.6, noise: noise(relative) }
      const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2), 10)
      const carved = carveRoomOutline(frames, { path: flat(path) })
      expect(carved.polygon).not.toBeNull()
      expect(area(carved.polygon!)).toBeGreaterThanOrEqual(0.85 * 20)
      expect(area(carved.polygon!)).toBeLessThan(22)
      expect(carved.polygon!.length).toBeLessThanOrEqual(6)
    },
  )

  test.each([0.02, 0.04])('L-shape at %p range noise keeps its size', (relative) => {
    const world: World = { walls: polygonWalls(lShape), height: 2.6, noise: noise(relative) }
    const positions: Vec2[] = [...loop(0.8, 0.8, 5.2, 1.2, 0.7), ...loop(0.8, 1.6, 2.2, 3.2, 0.7)]
    const { frames, path } = walk(world, positions, 10)
    const carved = carveRoomOutline(frames, { path: flat(path) })
    expect(carved.polygon).not.toBeNull()
    expect(area(carved.polygon!)).toBeGreaterThanOrEqual(0.85 * 18)
    expect(carved.polygon!.length).toBeLessThanOrEqual(8)
  })

  test('heavy noise: an outline that comes out short is rated low, never medium', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6, noise: noise(0.08) }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2), 10)
    const carved = carveRoomOutline(frames, { path: flat(path) })
    if (carved.polygon && area(carved.polygon) < 0.85 * 20) {
      expect(carved.edges.every((edge) => edge.confidence === 'low')).toBe(true)
    }
  })

  test('glass with the floor and ceiling seen through it: the area stays under 20 m² and the glass edge is flagged', () => {
    // A 4 x 4 m room (16 m²) with clear glass at x = 4 and a 3 m strip behind it, all with floor.
    const world: World = {
      walls: polygonWalls([
        [0, 0],
        [7, 0],
        [7, 4],
        [0, 4],
      ]),
      glass: [{ a: [4, 0], b: [4, 4] }],
      height: 2.6,
    }
    const { frames, path } = walk(world, loop(0.8, 0.8, 3.2, 3.2), 12)
    const floorPolygons: Vec2[][] = [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
    ]
    const carved = carveRoomOutline(frames, { path: flat(path), floorPolygons })
    expect(carved.polygon).not.toBeNull()
    expect(area(carved.polygon!)).toBeLessThan(20)
    const east = carved.edges.filter(
      (edge) => edge.from[0] > 3.5 && edge.to[0] > 3.5 && Math.abs(edge.from[0] - edge.to[0]) < 0.1,
    )
    expect(east.length).toBeGreaterThan(0)
    expect(east.every((edge) => edge.likelyGlass && edge.confidence === 'low')).toBe(true)
  })
})

describe('choosing between line and carved outlines', () => {
  const square = (size: number): Vec2[] => [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ]
  const lines = (size: number, bases: Array<'depth-fit' | 'assumed'>): RoomProposal =>
    ({
      polygon: square(size),
      edges: bases.map((basis, index) => ({ index, basis, confidence: 'medium' })),
    }) as unknown as RoomProposal
  const carvedOutline = (size: number, corners?: Vec2[]) =>
    ({
      polygon: corners ?? square(size),
      edges: (corners ?? square(size)).map((_, index) => ({
        index,
        confidence: 'medium',
        likelyGlass: false,
      })),
      notes: [],
      stats: { positions: 10, droppedPositions: 0 },
    }) as never

  test('an accurate line outline with one assumed edge beats a noisy, smaller carved outline', () => {
    const choice = chooseOutline(
      lines(4.5, ['depth-fit', 'depth-fit', 'depth-fit', 'assumed']),
      carvedOutline(3.6),
      new Float32Array(0),
    )
    expect(choice.useCarved).toBe(false)
    expect(choice.decision).toContain('not used')
  })

  test('with no line outline the carved outline is used', () => {
    expect(chooseOutline(null, carvedOutline(4), new Float32Array(0)).useCarved).toBe(true)
  })

  test('a ragged carved outline is vetoed against a mostly backed line outline', () => {
    const ragged: Vec2[] = Array.from({ length: 16 }, (_, i): Vec2 => {
      const angle = (i / 16) * 2 * Math.PI
      return [2.25 + 2.2 * Math.cos(angle), 2.25 + 2.2 * Math.sin(angle)]
    })
    const carved = carvedOutline(4.5, ragged) as { edges: Array<{ confidence: string }> }
    for (const edge of carved.edges) edge.confidence = 'low'
    const choice = chooseOutline(
      lines(4.5, ['depth-fit', 'depth-fit', 'depth-fit', 'assumed']),
      carved as never,
      new Float32Array(0),
    )
    expect(choice.useCarved).toBe(false)
  })
})
