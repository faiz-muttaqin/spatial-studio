import { describe, expect, test } from 'bun:test'
import {
  BoundaryMarkSchema,
  BoundaryMarksPayloadSchema,
  CAPTURE_MAX_BOUNDARY_MARKS,
} from './boundary-marks'

function pose(x: number, y: number, z: number) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
}

function basePoint(x: number, y: number, z: number, overrides: Record<string, unknown> = {}) {
  return {
    point: [x, y, z],
    pose: pose(x, y, z),
    planeId: 'plane-1',
    timestamp: 5_000,
    ...overrides,
  }
}

function mark(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mark-001',
    kind: 'glass',
    base: [basePoint(0, 0, 0), basePoint(3, 0.02, 0)],
    height: { metres: 2.6, source: 'ceiling-plane', ceilingPlaneId: 'plane-4' },
    source: 'manual-ar-marking',
    createdAt: 1_764_000_000_000,
    notes: null,
    ...overrides,
  }
}

describe('boundary-marks payload', () => {
  test('accepts marks of every kind and height source', () => {
    const payload = BoundaryMarksPayloadSchema.parse({
      marks: [
        mark(),
        mark({
          id: 'mark-002',
          kind: 'door',
          height: { metres: 2.1, source: 'typed', ceilingPlaneId: null },
        }),
        mark({
          id: 'mark-003',
          kind: 'wall',
          height: { metres: null, source: 'unknown', ceilingPlaneId: null },
          notes: 'north wall',
        }),
      ],
    })
    expect(payload.marks).toHaveLength(3)
  })

  test('accepts an empty list', () => {
    expect(BoundaryMarksPayloadSchema.parse({ marks: [] }).marks).toEqual([])
  })

  test('rejects an unknown kind or source', () => {
    expect(BoundaryMarkSchema.safeParse(mark({ kind: 'curtain' })).success).toBe(false)
    expect(BoundaryMarkSchema.safeParse(mark({ source: 'arcore' })).success).toBe(false)
  })

  test('rejects a point that disagrees with its pose', () => {
    const bad = mark({ base: [basePoint(0, 0, 0, { point: [0.5, 0, 0] }), basePoint(3, 0, 0)] })
    expect(BoundaryMarkSchema.safeParse(bad).success).toBe(false)
  })

  test('rejects non-finite coordinates and a short pose', () => {
    expect(
      BoundaryMarkSchema.safeParse(
        mark({ base: [basePoint(0, 0, 0), basePoint(Number.NaN, 0, 0)] }),
      ).success,
    ).toBe(false)
    expect(
      BoundaryMarkSchema.safeParse(
        mark({ base: [basePoint(0, 0, 0), basePoint(3, 0, 0, { pose: [1, 0] })] }),
      ).success,
    ).toBe(false)
  })

  test('bounds the base length and slope', () => {
    expect(
      BoundaryMarkSchema.safeParse(mark({ base: [basePoint(0, 0, 0), basePoint(0.01, 0, 0)] }))
        .success,
    ).toBe(false)
    expect(
      BoundaryMarkSchema.safeParse(mark({ base: [basePoint(0, 0, 0), basePoint(51, 0, 0)] }))
        .success,
    ).toBe(false)
    expect(
      BoundaryMarkSchema.safeParse(mark({ base: [basePoint(0, 0, 0), basePoint(3, 0.6, 0)] }))
        .success,
    ).toBe(false)
    expect(
      BoundaryMarkSchema.safeParse(mark({ base: [basePoint(0, 0, 0), basePoint(50, 0, 0)] }))
        .success,
    ).toBe(true)
  })

  test('keeps height, source and plane id consistent', () => {
    const typed = (metres: number | null, source: string, ceilingPlaneId: string | null) =>
      BoundaryMarkSchema.safeParse(mark({ height: { metres, source, ceilingPlaneId } })).success
    expect(typed(null, 'typed', null)).toBe(false)
    expect(typed(2.4, 'unknown', null)).toBe(false)
    expect(typed(2.4, 'typed', 'plane-4')).toBe(false)
    expect(typed(0.05, 'typed', null)).toBe(false)
    expect(typed(10.5, 'typed', null)).toBe(false)
    expect(typed(10, 'typed', null)).toBe(true)
  })

  test('bounds notes and requires unique ids', () => {
    expect(BoundaryMarkSchema.safeParse(mark({ notes: 'x'.repeat(501) })).success).toBe(false)
    expect(BoundaryMarksPayloadSchema.safeParse({ marks: [mark(), mark()] }).success).toBe(false)
  })

  test('bounds the number of marks', () => {
    const marks = Array.from({ length: CAPTURE_MAX_BOUNDARY_MARKS + 1 }, (_, i) =>
      mark({ id: `m-${i}` }),
    )
    expect(BoundaryMarksPayloadSchema.safeParse({ marks }).success).toBe(false)
    expect(BoundaryMarksPayloadSchema.safeParse({ marks: marks.slice(1) }).success).toBe(true)
  })
})
