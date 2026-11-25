import { describe, expect, test } from 'bun:test'
import {
  BarometerPayloadSchema,
  CAPTURE_MAX_BAROMETER_SAMPLES,
  CAPTURE_MAX_GEOLOCATION_FIXES,
  DeviceOrientationPayloadSchema,
  GeolocationPayloadSchema,
  HeadingPayloadSchema,
  LightEstimatePayloadSchema,
  TrueNorthSchema,
} from './sensor-streams'
import { ScanBundleMetadataSchema } from './streams'

const half = Math.SQRT1_2

function orientation(overrides: Record<string, unknown> = {}) {
  return { timestamp: 1_000, q: [0, 0, half, half], headingAccuracyDeg: 12.5, ...overrides }
}

function heading(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: 2_000,
    azimuthMagneticDeg: 80,
    azimuthTrueDeg: 78,
    declinationDeg: -2,
    magnetometerAccuracy: 3,
    headingAccuracyDeg: null,
    worldBearingDeg: 300,
    ...overrides,
  }
}

describe('device-orientation payload', () => {
  test('accepts unit quaternions in time order', () => {
    const payload = DeviceOrientationPayloadSchema.parse({
      samples: [orientation(), orientation({ timestamp: 1_020, headingAccuracyDeg: null })],
    })
    expect(payload.samples).toHaveLength(2)
  })

  test('rejects non-unit quaternions, out-of-order and non-finite samples', () => {
    expect(
      DeviceOrientationPayloadSchema.safeParse({ samples: [orientation({ q: [0, 0, 1, 1] })] })
        .success,
    ).toBe(false)
    expect(
      DeviceOrientationPayloadSchema.safeParse({
        samples: [orientation({ timestamp: 2_000 }), orientation({ timestamp: 1_000 })],
      }).success,
    ).toBe(false)
    expect(
      DeviceOrientationPayloadSchema.safeParse({
        samples: [orientation({ q: [0, 0, Number.NaN, 1] })],
      }).success,
    ).toBe(false)
  })
})

describe('heading payload', () => {
  test('accepts true and magnetic-only samples', () => {
    const payload = HeadingPayloadSchema.parse({
      samples: [
        heading(),
        heading({ timestamp: 2_200, azimuthTrueDeg: null, declinationDeg: null }),
      ],
    })
    expect(payload.samples[1]?.azimuthTrueDeg).toBeNull()
  })

  test('requires true azimuth and declination together, bearings in [0, 360) and accuracy 0 to 3', () => {
    expect(
      HeadingPayloadSchema.safeParse({ samples: [heading({ declinationDeg: null })] }).success,
    ).toBe(false)
    expect(
      HeadingPayloadSchema.safeParse({ samples: [heading({ worldBearingDeg: 360 })] }).success,
    ).toBe(false)
    expect(
      HeadingPayloadSchema.safeParse({ samples: [heading({ magnetometerAccuracy: 4 })] }).success,
    ).toBe(false)
  })
})

describe('geolocation payload', () => {
  const fix = {
    timestamp: 1_764_000_000_000,
    latitude: 1.3521,
    longitude: 103.8198,
    altitudeM: null,
    accuracyM: 850,
    provider: 'network',
  }

  test('accepts a fix and rejects out-of-range coordinates or providers', () => {
    expect(GeolocationPayloadSchema.safeParse({ fixes: [fix] }).success).toBe(true)
    expect(GeolocationPayloadSchema.safeParse({ fixes: [{ ...fix, latitude: 91 }] }).success).toBe(
      false,
    )
    expect(
      GeolocationPayloadSchema.safeParse({ fixes: [{ ...fix, longitude: -181 }] }).success,
    ).toBe(false)
    expect(
      GeolocationPayloadSchema.safeParse({ fixes: [{ ...fix, provider: 'wifi' }] }).success,
    ).toBe(false)
    expect(GeolocationPayloadSchema.safeParse({ fixes: [{ ...fix, accuracyM: -1 }] }).success).toBe(
      false,
    )
  })

  test('is bounded', () => {
    const fixes = Array.from({ length: CAPTURE_MAX_GEOLOCATION_FIXES + 1 }, () => fix)
    expect(GeolocationPayloadSchema.safeParse({ fixes }).success).toBe(false)
  })
})

describe('light-estimate payload', () => {
  const valid = {
    keyframeId: 'kf-0001',
    timestamp: 5_000,
    mode: 'environmental-hdr',
    state: 'valid',
    pixelIntensity: 0.4,
    colorCorrection: [1, 0.98, 0.9, 1],
    mainLightDirection: [0, 1, 0],
    mainLightIntensity: [3.2, 3, 2.7],
  }

  test('accepts valid and invalid estimates', () => {
    const payload = LightEstimatePayloadSchema.parse({
      estimates: [
        valid,
        {
          keyframeId: 'kf-0002',
          timestamp: 6_000,
          mode: 'ambient-intensity',
          state: 'invalid',
          pixelIntensity: null,
          colorCorrection: null,
          mainLightDirection: null,
          mainLightIntensity: null,
        },
      ],
    })
    expect(payload.estimates).toHaveLength(2)
  })

  test('rejects values on an invalid estimate, non-unit directions and duplicate keyframes', () => {
    expect(
      LightEstimatePayloadSchema.safeParse({ estimates: [{ ...valid, state: 'invalid' }] }).success,
    ).toBe(false)
    expect(
      LightEstimatePayloadSchema.safeParse({
        estimates: [{ ...valid, mainLightDirection: [0, 2, 0] }],
      }).success,
    ).toBe(false)
    expect(LightEstimatePayloadSchema.safeParse({ estimates: [valid, valid] }).success).toBe(false)
  })
})

describe('barometer payload', () => {
  test('accepts plausible pressures and rejects others', () => {
    expect(
      BarometerPayloadSchema.safeParse({ samples: [{ timestamp: 1, hPa: 1008.2 }] }).success,
    ).toBe(true)
    expect(
      BarometerPayloadSchema.safeParse({ samples: [{ timestamp: 1, hPa: 1200 }] }).success,
    ).toBe(false)
    expect(BarometerPayloadSchema.safeParse({ samples: [{ timestamp: 1, hPa: 10 }] }).success).toBe(
      false,
    )
  })

  test('is bounded', () => {
    const samples = Array.from({ length: CAPTURE_MAX_BAROMETER_SAMPLES + 1 }, (_, index) => ({
      timestamp: index,
      hPa: 1000,
    }))
    expect(BarometerPayloadSchema.safeParse({ samples }).success).toBe(false)
  })
})

describe('true north', () => {
  const trueNorth = {
    worldYawDeg: -42.5,
    confidence: 0.7,
    method: 'compass-median-true',
    reference: 'true',
    spreadDeg: 6.2,
    sampleCount: 140,
    declinationDeg: 0.4,
    segmentsAgree: true,
  }

  test('accepts a true and a magnetic result', () => {
    expect(TrueNorthSchema.safeParse(trueNorth).success).toBe(true)
    expect(
      TrueNorthSchema.safeParse({
        ...trueNorth,
        method: 'compass-median-magnetic',
        reference: 'magnetic',
        declinationDeg: null,
      }).success,
    ).toBe(true)
  })

  test('rejects inconsistent method, reference and declination, and -180', () => {
    expect(TrueNorthSchema.safeParse({ ...trueNorth, declinationDeg: null }).success).toBe(false)
    expect(TrueNorthSchema.safeParse({ ...trueNorth, reference: 'magnetic' }).success).toBe(false)
    expect(TrueNorthSchema.safeParse({ ...trueNorth, worldYawDeg: -180 }).success).toBe(false)
    expect(TrueNorthSchema.safeParse({ ...trueNorth, confidence: 1.2 }).success).toBe(false)
  })

  test('is accepted on the manifest metadata and optional', () => {
    const base = {
      provider: 'android-arcore',
      appVersion: '0.1.0',
      device: { manufacturer: null, model: null, os: null },
      createdAt: '2026-11-25T10:00:00.000Z',
      trackingLossCount: 0,
      warnings: [],
    }
    expect(ScanBundleMetadataSchema.safeParse(base).success).toBe(true)
    expect(ScanBundleMetadataSchema.safeParse({ ...base, trueNorth }).success).toBe(true)
    expect(
      ScanBundleMetadataSchema.safeParse({ ...base, trueNorth: { ...trueNorth, confidence: 2 } })
        .success,
    ).toBe(false)
  })
})
