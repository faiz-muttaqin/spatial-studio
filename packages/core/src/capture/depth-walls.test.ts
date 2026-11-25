import { describe, expect, test } from 'bun:test'
import { deriveDepthWalls, estimateVerticalExtent, floorPolygonsFromPlanes } from './depth-walls'
import { IDENTITY_SCAN_TRANSFORM, type Vec2 } from './plane-analysis'
import { proposeRoom } from './room-proposal'
import type { CapturePlane } from './streams'
import {
  area,
  CAMERA_HEIGHT,
  loop,
  polygonWalls,
  type World,
  walk,
} from './synthetic-depth.test-helpers'

const rectangle: Vec2[] = [
  [0, 0],
  [5, 0],
  [5, 4],
  [0, 4],
]

describe('floor and ceiling from depth', () => {
  test('finds both levels of a room from the depth heights alone', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const vertical = estimateVerticalExtent(frames, IDENTITY_SCAN_TRANSFORM)
    expect(vertical.floorY).toBeCloseTo(0, 1)
    expect(vertical.ceilingY).toBeCloseTo(2.6, 1)
  })
})

describe('depth wall candidates', () => {
  test('a rectangular room gives four fitted walls that enclose the path', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const flat = new Float32Array(path.flatMap(([x, , z]) => [x, z]))
    const evidence = deriveDepthWalls(frames, { path: flat })
    expect(evidence.vertical).toMatchObject({ floorBasis: 'depth-histogram' })
    const near = (value: number, target: number) => Math.abs(value - target) < 0.15
    const onWall = (
      candidate: (typeof evidence.candidates)[number],
      pick: (p: Vec2) => number,
      target: number,
    ) => near(pick(candidate.a), target) && near(pick(candidate.b), target)
    for (const [pick, target] of [
      [(p: Vec2) => p[1], 0],
      [(p: Vec2) => p[0], 5],
      [(p: Vec2) => p[1], 4],
      [(p: Vec2) => p[0], 0],
    ] as const) {
      expect(evidence.candidates.some((candidate) => onWall(candidate, pick, target))).toBe(true)
    }
    const fitted = evidence.candidates.filter((candidate) => candidate.basis === 'depth-fit')
    expect(fitted.length).toBeGreaterThanOrEqual(4)
    expect(fitted.every((candidate) => candidate.rmse < 0.06)).toBe(true)
  })

  test('is bounded: frames are subsampled and the work stays typed', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames } = walk(world, loop(0.8, 0.8, 4.2, 3.2, 0.3), 4)
    expect(frames.length).toBeGreaterThan(150)
    const evidence = deriveDepthWalls(frames, { maxFrames: 40, pixelStep: 4 })
    expect(evidence.stats.framesUsed).toBe(40)
    expect(evidence.cells).toBeInstanceOf(Float32Array)
  })

  test('a candidate the walked path steps through is split there, not kept whole', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const through = path.map(([x, , z]): Vec2 => [x, z])
    through.push([4, 2], [4.5, 2], [5.5, 2], [6.5, 2])
    const evidence = deriveDepthWalls(frames, { path: new Float32Array(through.flat()) })
    expect(evidence.notes.join(' ')).toContain('walked path crosses it')
    const east = evidence.candidates.filter(
      (candidate) => Math.abs(candidate.a[0] - 5) < 0.2 && Math.abs(candidate.b[0] - 5) < 0.2,
    )
    for (const piece of east) {
      const zs = [piece.a[1], piece.b[1]].sort((l, r) => l - r)
      expect(zs[0]! < 1.6 ? zs[1]! <= 1.7 : zs[0]! >= 2.3).toBe(true)
    }
  })
})

describe('room proposal from depth', () => {
  test('rectangle: four depth-fit edges, a height, nothing presented as measured', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.method).toBe('depth')
    expect(proposal.polygon).toHaveLength(4)
    expect(area(proposal.polygon!)).toBeGreaterThan(18)
    expect(area(proposal.polygon!)).toBeLessThan(22)
    expect(proposal.height?.basis).toBe('depth-estimate')
    expect(proposal.height?.value).toBeCloseTo(2.6, 0)
    for (const edge of proposal.edges) {
      expect(edge.basis).toBe('depth-fit')
      expect(edge.confidence).not.toBe('high')
      expect(edge.evidenceIds.some((id) => id.startsWith('depth-fit:'))).toBe(true)
      expect(edge.evidenceIds.every((id) => /^(depth-fit|floor-boundary):/.test(id))).toBe(true)
      expect(edge.evidencePlaneIds).toEqual([])
      expect(edge.likelyGlass).toBe(false)
    }
    expect(proposal.unknowns.join(' ')).toContain('not measured walls')
    expect(proposal.unknowns.join(' ')).toContain('not a detected plane')
    expect(proposal.unknowns.join(' ')).not.toContain('walked-path points outside')
    expect(proposal.depth?.pathChecked).toBe(true)
    expect(proposal.needsVerification).toBe(true)
  })

  test('L-shaped room: six corners and the notch', () => {
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
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).not.toBeNull()
    expect(proposal.polygon!.length).toBeGreaterThanOrEqual(5)
    // True area is 18 m2; a partial or squared-off reading must not exceed the bounding box of 24.
    expect(area(proposal.polygon!)).toBeGreaterThan(12)
    expect(area(proposal.polygon!)).toBeLessThan(26)
    expect(proposal.edges.every((edge) => edge.confidence !== 'high')).toBe(true)
  })

  test('a rotated, non-orthogonal room keeps its angles', () => {
    const angle = (23 * Math.PI) / 180
    const turn = ([x, z]: Vec2): Vec2 => [
      x * Math.cos(angle) - z * Math.sin(angle),
      x * Math.sin(angle) + z * Math.cos(angle),
    ]
    const world: World = { walls: polygonWalls(rectangle.map(turn)), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2).map(turn))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).toHaveLength(4)
    const [first, second] = proposal.polygon!
    const edgeAngle = Math.atan2(second![1] - first![1], second![0] - first![0])
    const modulo = (((edgeAngle - angle) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
    expect(Math.min(modulo, Math.PI / 2 - modulo)).toBeLessThan((4 * Math.PI) / 180)
  })

  test('a glass wall with far points behind it is a flagged boundary, not a 9 m room', () => {
    // Solid walls on three sides and a far wall at x = 9; clear glass at x = 5.
    const world: World = {
      walls: [
        { a: [0, 0], b: [9, 0] },
        { a: [9, 0], b: [9, 4] },
        { a: [9, 4], b: [0, 4] },
        { a: [0, 4], b: [0, 0] },
      ],
      glass: [{ a: [5, 0], b: [5, 4] }],
      height: 2.6,
      indoorUntilX: 5,
    }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    // ARCore saw floor and ceiling up to the glass only.
    const planes: CapturePlane[] = [
      flatPlane('floor', 'horizontal-up', 0, [0, 5], [0, 4]),
      flatPlane('ceiling', 'horizontal-down', 2.6, [0, 5], [0, 4]),
    ]
    const proposal = proposeRoom({
      planes,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).not.toBeNull()
    const xs = proposal.polygon!.map((point) => point[0])
    expect(Math.max(...xs)).toBeLessThan(6.5)
    const glass = proposal.edges.filter((edge) => edge.likelyGlass)
    expect(glass.length).toBeGreaterThan(0)
    expect(['floor-boundary', 'assumed', 'carved']).toContain(glass[0]!.basis)
    expect(glass[0]!.seenBeyond!.maxDistance).toBeGreaterThan(2)
    expect(proposal.unknowns.join(' ')).toContain('likely glass')
    expect(proposal.depth?.seenThrough.length ?? 0).toBeGreaterThan(0)
  })

  test('sparse coverage keeps guessed or low-rated sides and never reports a high-confidence edge', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    // One stop in a corner, turning through a quarter circle: far sides are never seen.
    const { frames, path } = walk(world, [[1, 1]], 6, 0, Math.PI / 2)
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    if (proposal.polygon) {
      // Either a guessed closing side, or a carved edge that rests on no seen wall.
      expect(
        proposal.edges.some(
          (edge) =>
            edge.basis === 'assumed' || (edge.basis === 'carved' && edge.confidence === 'low'),
        ),
      ).toBe(true)
      expect(proposal.edges.every((edge) => edge.confidence !== 'high')).toBe(true)
      expect(proposal.unknowns.join(' ')).toContain('not measured walls')
    }
    expect(proposal.needsVerification).toBe(true)
  })

  test('no usable depth falls back to the typed measurements', () => {
    const typed = proposeRoom({
      planes: null,
      depthFrames: [],
      walkedPath: [[0, 1.4, 0]],
      measurements: {
        units: 'm',
        room: { width: 5, length: 4, height: 2.6 },
        openings: [],
        notes: '',
        source: 'manual',
      },
    })
    expect(typed.method).toBe('manual-measurements')
    expect(typed.edges.every((edge) => edge.basis === 'manual-measurement')).toBe(true)
  })

  test('without a walked path the outline is built but the checks are said to be skipped', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({ planes: null, measurements: null, depthFrames: frames })
    expect(proposal.polygon).not.toBeNull()
    expect(proposal.unknowns.join(' ')).toContain('No walked path was given')
    expect(proposal.depth?.pathChecked).toBe(false)
  })
})

describe('honesty cases', () => {
  const glassWorld = (indoorUntilX?: number): World => ({
    walls: [
      { a: [0, 0], b: [9, 0] },
      { a: [9, 0], b: [9, 4] },
      { a: [9, 4], b: [0, 4] },
      { a: [0, 4], b: [0, 0] },
    ],
    glass: [{ a: [5, 0], b: [5, 4] }],
    height: 2.6,
    indoorUntilX,
  })

  test('no floor plane, glass with no floor beyond it: the boundary is the floor extent and is flagged', () => {
    const { frames, path } = walk(glassWorld(5), loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).not.toBeNull()
    expect(Math.max(...proposal.polygon!.map((point) => point[0]))).toBeLessThan(6.5)
    expect(proposal.edges.some((edge) => edge.likelyGlass)).toBe(true)
    expect(proposal.unknowns.join(' ')).toContain('glass cannot be ruled out')
  })

  test('no floor plane, floor seen all the way to a far wall: no glass claim, but nothing far is rated above low', () => {
    const { frames, path } = walk(glassWorld(), loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.unknowns.join(' ')).toContain('glass cannot be ruled out')
    const far = proposal.edges.filter((edge) => edge.from[0] > 7 && edge.to[0] > 7)
    expect(far.length).toBeGreaterThan(0)
    expect(far.every((edge) => edge.confidence === 'low')).toBe(true)
  })

  test('a floor plane that stops short of a measured wall is ambiguous, not glass', () => {
    const long: Vec2[] = [
      [0, 0],
      [7, 0],
      [7, 4],
      [0, 4],
    ]
    const world: World = { walls: polygonWalls(long), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.6, 3.2))
    const planes: CapturePlane[] = [
      flatPlane('floor', 'horizontal-up', 0, [0, 5.4], [0, 4]),
      flatPlane('ceiling', 'horizontal-down', 2.6, [0, 7], [0, 4]),
    ]
    const proposal = proposeRoom({
      planes,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(proposal.polygon).not.toBeNull()
    expect(Math.max(...proposal.polygon!.map((point) => point[0]))).toBeGreaterThan(6.6)
    expect(proposal.edges.some((edge) => edge.likelyGlass)).toBe(false)
    expect(proposal.unknowns.join(' ')).toContain('Ambiguous boundary')
  })

  test('a short wall plane merged with depth does not turn depth ids into plane ids or a high edge', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const planes: CapturePlane[] = [
      {
        id: 'short',
        orientation: 'vertical',
        // A 1.2 m wall piece on z = 0, normal along +Z.
        centerPose: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 1.1, 1.3, 0, 1],
        extent: [1.2, 2.6],
        polygon: [
          [-0.6, -1.3],
          [0.6, -1.3],
          [0.6, 1.3],
          [-0.6, 1.3],
        ],
        subsumedBy: null,
      },
      flatPlane('floor', 'horizontal-up', 0, [0, 5], [0, 4]),
      flatPlane('ceiling', 'horizontal-down', 2.6, [0, 5], [0, 4]),
    ]
    const proposal = proposeRoom({
      planes,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    for (const edge of proposal.edges) {
      expect(edge.evidencePlaneIds.every((id) => id === 'short')).toBe(true)
      if (edge.evidenceIds.includes('short')) expect(edge.basis).not.toBe('plane-estimate')
      expect(edge.confidence === 'high' && edge.basis !== 'plane-estimate').toBe(false)
    }
  })

  test('the suggested scan transform is low confidence when the floor is estimated or contested', () => {
    const world: World = { walls: polygonWalls(rectangle), height: 2.6 }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const estimated = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    // The camera sits at y 1.4 in a floor-at-0 world, so the floor is 0 and no move is needed.
    expect(estimated.suggestedScanTransform).toBeNull()
    const shifted = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
      transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: 1 },
    })
    expect(shifted.suggestedScanTransform).toMatchObject({
      confidence: 'low',
      floorBasis: 'depth-histogram',
    })
    expect(shifted.suggestedScanTransform?.note).toContain('Estimated floor')
    // A plane floor 0.6 m above where depth piles up: the mismatch is reported and confidence stays low.
    const contested = proposeRoom({
      planes: [
        flatPlane('floor', 'horizontal-up', 0.6, [0, 5], [0, 4]),
        flatPlane('ceiling', 'horizontal-down', 2.6, [0, 5], [0, 4]),
      ],
      measurements: null,
      depthFrames: frames,
      walkedPath: path,
    })
    expect(contested.suggestedScanTransform).toMatchObject({
      confidence: 'low',
      floorBasis: 'plane',
    })
    expect(contested.suggestedScanTransform?.note).toContain('disagree')
    expect(contested.unknowns.join(' ')).toContain('floor level may be wrong')
  })

  test('a doorway the path goes through splits the wall instead of rejecting it', () => {
    const world: World = {
      walls: [
        { a: [0, 0], b: [5, 0] },
        { a: [5, 0], b: [5, 1.65] },
        { a: [5, 2.35], b: [5, 4] },
        { a: [5, 4], b: [0, 4] },
        { a: [0, 4], b: [0, 0] },
      ],
      height: 2.6,
    }
    const { frames, path } = walk(world, loop(0.8, 0.8, 4.2, 3.2))
    const out: Array<[number, number, number]> = [
      ...path,
      [4, CAMERA_HEIGHT, 2],
      [6.5, CAMERA_HEIGHT, 2],
      [4, CAMERA_HEIGHT, 2],
    ]
    const proposal = proposeRoom({
      planes: null,
      measurements: null,
      depthFrames: frames,
      walkedPath: out,
    })
    expect(proposal.polygon).not.toBeNull()
    expect(proposal.unknowns.join(' ')).toContain('split at')
    expect(Math.max(...proposal.polygon!.map((point) => point[0]))).toBeLessThan(5.8)
  })
})

describe('floor plane outlines', () => {
  test('only upward planes at the floor are used, in level coordinates', () => {
    const planes: CapturePlane[] = [
      flatPlane('floor', 'horizontal-up', 0, [0, 5], [0, 4]),
      flatPlane('table', 'horizontal-up', 0.75, [1, 2], [1, 2]),
      flatPlane('ceiling', 'horizontal-down', 2.6, [0, 5], [0, 4]),
    ]
    const polygons = floorPolygonsFromPlanes(planes, IDENTITY_SCAN_TRANSFORM, 0)
    expect(polygons).toHaveLength(1)
    const xs = polygons[0]!.map((point) => point[0])
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 5])
  })
})

/** A horizontal plane covering `[x0, x1]` by `[z0, z1]` at height `y`, as ARCore would report it. */
function flatPlane(
  id: string,
  orientation: 'horizontal-up' | 'horizontal-down',
  y: number,
  [x0, x1]: [number, number],
  [z0, z1]: [number, number],
): CapturePlane {
  const centreX = (x0 + x1) / 2
  const centreZ = (z0 + z1) / 2
  const halfX = (x1 - x0) / 2
  const halfZ = (z1 - z0) / 2
  return {
    id,
    orientation,
    // Local Y is the normal: up for a floor, down for a ceiling.
    centerPose: [
      1,
      0,
      0,
      0,
      0,
      orientation === 'horizontal-up' ? 1 : -1,
      0,
      0,
      0,
      0,
      1,
      0,
      centreX,
      y,
      centreZ,
      1,
    ],
    extent: [x1 - x0, z1 - z0],
    polygon: [
      [-halfX, -halfZ],
      [halfX, -halfZ],
      [halfX, halfZ],
      [-halfX, halfZ],
    ],
    subsumedBy: null,
  }
}
