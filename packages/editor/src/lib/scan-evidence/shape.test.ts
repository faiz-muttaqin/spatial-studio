import { describe, expect, it } from 'bun:test'
import {
  type CapturePlaneSet,
  type CaptureSessionDescriptor,
  CaptureSessionDescriptorSchema,
  ManualMeasurementsSchema,
  RgbKeyframeIndexSchema,
} from '@pascal-app/core/capture'
import {
  findEvidenceStreams,
  KEYFRAME_PAGE_SIZE,
  selectKeyframePage,
  summarizeMeasurements,
  summarizePlanes,
  summarizeSession,
} from './shape'

const sha = 'a'.repeat(64)

function pose(y: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1]
}

function descriptor(metadata: Record<string, unknown> | undefined): CaptureSessionDescriptor {
  return CaptureSessionDescriptorSchema.parse({
    schemaVersion: 2,
    sessionId: 's1',
    state: 'ready',
    clocks: [],
    coordinateFrames: [{ id: 'world', convention: 'arcore-world' }],
    streams: [
      { id: 'photos', kind: 'rgb-keyframes', role: 'photos', availability: 'ready' },
      { id: 'planes', kind: 'plane-set', role: 'planes', availability: 'ready' },
      { id: 'meas', kind: 'manual-measurements', availability: 'pending' },
    ],
    metadata,
  })
}

describe('summarizeSession', () => {
  it('reads provider, device, time, convention, warnings and tracking loss', () => {
    const summary = summarizeSession(
      descriptor({
        provider: 'android-arcore',
        appVersion: '0.1.0',
        device: { manufacturer: 'Google', model: 'Pixel 8', os: 'Android 15' },
        createdAt: '2026-11-25T10:00:00+08:00',
        trackingLossCount: 2,
        warnings: ['depth unavailable'],
        camera: { convention: 'opengl', frame: 'image-readout', sensorOrientationDeg: 90 },
      }),
    )
    expect(summary).toMatchObject({
      cameraConvention: 'opengl, image-readout, 90°',
      capturedAt: '2026-11-25T10:00:00+08:00',
      coordinateFrame: 'arcore-world',
      device: 'Google Pixel 8',
      provider: 'android-arcore',
      trackingLossCount: 2,
      warnings: ['depth unavailable'],
    })
  })

  it('falls back to the OS family for browser providers and tolerates missing metadata', () => {
    const browser = summarizeSession(
      descriptor({
        provider: 'browser-photo',
        appVersion: '1',
        device: { manufacturer: null, model: null, os: 'Android' },
        createdAt: '2026-11-25T10:00:00Z',
        trackingLossCount: 0,
        warnings: [],
      }),
    )
    expect(browser.device).toBe('Android')
    expect(browser.cameraConvention).toBeNull()
    const none = summarizeSession(descriptor(undefined))
    expect(none).toMatchObject({
      device: null,
      provider: null,
      trackingLossCount: null,
      warnings: [],
    })
  })
})

describe('summarizePlanes', () => {
  const plane = (
    id: string,
    orientation: 'horizontal-up' | 'horizontal-down' | 'vertical',
    y: number,
    extent: [number, number],
    subsumedBy: string | null = null,
  ) => ({
    id,
    orientation,
    centerPose: pose(y),
    extent,
    polygon: [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as [number, number][],
    subsumedBy,
  })

  it('counts distinct planes by orientation and picks the largest floor and ceiling', () => {
    const set: CapturePlaneSet = {
      planes: [
        plane('f1', 'horizontal-up', -1.4, [2, 2]),
        plane('f2', 'horizontal-up', -1.38, [4, 3]),
        plane('f3', 'horizontal-up', -1.4, [1, 1], 'f2'),
        plane('c1', 'horizontal-down', 1.1, [3, 3]),
        plane('w1', 'vertical', 0, [3, 2]),
        plane('w2', 'vertical', 0, [3, 2]),
      ],
    }
    const summary = summarizePlanes(set)
    expect(summary).toMatchObject({
      distinct: 5,
      horizontalDown: 1,
      horizontalUp: 2,
      total: 6,
      vertical: 2,
      floorHeight: -1.38,
      ceilingHeight: 1.1,
    })
    expect(summary.clearHeight).toBeCloseTo(2.48)
  })

  it('has no heights without horizontal planes and no clear height when out of order', () => {
    expect(summarizePlanes({ planes: [] })).toMatchObject({
      ceilingHeight: null,
      clearHeight: null,
      floorHeight: null,
    })
    const inverted = summarizePlanes({
      planes: [plane('f', 'horizontal-up', 2, [1, 1]), plane('c', 'horizontal-down', 1, [1, 1])],
    })
    expect(inverted.clearHeight).toBeNull()
  })
})

describe('summarizeMeasurements', () => {
  it('keeps unknown values null and counts openings by kind', () => {
    const measurements = ManualMeasurementsSchema.parse({
      units: 'm',
      room: { width: 4, length: null, height: 2.7 },
      openings: [
        { kind: 'door', wall: 'A', width: 0.9, height: 2.1, sill: 0 },
        { kind: 'window', wall: null, width: null, height: null, sill: null },
        { kind: 'window', wall: 'B', width: 1, height: 1, sill: 0.9 },
      ],
      notes: '  corner is curved \n',
      source: 'manual',
    })
    expect(summarizeMeasurements(measurements)).toEqual({
      doors: 1,
      height: 2.7,
      length: null,
      notes: 'corner is curved',
      width: 4,
      windows: 2,
    })
  })
})

describe('selectKeyframePage', () => {
  const frames = Array.from({ length: 30 }, (_, index) => ({
    id: `k${index}`,
    timestamp: 100 - index,
    image: { uri: `/api/artifacts/${sha}`, sha256: sha },
    width: 640,
    height: 480,
    intrinsics: null,
    pose: null,
    trackingState: 'none' as const,
  }))
  const index = RgbKeyframeIndexSchema.parse({ frames })

  it('orders by time and bounds the page', () => {
    const first = selectKeyframePage(index, 0)
    expect(first.frames).toHaveLength(KEYFRAME_PAGE_SIZE)
    expect(first.frames[0]?.id).toBe('k29')
    expect(first).toMatchObject({ page: 0, pageCount: 3, total: 30 })
    expect(selectKeyframePage(index, 2).frames).toHaveLength(6)
  })

  it('clamps out-of-range pages and handles an empty index', () => {
    expect(selectKeyframePage(index, 99).page).toBe(2)
    expect(selectKeyframePage(index, -3).page).toBe(0)
    const empty = selectKeyframePage({ frames: [] }, 0)
    expect(empty).toMatchObject({ frames: [], page: 0, pageCount: 1, total: 0 })
  })
})

describe('findEvidenceStreams', () => {
  it('finds ready evidence streams by kind and ignores pending ones', () => {
    const found = findEvidenceStreams(descriptor(undefined))
    expect(found.keyframes?.id).toBe('photos')
    expect(found.planes?.id).toBe('planes')
    expect(found.measurements).toBeNull()
  })
})
