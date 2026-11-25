import { describe, expect, test } from 'bun:test'
import { analysePlanes } from './plane-analysis'
import { proposeRoom } from './room-proposal'
import type { CapturePlane, ManualMeasurements } from './streams'

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

/** Corners walked in order become walls, with ARCore-like slack: ends fall 5 cm short. */
function room(corners: Array<[number, number]>, skip: number[] = []): CapturePlane[] {
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
    planes.push(wall(`w${index}`, lerp(trim), lerp(1 - trim)))
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
    expect(proposal.unknowns.join(' ')).toContain('Planes gave no outline')
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
