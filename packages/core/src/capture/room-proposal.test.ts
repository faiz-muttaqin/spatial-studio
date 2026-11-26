import { describe, expect, test } from 'bun:test'
import { analysePlanes, type Vec2 } from './plane-analysis'
import { proposeRoom } from './room-proposal'
import type { CapturePlane, ManualMeasurements } from './streams'
import { loop, polygonWalls, type World, walk } from './synthetic-depth.test-helpers'

/** Column-major pose from basis columns and a translation. */
function pose(x: number[], y: number[], z: number[], t: number[]): number[] {
  return [...x, 0, ...y, 0, ...z, 0, ...t, 1]
}

/** An upright wall plane between two floor points; local X runs along the wall, local Y is the normal. */
function wall(id: string, a: [number, number], b: [number, number], height = 2.5): CapturePlane {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  const dx = (b[0] - a[0]) / length
  const dz = (b[1] - a[1]) / length
  return {
    id,
    orientation: 'vertical',
    centerPose: pose(
      [dx, 0, dz],
      [dz, 0, -dx],
      [0, 1, 0],
      [(a[0] + b[0]) / 2, height / 2, (a[1] + b[1]) / 2],
    ),
    extent: [length, height],
    polygon: [
      [-length / 2, -height / 2],
      [length / 2, -height / 2],
      [length / 2, height / 2],
      [-length / 2, height / 2],
    ],
    subsumedBy: null,
  }
}

function horizontal(
  id: string,
  orientation: 'horizontal-up' | 'horizontal-down',
  y: number,
  half: [number, number],
  centre: [number, number] = [0, 0],
): CapturePlane {
  return {
    id,
    orientation,
    centerPose: pose(
      [1, 0, 0],
      [0, orientation === 'horizontal-up' ? 1 : -1, 0],
      [0, 0, 1],
      [centre[0], y, centre[1]],
    ),
    extent: [half[0] * 2, half[1] * 2],
    polygon: [
      [-half[0], -half[1]],
      [half[0], -half[1]],
      [half[0], half[1]],
      [-half[0], half[1]],
    ],
    subsumedBy: null,
  }
}

/**
 * Corners walked in order become walls, with ARCore-like slack: ends fall 5 cm short. With `top`,
 * each plane covers only the floor up to that height, as ARCore often sees a plain wall.
 */
function room(corners: Array<[number, number]>, skip: number[] = [], top?: number): CapturePlane[] {
  const planes: CapturePlane[] = []
  corners.forEach((from, index) => {
    if (skip.includes(index)) return
    const to = corners[(index + 1) % corners.length]!
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    const trim = 0.05 / length
    const lerp = (t: number): [number, number] => [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
    ]
    const id = `w${index}`
    planes.push(
      top === undefined
        ? wall(id, lerp(trim), lerp(1 - trim))
        : panel(id, lerp(trim), lerp(1 - trim), 0, top),
    )
  })
  return planes
}

const shape = (points: ReadonlyArray<readonly [number, number]> | null) =>
  points?.map(([x, z]) => [Math.round(x * 20) / 20, Math.round(z * 20) / 20])

function sorted(points: ReadonlyArray<readonly [number, number]>) {
  return shape(points)?.toSorted((left, right) => left[0]! - right[0]! || left[1]! - right[1]!)
}

const floorAndCeiling = [
  horizontal('floor', 'horizontal-up', 0.02, [2, 2], [2, 2]),
  horizontal('ceiling', 'horizontal-down', 2.52, [2, 2], [2, 2]),
]

describe('proposeRoom from planes', () => {
  test('a rectangle becomes four corners and a floor-to-ceiling height', () => {
    const proposal = proposeRoom({
      planes: [
        ...room([
          [0, 0],
          [4, 0],
          [4, 3],
          [0, 3],
        ]),
        ...floorAndCeiling,
      ],
      measurements: null,
    })
    expect(proposal.method).toBe('planes')
    expect(sorted(proposal.polygon!)).toEqual([
      [0, 0],
      [0, 3],
      [4, 0],
      [4, 3],
    ])
    expect(proposal.height).toEqual({ value: 2.5, basis: 'plane-estimate' })
    expect(proposal.edges).toHaveLength(4)
    expect(proposal.edges.every((edge) => edge.basis === 'plane-estimate')).toBe(true)
    expect(proposal.edges.every((edge) => edge.confidence === 'high')).toBe(true)
    expect(proposal.edges.every((edge) => edge.evidencePlaneIds.length === 1)).toBe(true)
    expect(proposal.unknowns).toEqual([])
    expect(proposal.needsVerification).toBe(true)
  })

  test('the outline is counter-clockwise whichever way the walls were listed', () => {
    const planes = room([
      [0, 0],
      [0, 3],
      [4, 3],
      [4, 0],
    ])
    const { polygon } = proposeRoom({ planes, measurements: null })
    let area = 0
    polygon!.forEach(([x1, z1], index) => {
      const [x2, z2] = polygon![(index + 1) % polygon!.length]!
      area += x1 * z2 - x2 * z1
    })
    expect(area / 2).toBeCloseTo(12, 0)
  })

  test('an L-shape keeps its notch', () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 4],
      [0, 4],
    ]
    const proposal = proposeRoom({ planes: room(corners), measurements: null })
    expect(proposal.polygon).toHaveLength(6)
    expect(sorted(proposal.polygon!)).toEqual(sorted(corners))
    expect(proposal.planesIgnored).toEqual([])
  })

  test('walls merge when a plane is split in two', () => {
    const planes = room([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]).filter((plane) => plane.id !== 'w0')
    planes.push(wall('w0a', [0.05, 0], [1.9, 0]), wall('w0b', [2.1, 0.02], [3.95, 0.02]))
    const proposal = proposeRoom({ planes, measurements: null })
    expect(proposal.polygon).toHaveLength(4)
    const bottom = proposal.edges.find((edge) => edge.evidencePlaneIds.includes('w0a'))
    expect(bottom?.evidencePlaneIds.toSorted()).toEqual(['w0a', 'w0b'])
  })

  test('one oblique wall gives a non-orthogonal corner', () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [5, 3],
      [0, 3],
    ]
    const proposal = proposeRoom({ planes: room(corners), measurements: null })
    expect(sorted(proposal.polygon!)).toEqual(sorted(corners))
    const oblique = proposal.edges.find((edge) => edge.evidencePlaneIds.includes('w1'))
    expect(oblique?.length).toBeCloseTo(Math.hypot(1, 3), 1)
  })

  test('a side that was not seen is closed with an assumed edge and listed as unknown', () => {
    const proposal = proposeRoom({
      planes: [
        ...room(
          [
            [0, 0],
            [4, 0],
            [4, 3],
            [0, 3],
          ],
          [3],
        ),
        ...floorAndCeiling,
      ],
      measurements: null,
    })
    expect(proposal.polygon).toHaveLength(4)
    const assumed = proposal.edges.filter((edge) => edge.basis === 'assumed')
    expect(assumed).toHaveLength(1)
    expect(assumed[0]!.confidence).toBe('low')
    expect(assumed[0]!.evidencePlaneIds).toEqual([])
    expect(proposal.unknowns.join(' ')).toContain('One side of the room was not seen')
    // The walls beside the gap end where they were last seen, so they are not rated high.
    expect(proposal.edges.filter((edge) => edge.confidence === 'high')).toHaveLength(1)
  })

  test('a missing ceiling leaves the height unknown unless a manual one fills it', () => {
    const planes = room([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ])
    const bare = proposeRoom({ planes, measurements: null })
    expect(bare.height).toBeNull()
    expect(bare.unknowns.join(' ')).toContain('ceiling')
    const measured: ManualMeasurements = {
      units: 'm',
      room: { width: null, length: null, height: 2.6 },
      openings: [],
      notes: '',
      source: 'manual',
    }
    expect(proposeRoom({ planes, measurements: measured }).height).toEqual({
      value: 2.6,
      basis: 'manual-measurement',
    })
  })

  test('the scan node transform moves the outline into level coordinates', () => {
    const planes = room([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ])
    const moved = proposeRoom({
      planes,
      measurements: null,
      transform: { position: [10, 0, 20], rotation: [0, Math.PI / 2, 0], scale: 1 },
    })
    // A quarter turn about Y sends capture (x, z) to (z, -x), then the node offset applies.
    expect(sorted(moved.polygon!)).toEqual([
      [10, 16],
      [10, 20],
      [13, 16],
      [13, 20],
    ])
    const scaled = proposeRoom({
      planes,
      measurements: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 2 },
    })
    expect(sorted(scaled.polygon!)).toEqual([
      [0, 0],
      [0, 6],
      [8, 0],
      [8, 6],
    ])
  })

  test('two walls are not enough for an outline', () => {
    const proposal = proposeRoom({
      planes: room([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]).slice(0, 2),
      measurements: null,
    })
    expect(proposal.polygon).toBeNull()
    expect(proposal.method).toBe('none')
  })
})

describe('proposeRoom from manual measurements', () => {
  const measurements: ManualMeasurements = {
    units: 'm',
    room: { width: 4.2, length: 3.1, height: 2.4 },
    openings: [],
    notes: '',
    source: 'manual',
  }

  test('a measurements-only bundle gives a rectangle that says where it was guessed', () => {
    const proposal = proposeRoom({ planes: null, measurements })
    expect(proposal.method).toBe('manual-measurements')
    expect(sorted(proposal.polygon!)).toEqual([
      [0, 0],
      [0, 3.1],
      [4.2, 0],
      [4.2, 3.1],
    ])
    expect(proposal.height).toEqual({ value: 2.4, basis: 'manual-measurement' })
    expect(proposal.edges.every((edge) => edge.basis === 'manual-measurement')).toBe(true)
    expect(proposal.unknowns.join(' ')).toContain('Placement and rotation are assumed')
  })

  test('falls back to the rectangle when planes give no outline', () => {
    const proposal = proposeRoom({
      planes: [wall('only', [0, 0], [4, 0])],
      measurements,
    })
    expect(proposal.method).toBe('manual-measurements')
    expect(proposal.unknowns.join(' ')).toContain('No outline from planes')
  })

  test('with neither it says what to ask for', () => {
    const proposal = proposeRoom({
      planes: null,
      measurements: { ...measurements, room: { width: 4, length: null, height: null } },
    })
    expect(proposal.method).toBe('none')
    expect(proposal.polygon).toBeNull()
    expect(proposal.unknowns.join(' ')).toContain('Ask the person')
  })

  test('flags a manual height that disagrees with the planes', () => {
    const proposal = proposeRoom({
      planes: [
        ...room([
          [0, 0],
          [4, 0],
          [4, 3],
          [0, 3],
        ]),
        ...floorAndCeiling,
      ],
      measurements,
    })
    expect(proposal.height?.basis).toBe('plane-estimate')
    expect(proposal.unknowns.join(' ')).toContain('manual measurement says 2.4 m')
  })
})

describe('analysePlanes', () => {
  test('picks the floor over a tabletop and skips merged and tilted planes', () => {
    const table = horizontal('table', 'horizontal-up', 0.75, [0.4, 0.4])
    const merged = { ...wall('merged', [0, 0], [4, 0]), subsumedBy: 'w0' }
    const analysis = analysePlanes([
      ...floorAndCeiling,
      table,
      merged,
      wall('tiny', [0, 0], [0.2, 0]),
    ])
    expect(analysis.floor?.planeId).toBe('floor')
    expect(analysis.ceiling?.planeId).toBe('ceiling')
    expect(analysis.height).toBe(2.5)
    expect(analysis.skipped.map((item) => item.planeId).toSorted()).toEqual(['merged', 'tiny'])
    expect(analysis.walls).toHaveLength(0)
  })
})

/** A horizontal-ish furniture front: a short wall plane with its own bottom and top. */
function panel(
  id: string,
  a: [number, number],
  b: [number, number],
  bottom: number,
  top: number,
): CapturePlane {
  const base = wall(id, a, b, top - bottom)
  const pose = [...base.centerPose]
  pose[13] = (bottom + top) / 2
  return { ...base, centerPose: pose }
}

const floorUp = (y: number, half: [number, number], centre: [number, number] = [2, 2.5]) =>
  horizontal('floor', 'horizontal-up', y, half, centre)

const rect45 = () =>
  room([
    [0, 0],
    [4, 0],
    [4, 5],
    [0, 5],
  ])
const roomFlats = [
  horizontal('floor', 'horizontal-up', 0, [2, 2.5], [2, 2.5]),
  horizontal('ceiling', 'horizontal-down', 2.8, [2, 2.5], [2, 2.5]),
]

describe('clutter, duplicate and ghost planes', () => {
  const expectCleanRectangle = (planes: CapturePlane[]) => {
    const proposal = proposeRoom({ planes, measurements: null })
    expect(proposal.polygon).toHaveLength(4)
    expect(sorted(proposal.polygon!)).toEqual([
      [0, 0],
      [0, 5],
      [4, 0],
      [4, 5],
    ])
    expect(proposal.unknowns.join(' ')).not.toContain('not seen')
    return proposal
  }

  test('a second plane 0.2 m inside a wall does not add corners', () => {
    const proposal = expectCleanRectangle([
      ...rect45(),
      wall('dup', [0.3, 0.2], [3.7, 0.2]),
      ...roomFlats,
    ])
    expect(proposal.planesIgnored.map((item) => item.planeId)).toEqual(['dup'])
    expect(proposal.planesIgnored[0]!.reason).toContain('parallel to a longer wall')
  })

  test('a cabinet front and a sofa back are too short to be walls', () => {
    const proposal = expectCleanRectangle([
      ...rect45(),
      panel('cabinet', [1, 0.4], [2.6, 0.4], 0, 0.9),
      panel('sofa', [0.5, 3], [3, 3], 0, 0.8),
      ...roomFlats,
    ])
    expect(proposal.planesIgnored.map((item) => item.planeId).toSorted()).toEqual([
      'cabinet',
      'sofa',
    ])
    expect(proposal.planesIgnored[0]!.reason).toContain('furniture')
  })

  test('a mirror that floats above the floor is ignored', () => {
    const proposal = expectCleanRectangle([
      ...rect45(),
      panel('mirror', [1, 2], [3, 2], 1.0, 2.2),
      ...roomFlats,
    ])
    expect(proposal.planesIgnored.find((item) => item.planeId === 'mirror')?.reason).toContain(
      'mirror',
    )
  })

  test('a ghost plane behind a wall competes with it and loses', () => {
    expectCleanRectangle([...rect45(), wall('ghost', [0.2, -0.45], [3.8, -0.45]), ...roomFlats])
  })

  test('a wall seen twice with a small offset merges instead of competing', () => {
    const proposal = proposeRoom({
      planes: [...rect45(), wall('pass2', [0.1, 0.08], [3.9, 0.08]), ...roomFlats],
      measurements: null,
    })
    expect(proposal.polygon).toHaveLength(4)
    expect(proposal.planesIgnored).toEqual([])
    expect(proposal.edges.some((edge) => edge.evidencePlaneIds.includes('pass2'))).toBe(true)
  })

  test('ranks by wall length covered, not by line count', () => {
    // Two short interior stubs would make more lines, but the long outer walls cover more.
    const proposal = expectCleanRectangle([
      ...rect45(),
      wall('stub1', [1, 1], [1, 1.9]),
      wall('stub2', [2, 1], [2, 1.9]),
      ...roomFlats,
    ])
    expect(proposal.planesUsed.toSorted()).toEqual(['w0', 'w1', 'w2', 'w3'])
  })
})

describe('floor and ceiling choice', () => {
  const walls = () =>
    room([
      [0, 0],
      [4, 0],
      [4, 5],
      [0, 5],
    ]).map((plane) => plane)

  test('a tabletop larger than the visible floor is not the floor', () => {
    const planes = [
      ...walls(),
      floorUp(0.75, [2, 2.5]),
      { ...horizontal('floor', 'horizontal-up', 0, [0.8, 1.2], [1, 1]), id: 'real-floor' },
      horizontal('ceiling', 'horizontal-down', 2.8, [2, 2.5], [2, 2.5]),
    ]
    const proposal = proposeRoom({ planes, measurements: null })
    expect(proposal.height).toEqual({ value: 2.8, basis: 'plane-estimate' })
    expect(proposal.floorY).toBe(0)
  })

  test('with only a tabletop the floor is unknown and says why', () => {
    const planes = [
      ...walls(),
      horizontal('table', 'horizontal-up', 0.75, [2, 2.5], [2, 2.5]),
      horizontal('ceiling', 'horizontal-down', 2.8, [2, 2.5], [2, 2.5]),
    ]
    const proposal = proposeRoom({ planes, measurements: null })
    expect(proposal.floorY).toBeNull()
    expect(proposal.height).toBeNull()
    expect(proposal.unknowns.join(' ')).toContain('No upward plane sits at the foot of the walls')
  })

  test('a cabinet underside is not a ceiling', () => {
    const planes = [
      ...walls(),
      floorUp(0, [2, 2.5]),
      horizontal('underside', 'horizontal-down', 2.05, [1, 1], [1, 1]),
      horizontal('ceiling', 'horizontal-down', 2.8, [2, 2.5], [2, 2.5]),
    ]
    // The underside is in the plausible range but far from where the walls end; the ceiling wins.
    const proposal = proposeRoom({ planes, measurements: null })
    expect(proposal.height).toEqual({ value: 2.8, basis: 'plane-estimate' })
  })

  test('heights outside 2 to 6 m are refused with an accurate message', () => {
    const low = proposeRoom({
      planes: [...walls(), floorUp(0, [2, 2.5]), horizontal('c', 'horizontal-down', 1.6, [2, 2.5])],
      measurements: null,
    })
    expect(low.height).toBeNull()
    expect(low.unknowns.join(' ')).toContain('outside 2 to 6 m above the floor')
    expect(low.unknowns.join(' ')).not.toContain('No downward plane')
    const none = proposeRoom({ planes: [...walls(), floorUp(0, [2, 2.5])], measurements: null })
    expect(none.unknowns.join(' ')).toContain('No downward plane was seen')
    expect(none.unknowns.filter((text) => text.includes('ceiling height is known'))).toHaveLength(1)
  })

  test('a small floor plane is flagged', () => {
    const proposal = proposeRoom({
      planes: [
        ...walls(),
        horizontal('floor', 'horizontal-up', 0, [0.5, 0.5], [1, 1]),
        horizontal('c', 'horizontal-down', 2.8, [2, 2.5]),
      ],
      measurements: null,
    })
    expect(proposal.unknowns.join(' ')).toContain('covers only')
  })
})

describe('typed measurements are real metres', () => {
  const typed: ManualMeasurements = {
    units: 'm',
    room: { width: 4, length: 5, height: 2.8 },
    openings: [],
    notes: '',
    source: 'manual',
  }

  test('the node scale does not stretch a typed rectangle', () => {
    const proposal = proposeRoom({
      planes: null,
      measurements: typed,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 2 },
    })
    expect(sorted(proposal.polygon!)).toEqual([
      [0, 0],
      [0, 5],
      [4, 0],
      [4, 5],
    ])
  })

  test('a plane outline that disagrees with the typed size is surfaced', () => {
    const planes = [
      ...room([
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
      ]),
      ...roomFlats,
    ]
    const proposal = proposeRoom({ planes, measurements: typed })
    expect(proposal.unknowns.join(' ')).toContain('One of them is wrong')
    const agreeing = proposeRoom({ planes: [...rect45(), ...roomFlats], measurements: typed })
    expect(agreeing.unknowns.join(' ')).not.toContain('One of them is wrong')
  })

  test('a typed height fills a missing ceiling with one accurate unknown', () => {
    const proposal = proposeRoom({ planes: rect45(), measurements: typed })
    expect(proposal.height).toEqual({ value: 2.8, basis: 'manual-measurement' })
    expect(proposal.unknowns.join(' ')).toContain('typed-in measurement; no plane confirmed it')
    expect(proposal.unknowns.join(' ')).not.toContain('ceiling height is known')
  })

  test('a zero or negative node scale places nothing and says so', () => {
    for (const scale of [0, -1, Number.NaN]) {
      const proposal = proposeRoom({
        planes: rect45(),
        measurements: typed,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale },
      })
      expect(proposal.polygon).toBeNull()
      expect(proposal.unknowns[0]).toContain('scale')
    }
  })
})

describe('floor choice without wall planes, and the suggested scan transform', () => {
  // Shaped like a real handheld scan: no vertical planes, two large floors, a small lower one.
  const planes = () => [
    horizontal('big', 'horizontal-up', -1.27, [3, 4], [0, 0]),
    horizontal('second', 'horizontal-up', -1.26, [2.4, 3], [8, 0]),
    horizontal('lower', 'horizontal-up', -1.77, [2, 3], [-8, 0]),
    horizontal('ceil', 'horizontal-down', 2.95, [3, 3], [0, 0]),
  ]

  test('the largest upward plane is the floor, and a second large plane at another level is reported', () => {
    const analysis = analysePlanes(planes())
    expect(analysis.floor?.planeId).toBe('big')
    expect(analysis.height).toBeCloseTo(4.22, 1)
    expect(analysis.notes.join(' ')).toContain('lower')
    expect(analysis.notes.join(' ')).toContain('step or level change')
    expect(analysis.notes.join(' ')).not.toContain('second,')
  })

  test('the proposal suggests moving the scan node so the floor sits at level y 0, and writes nothing', () => {
    const proposal = proposeRoom({
      planes: planes(),
      measurements: {
        units: 'm',
        room: { width: 4, length: 3, height: null },
        openings: [],
        notes: '',
        source: 'manual',
      },
      transform: { position: [1, 0.5, 2], rotation: [0, 0.3, 0], scale: 1 },
    })
    expect(proposal.floorY).toBeCloseTo(-0.77, 2)
    expect(proposal.suggestedScanTransform).toMatchObject({
      position: [1, 1.27, 2],
      rotation: [0, 0.3, 0],
      scale: 1,
    })
    expect(proposal.suggestedScanTransform?.note).toContain('confirms')
  })

  test('no suggestion when the floor already sits at level y 0', () => {
    const proposal = proposeRoom({
      planes: [horizontal('floor', 'horizontal-up', 0, [3, 3], [0, 0])],
      measurements: null,
    })
    expect(proposal.suggestedScanTransform).toBeNull()
  })
})

describe('wall planes that cover only part of the wall height', () => {
  const corners: Array<[number, number]> = [
    [0, 0],
    [5, 0],
    [5, 4],
    [0, 4],
  ]
  const ceiling = horizontal('ceiling', 'horizontal-down', 2.6, [2.5, 2], [2.5, 2])
  const world: World = { walls: polygonWalls(corners), height: 2.6 }
  /** A trajectory is sampled many times a second, so stops are joined by points every 0.2 m. */
  const dense = (stops: Array<[number, number, number]>) =>
    stops.flatMap((from, index) => {
      const to = stops[(index + 1) % stops.length]!
      const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / 0.2))
      return Array.from({ length: steps }, (_, step): [number, number, number] => [
        from[0] + ((to[0] - from[0]) * step) / steps,
        from[1],
        from[2] + ((to[2] - from[2]) * step) / steps,
      ])
    })
  const extent = (polygon: readonly Vec2[], axis: 0 | 1) => {
    const values = polygon.map((point) => point[axis])
    return [Math.min(...values), Math.max(...values)]
  }

  test('a room whose walls are seen only up to 1 m is outlined from them, rated medium at most', () => {
    const proposal = proposeRoom({
      planes: [
        ...room(corners, [], 1),
        // The floor plane stops 0.1 m short of the walls.
        horizontal('floor', 'horizontal-up', 0, [2.4, 1.9], [2.5, 2]),
        ceiling,
      ],
      measurements: null,
    })
    expect(proposal.method).toBe('planes')
    expect(sorted(proposal.polygon!)).toEqual(sorted(corners))
    expect(proposal.height).toEqual({ value: 2.6, basis: 'plane-estimate' })
    expect(proposal.planesUsed.toSorted()).toEqual(['w0', 'w1', 'w2', 'w3'])
    expect(proposal.planesIgnored).toEqual([])
    for (const edge of proposal.edges) {
      expect(edge.basis).toBe('plane-estimate')
      expect(edge.confidence).toBe('medium')
      expect(edge.reason).toContain('the edge of the floor plane agrees')
    }
    expect(proposal.unknowns.join(' ')).toContain('only part of the wall height')
  })

  test('depth agrees with walls seen up to 1 m; a cabinet front against a wall does not move it inward', () => {
    // The cabinet is 0.6 m deep against wall z = 0. ARCore found a plane on its front and on the
    // lower wall beside it, and the floor plane ends at the cabinet front, so the floor edge agrees
    // with the cabinet; depth sees the wall above it.
    const scene: World = { ...world, boxes: [{ min: [1, 0], max: [2.6, 0.6], top: 0.9 }] }
    const { frames, path } = walk(scene, loop(0.9, 1.3, 4.1, 3.1))
    const proposal = proposeRoom({
      planes: [
        ...room(corners, [0], 1),
        panel('w0b', [3, 0], [4.95, 0], 0, 1),
        panel('cabinet', [1, 0.6], [2.6, 0.6], 0, 0.9),
        horizontal('floor', 'horizontal-up', 0, [2.4, 1.6], [2.5, 2.3]),
        ceiling,
      ],
      measurements: null,
      depthFrames: frames,
      walkedPath: dense(path),
    })
    const cabinet = proposal.planesIgnored.find((item) => item.planeId === 'cabinet')
    expect(cabinet?.reason).toContain('behind it')
    expect(cabinet?.reason).toContain('furniture')
    expect(proposal.planesUsed).not.toContain('cabinet')
    expect(proposal.polygon).toHaveLength(4)
    const [minZ, maxZ] = extent(proposal.polygon!, 1)
    const [minX, maxX] = extent(proposal.polygon!, 0)
    expect(Math.abs(minZ!)).toBeLessThan(0.15)
    expect(Math.abs(maxZ! - 4)).toBeLessThan(0.15)
    expect(Math.abs(minX!)).toBeLessThan(0.15)
    expect(Math.abs(maxX! - 5)).toBeLessThan(0.15)
    expect(proposal.edges.some((edge) => edge.confidence === 'high')).toBe(false)
    for (const id of ['w1', 'w2', 'w3']) {
      const edge = proposal.edges.find((item) => item.evidencePlaneIds.includes(id))
      expect(edge?.reason).toContain('the line fitted to depth points')
    }
  })

  test('a free-standing cabinet in the middle of the room is furniture', () => {
    const scene: World = { ...world, boxes: [{ min: [2, 1.8], max: [3.6, 2.4], top: 0.9 }] }
    const { frames, path } = walk(scene, loop(0.8, 0.8, 4.2, 3.2))
    const proposal = proposeRoom({
      planes: [
        ...room(corners, [], 1),
        panel('cabinet', [2, 1.8], [3.6, 1.8], 0, 0.9),
        horizontal('floor', 'horizontal-up', 0, [2.4, 1.9], [2.5, 2]),
        ceiling,
      ],
      measurements: null,
      depthFrames: frames,
      walkedPath: dense(path),
    })
    const cabinet = proposal.planesIgnored.find((item) => item.planeId === 'cabinet')
    expect(cabinet?.reason).toContain('walked-path points behind it')
    expect(cabinet?.reason).toContain('furniture')
    expect(proposal.planesUsed.toSorted()).toEqual(['w0', 'w1', 'w2', 'w3'])
    expect(sorted(proposal.polygon!)).toEqual(sorted(corners))
  })

  test('a bed side in front of a wall is furniture; lone wide planes outside the walked area are low', () => {
    // No other source agrees with the walls: the floor plane is a patch in the middle and there is no
    // depth. The walls are wide and outside the walked area, so they stand alone at low confidence;
    // the bed side would too, but the wall plane w0 stands 1.4 m behind it.
    const proposal = proposeRoom({
      planes: [
        ...room(corners, [], 1),
        panel('bed', [1, 1.4], [3, 1.4], 0, 0.55),
        panel('narrow', [5, 1], [5, 1.8], 0, 1),
        horizontal('floor', 'horizontal-up', 0, [1, 0.6], [2.5, 2.6]),
        ceiling,
      ],
      measurements: null,
      walkedPath: dense(
        loop(1.2, 1.9, 3.8, 3.2).map(([x, z]): [number, number, number] => [x, 1.4, z]),
      ),
    })
    const reason = (id: string) =>
      proposal.planesIgnored.find((item) => item.planeId === id)?.reason
    expect(reason('bed')).toContain('the vertical plane w0 1.4 m behind it')
    expect(reason('narrow')).toContain('too narrow to stand alone')
    expect(sorted(proposal.polygon!)).toEqual(sorted(corners))
    expect(proposal.edges.every((edge) => edge.confidence === 'low')).toBe(true)
    expect(proposal.edges[0]!.reason).toContain('outside the walked area')
  })
})
