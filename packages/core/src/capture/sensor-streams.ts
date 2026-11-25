import { z } from 'zod'

/**
 * Payloads of the v1.1 sensor streams in `docs/spatial-studio/CAPTURE_CONTRACT.md`
 * ("Sensor streams (v1.1)"). Providers write these shapes; readers never
 * branch on the provider. Bounds match the contract.
 */

export const CAPTURE_MAX_ORIENTATION_SAMPLES = 36_000
export const CAPTURE_MAX_HEADING_SAMPLES = 6_000
export const CAPTURE_MAX_GEOLOCATION_FIXES = 60
export const CAPTURE_MAX_BAROMETER_SAMPLES = 4_000
export const CAPTURE_MIN_PRESSURE_HPA = 300
export const CAPTURE_MAX_PRESSURE_HPA = 1100

const QUATERNION_NORM_TOLERANCE = 0.01

const finite = z.number().finite()
const deviceTimestamp = finite.nonnegative()
/** Degrees in [0, 360). */
const bearingDeg = finite.min(0).lt(360)

type RefinementContext = {
  addIssue(issue: { code: 'custom'; message: string; path: Array<number | string> }): void
}

function requireNondecreasing(
  values: Array<{ timestamp: number }>,
  context: RefinementContext,
  path: string,
) {
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index]
    const previous = values[index - 1]
    if (current && previous && current.timestamp < previous.timestamp) {
      context.addIssue({
        code: 'custom',
        message: 'Samples must be in time order.',
        path: [path, index, 'timestamp'],
      })
      return
    }
  }
}

/** Unit quaternion `[x, y, z, w]` rotating device axes into the Android east-north-up frame. */
export const OrientationQuaternionSchema = z
  .tuple([finite, finite, finite, finite])
  .refine(
    ([x, y, z, w]) => Math.abs(Math.hypot(x, y, z, w) - 1) <= QUATERNION_NORM_TOLERANCE,
    'Expected a unit quaternion.',
  )

export const DeviceOrientationSampleSchema = z.object({
  /** Device clock, nanoseconds. */
  timestamp: deviceTimestamp,
  q: OrientationQuaternionSchema,
  /** Estimated heading accuracy in degrees, or null when the sensor reports none. */
  headingAccuracyDeg: finite.nonnegative().nullable(),
})

export const DeviceOrientationPayloadSchema = z
  .object({ samples: z.array(DeviceOrientationSampleSchema).max(CAPTURE_MAX_ORIENTATION_SAMPLES) })
  .superRefine((payload, context) => requireNondecreasing(payload.samples, context, 'samples'))

/** Android accuracy status: 0 unreliable, 1 low, 2 medium, 3 high. */
export const MagnetometerAccuracySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
])

export const HeadingSampleSchema = z
  .object({
    /** Device clock, nanoseconds. */
    timestamp: deviceTimestamp,
    azimuthMagneticDeg: bearingDeg,
    azimuthTrueDeg: bearingDeg.nullable(),
    declinationDeg: finite.min(-180).max(180).nullable(),
    magnetometerAccuracy: MagnetometerAccuracySchema,
    headingAccuracyDeg: finite.nonnegative().nullable(),
    /** Bearing of the same direction in the world frame, clockwise from world -Z seen from above. */
    worldBearingDeg: bearingDeg,
  })
  .refine((sample) => (sample.azimuthTrueDeg === null) === (sample.declinationDeg === null), {
    message: 'azimuthTrueDeg and declinationDeg are both present or both null.',
    path: ['azimuthTrueDeg'],
  })

export const HeadingPayloadSchema = z
  .object({ samples: z.array(HeadingSampleSchema).max(CAPTURE_MAX_HEADING_SAMPLES) })
  .superRefine((payload, context) => requireNondecreasing(payload.samples, context, 'samples'))

export const GeolocationProviderSchema = z.enum(['gps', 'network', 'fused', 'passive', 'unknown'])

export const GeolocationFixSchema = z.object({
  /** Wall clock, Unix milliseconds. */
  timestamp: finite.nonnegative(),
  latitude: finite.min(-90).max(90),
  longitude: finite.min(-180).max(180),
  altitudeM: finite.nullable(),
  accuracyM: finite.nonnegative(),
  provider: GeolocationProviderSchema,
})

export const GeolocationPayloadSchema = z
  .object({ fixes: z.array(GeolocationFixSchema).max(CAPTURE_MAX_GEOLOCATION_FIXES) })
  .superRefine((payload, context) => requireNondecreasing(payload.fixes, context, 'fixes'))

const UnitIntervalSchema = finite.min(0).max(1)

export const LightEstimateSchema = z
  .object({
    keyframeId: z.string().min(1),
    /** Device clock, nanoseconds; equal to the keyframe's timestamp. */
    timestamp: deviceTimestamp,
    mode: z.enum(['ambient-intensity', 'environmental-hdr']),
    state: z.enum(['valid', 'invalid']),
    pixelIntensity: UnitIntervalSchema.nullable(),
    /** `[r, g, b, gamma]`. */
    colorCorrection: z.tuple([finite, finite, finite, finite]).nullable(),
    /** Unit vector in the world frame, ARCore sign convention. Environmental HDR only. */
    mainLightDirection: z
      .tuple([finite, finite, finite])
      .refine(
        ([x, y, z]) => Math.abs(Math.hypot(x, y, z) - 1) <= QUATERNION_NORM_TOLERANCE,
        'Expected a unit vector.',
      )
      .nullable(),
    /** Linear `[r, g, b]` radiance. Environmental HDR only. */
    mainLightIntensity: z
      .tuple([finite.nonnegative(), finite.nonnegative(), finite.nonnegative()])
      .nullable(),
  })
  .refine(
    (estimate) =>
      estimate.state === 'valid' ||
      (estimate.pixelIntensity === null &&
        estimate.colorCorrection === null &&
        estimate.mainLightDirection === null &&
        estimate.mainLightIntensity === null),
    { message: 'An invalid estimate carries no values.', path: ['state'] },
  )

export const LightEstimatePayloadSchema = z
  .object({ estimates: z.array(LightEstimateSchema).max(300) })
  .superRefine((payload, context) => {
    const seen = new Set<string>()
    payload.estimates.forEach((estimate, index) => {
      if (seen.has(estimate.keyframeId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate keyframeId: ${estimate.keyframeId}`,
          path: ['estimates', index, 'keyframeId'],
        })
      }
      seen.add(estimate.keyframeId)
    })
  })

export const BarometerSampleSchema = z.object({
  /** Device clock, nanoseconds. */
  timestamp: deviceTimestamp,
  hPa: finite.min(CAPTURE_MIN_PRESSURE_HPA).max(CAPTURE_MAX_PRESSURE_HPA),
})

export const BarometerPayloadSchema = z
  .object({ samples: z.array(BarometerSampleSchema).max(CAPTURE_MAX_BAROMETER_SAMPLES) })
  .superRefine((payload, context) => requireNondecreasing(payload.samples, context, 'samples'))

/**
 * `metadata.trueNorth`: bearing of north in the ARCore world, clockwise from
 * world -Z seen from above. `reference: "magnetic"` means no declination was
 * available and the value points to magnetic north.
 */
export const TrueNorthSchema = z
  .object({
    /** In (-180, 180]. */
    worldYawDeg: finite.gt(-180).max(180),
    confidence: UnitIntervalSchema,
    method: z.enum(['compass-median-true', 'compass-median-magnetic']),
    reference: z.enum(['true', 'magnetic']),
    spreadDeg: finite.nonnegative(),
    sampleCount: z.number().int().positive(),
    declinationDeg: finite.min(-180).max(180).nullable(),
    /** False when separate tracking segments disagree on the offset; confidence is then capped. */
    segmentsAgree: z.boolean(),
  })
  .refine(
    (north) =>
      north.reference === 'true'
        ? north.method === 'compass-median-true' && north.declinationDeg !== null
        : north.method === 'compass-median-magnetic' && north.declinationDeg === null,
    { message: 'method, reference and declinationDeg must agree.', path: ['reference'] },
  )

export type DeviceOrientationSample = z.infer<typeof DeviceOrientationSampleSchema>
export type DeviceOrientationPayload = z.infer<typeof DeviceOrientationPayloadSchema>
export type HeadingSample = z.infer<typeof HeadingSampleSchema>
export type HeadingPayload = z.infer<typeof HeadingPayloadSchema>
export type GeolocationFix = z.infer<typeof GeolocationFixSchema>
export type GeolocationPayload = z.infer<typeof GeolocationPayloadSchema>
export type LightEstimate = z.infer<typeof LightEstimateSchema>
export type LightEstimatePayload = z.infer<typeof LightEstimatePayloadSchema>
export type BarometerSample = z.infer<typeof BarometerSampleSchema>
export type BarometerPayload = z.infer<typeof BarometerPayloadSchema>
export type TrueNorth = z.infer<typeof TrueNorthSchema>
