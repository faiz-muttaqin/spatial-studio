import { describe, expect, test } from 'bun:test'
import { CaptureSessionManifestV2Schema, PointCloudPayloadSchema } from './schema'
import {
  CAPTURE_MAX_POINT_CLOUD_POINTS,
  CapturePlaneSetSchema,
  CapturePointCloudPayloadSchema,
  DepthKeyframeIndexSchema,
  DeviceCapabilitiesSchema,
  ManualMeasurementsSchema,
  missingRgbKeyframeReferences,
  NativeCapabilitiesSchema,
  RgbKeyframeIndexSchema,
  ScanBundleMetadataSchema,
} from './streams'

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)

function photoFrame(overrides: Record<string, unknown> = {}) {
  return {
    id: 'frame-1',
    timestamp: 1_764_000_000_000,
    image: { uri: `/api/artifacts/${hashA}`, sha256: hashA },
    width: 1920,
    height: 1440,
    intrinsics: null,
    pose: null,
    trackingState: 'none',
    ...overrides,
  }
}

describe('rgb keyframe index', () => {
  test('accepts browser photos without pose or intrinsics', () => {
    const index = RgbKeyframeIndexSchema.parse({ frames: [photoFrame()] })
    expect(index.frames[0]?.pose).toBeNull()
    expect(index.frames[0]?.intrinsics).toBeNull()
  })

  test('accepts tracked ARCore keyframes', () => {
    const index = RgbKeyframeIndexSchema.parse({
      frames: [
        photoFrame({
          intrinsics: { fx: 1400, fy: 1400, cx: 960, cy: 720 },
          pose: identity,
          trackingState: 'tracking',
        }),
      ],
    })
    expect(index.frames[0]?.pose).toHaveLength(16)
  })

  test('accepts the v1.3 torch flag and rejects a non-boolean one', () => {
    const tracked = { pose: identity, trackingState: 'tracking' as const }
    const parsed = RgbKeyframeIndexSchema.parse({
      frames: [
        photoFrame({ ...tracked, torch: true }),
        photoFrame({ ...tracked, id: 'b', torch: false }),
      ],
    })
    expect(parsed.frames.map((frame) => frame.torch)).toEqual([true, false])
    expect(
      RgbKeyframeIndexSchema.parse({ frames: [photoFrame()] }).frames[0]?.torch,
    ).toBeUndefined()
    expect(
      RgbKeyframeIndexSchema.safeParse({ frames: [photoFrame({ torch: 'on' })] }).success,
    ).toBe(false)
  })

  test('rejects images over the long-edge bound, bad hashes and duplicate ids', () => {
    expect(
      RgbKeyframeIndexSchema.safeParse({ frames: [photoFrame({ width: 4032 })] }).success,
    ).toBe(false)
    expect(
      RgbKeyframeIndexSchema.safeParse({
        frames: [photoFrame({ image: { uri: '/x', sha256: 'ABC' } })],
      }).success,
    ).toBe(false)
    expect(RgbKeyframeIndexSchema.safeParse({ frames: [photoFrame(), photoFrame()] }).success).toBe(
      false,
    )
  })

  test('rejects more than 300 keyframes and malformed poses', () => {
    const frames = Array.from({ length: 301 }, (_, index) => photoFrame({ id: `frame-${index}` }))
    expect(RgbKeyframeIndexSchema.safeParse({ frames }).success).toBe(false)
    expect(
      RgbKeyframeIndexSchema.safeParse({ frames: [photoFrame({ pose: [1, 0, 0] })] }).success,
    ).toBe(false)
    expect(
      RgbKeyframeIndexSchema.safeParse({ frames: [photoFrame({ trackingState: 'lost' })] }).success,
    ).toBe(false)
  })
})

describe('depth keyframe index', () => {
  test('ties each depth frame to an rgb keyframe', () => {
    const index = DepthKeyframeIndexSchema.parse({
      frames: [
        {
          id: 'depth-1',
          rgbKeyframeId: 'frame-1',
          timestamp: 1,
          width: 160,
          height: 90,
          intrinsics: { fx: 120, fy: 120, cx: 80, cy: 45 },
          depth: { uri: `/api/artifacts/${hashA}`, sha256: hashA },
          confidence: { uri: `/api/artifacts/${hashB}`, sha256: hashB },
        },
      ],
    })
    expect(index.frames[0]?.rgbKeyframeId).toBe('frame-1')
  })

  test('requires depth intrinsics', () => {
    expect(
      DepthKeyframeIndexSchema.safeParse({
        frames: [
          {
            id: 'depth-1',
            rgbKeyframeId: 'frame-1',
            timestamp: 1,
            width: 160,
            height: 90,
            intrinsics: null,
            depth: { uri: '/x', sha256: hashA },
            confidence: null,
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('depth references and point clouds', () => {
  test('lists depth frames whose rgb keyframe is missing', () => {
    expect(
      missingRgbKeyframeReferences(
        {
          frames: [
            { rgbKeyframeId: 'frame-1' },
            { rgbKeyframeId: 'frame-9' },
            { rgbKeyframeId: 'frame-9' },
          ],
        },
        { frames: [{ id: 'frame-1' }] },
      ),
    ).toEqual(['frame-9'])
  })

  test('bounds capture point clouds at 200,000 points without touching the shared schema', () => {
    const at = {
      coordinateSystem: 'arcore-world',
      positions: new Array(CAPTURE_MAX_POINT_CLOUD_POINTS * 3).fill(0),
    }
    const over = { ...at, positions: [...at.positions, 0, 0, 0] }
    expect(CapturePointCloudPayloadSchema.safeParse(at).success).toBe(true)
    expect(CapturePointCloudPayloadSchema.safeParse(over).success).toBe(false)
    expect(PointCloudPayloadSchema.safeParse(over).success).toBe(true)
  })
})

describe('plane set', () => {
  const wall = {
    id: 'plane-1',
    orientation: 'vertical',
    centerPose: identity,
    extent: [3.2, 2.4],
    polygon: [
      [-1.6, -1.2],
      [1.6, -1.2],
      [1.6, 1.2],
    ],
    subsumedBy: null,
  }

  test('accepts ARCore planes', () => {
    expect(CapturePlaneSetSchema.parse({ planes: [wall] }).planes).toHaveLength(1)
  })

  test('rejects degenerate polygons, self-subsumption and duplicate ids', () => {
    expect(
      CapturePlaneSetSchema.safeParse({ planes: [{ ...wall, polygon: [[0, 0]] }] }).success,
    ).toBe(false)
    expect(
      CapturePlaneSetSchema.safeParse({ planes: [{ ...wall, subsumedBy: 'plane-1' }] }).success,
    ).toBe(false)
    expect(CapturePlaneSetSchema.safeParse({ planes: [wall, wall] }).success).toBe(false)
  })
})

describe('manual measurements', () => {
  test('keeps unknown dimensions null instead of guessing', () => {
    const measurements = ManualMeasurementsSchema.parse({
      units: 'm',
      room: { width: 3.6, length: null, height: 2.7 },
      openings: [{ kind: 'door', wall: 'north', width: 0.9, height: 2.1, sill: 0 }],
      notes: '',
      source: 'manual',
    })
    expect(measurements.room.length).toBeNull()
  })

  test('rejects non-positive dimensions, other units and other sources', () => {
    const base = {
      units: 'm',
      room: { width: 3, length: 4, height: 2.5 },
      openings: [],
      notes: '',
      source: 'manual',
    }
    expect(
      ManualMeasurementsSchema.safeParse({ ...base, room: { ...base.room, width: 0 } }).success,
    ).toBe(false)
    expect(ManualMeasurementsSchema.safeParse({ ...base, units: 'ft' }).success).toBe(false)
    expect(ManualMeasurementsSchema.safeParse({ ...base, source: 'arcore' }).success).toBe(false)
  })
})

describe('device capabilities', () => {
  const browser = {
    secureContext: true,
    browser: 'Chrome 140',
    camera: { mediaDevices: true, videoInputs: null },
    webxr: { api: true, immersiveAr: 'supported', features: { 'depth-sensing': 'unknown' } },
    orientation: { api: true, permission: 'not-required' },
    motion: { api: true, permission: 'prompt' },
  }
  const native = {
    arcore: { availability: 'SUPPORTED_INSTALLED', depth: true, rawDepth: false },
    cameras: [
      {
        id: '0',
        facing: 'back',
        focalLengths: [4.38],
        intrinsics: { fx: 3000, fy: 3000, cx: 2000, cy: 1500 },
        depthOutput: false,
        logicalMultiCamera: true,
        physicalIds: ['2', '3'],
        extraVendorField: 1,
      },
    ],
    sensors: { accelerometer: true, gyroscope: true },
    device: { manufacturer: 'Test', model: 'Synthetic', sdkInt: 35, webViewVersion: '140.0' },
  }

  test('accepts a browser-only probe and keeps unknown native fields', () => {
    expect(DeviceCapabilitiesSchema.parse({ probedAt: 1, browser, native: null }).browser).toEqual(
      browser as never,
    )
    const parsed = NativeCapabilitiesSchema.parse(native)
    expect((parsed.cameras[0] as Record<string, unknown>).extraVendorField).toBe(1)
  })

  test('rejects an empty probe', () => {
    expect(
      DeviceCapabilitiesSchema.safeParse({ probedAt: 1, browser: null, native: null }).success,
    ).toBe(false)
  })
})

describe('scan bundle metadata', () => {
  test('fits a browser-photo manifest', () => {
    const metadata = ScanBundleMetadataSchema.parse({
      provider: 'browser-photo',
      appVersion: '0.1.0',
      device: { manufacturer: null, model: null, os: 'Android' },
      createdAt: '2026-11-25T08:00:00.000Z',
      trackingLossCount: 0,
      warnings: ['no-pose'],
    })
    const manifest = CaptureSessionManifestV2Schema.parse({
      schemaVersion: 2,
      sessionId: 'scan_test',
      clocks: [{ id: 'wall', timebase: 'milliseconds', epoch: 'unix' }],
      streams: [
        {
          id: 'photos',
          kind: 'rgb-keyframes',
          role: 'photos',
          clockId: 'wall',
          artifact: {
            id: 'scan_test:photos',
            uri: `/api/artifacts/${hashA}`,
            mediaType: 'application/json',
            byteLength: 10,
            sha256: hashA,
          },
        },
      ],
      metadata,
    })
    expect(manifest.metadata?.provider).toBe('browser-photo')
  })

  test('keeps the companion pose convention and its provider extras', () => {
    const metadata = ScanBundleMetadataSchema.parse({
      provider: 'android-arcore',
      appVersion: '0.1.0',
      bridgeVersion: 1,
      device: { manufacturer: 'Test', model: 'Synthetic', os: 'Android 16' },
      createdAt: '2026-11-25T08:00:00.000Z',
      trackingLossCount: 1,
      warnings: [],
      camera: { convention: 'opengl', frame: 'image-readout', sensorOrientationDeg: 90 },
      arcore: { version: '1.57.0' },
    })
    expect(metadata.camera?.sensorOrientationDeg).toBe(90)
    expect((metadata as Record<string, unknown>).arcore).toEqual({ version: '1.57.0' })
    expect(
      ScanBundleMetadataSchema.safeParse({
        ...metadata,
        camera: { convention: 'cv', frame: 'image-readout', sensorOrientationDeg: 0 },
      }).success,
    ).toBe(false)
  })

  test('rejects unknown providers', () => {
    expect(
      ScanBundleMetadataSchema.safeParse({
        provider: 'magic',
        appVersion: '0.1.0',
        device: { manufacturer: null, model: null, os: null },
        createdAt: '2026-11-25T08:00:00.000Z',
        trackingLossCount: 0,
        warnings: [],
      }).success,
    ).toBe(false)
  })
})
