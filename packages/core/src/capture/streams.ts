import { z } from 'zod'
import { PointCloudPayloadSchema } from './schema'
import { TrueNorthSchema } from './sensor-streams'

/**
 * Payloads of the scan-bundle streams in `docs/spatial-studio/CAPTURE_CONTRACT.md`.
 * Every provider (browser photos, WebXR, the Android companion) writes these
 * shapes, so readers never branch on the provider.
 */

export const CAPTURE_MAX_KEYFRAMES = 300
export const CAPTURE_MAX_IMAGE_LONG_EDGE = 1920
export const CAPTURE_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
export const CAPTURE_MAX_POINT_CLOUD_POINTS = 200_000

export const CaptureProviderIdSchema = z.enum(['browser-photo', 'webxr', 'android-arcore'])

/** Column-major camera-to-world matrix (Three.js `Matrix4.fromArray`, ARCore `Pose.toMatrix`). */
export const CaptureMatrix4Schema = z.array(z.number().finite()).length(16)

/** Pinhole intrinsics in pixels of the image they describe. */
export const CameraIntrinsicsSchema = z.object({
  fx: z.number().finite().positive(),
  fy: z.number().finite().positive(),
  cx: z.number().finite().nonnegative(),
  cy: z.number().finite().nonnegative(),
})

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a lowercase sha256 hex.')

export const CaptureArtifactPointerSchema = z.object({
  uri: z.string().min(1),
  sha256: Sha256HexSchema,
})

/** `none` is for providers that track nothing (browser photos). */
export const CaptureTrackingStateSchema = z.enum(['tracking', 'paused', 'stopped', 'none'])

export const RgbKeyframeSchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.number().finite().nonnegative(),
    image: CaptureArtifactPointerSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    intrinsics: CameraIntrinsicsSchema.nullable(),
    pose: CaptureMatrix4Schema.nullable(),
    trackingState: CaptureTrackingStateSchema,
    /** v1.3: whether the ARCore torch was on for this frame. Absent means unknown. */
    torch: z.boolean().optional(),
  })
  .superRefine((frame, context) => {
    if (Math.max(frame.width, frame.height) > CAPTURE_MAX_IMAGE_LONG_EDGE) {
      context.addIssue({
        code: 'custom',
        message: `Keyframe images must be at most ${CAPTURE_MAX_IMAGE_LONG_EDGE} px on the long edge.`,
        path: ['width'],
      })
    }
  })

export const RgbKeyframeIndexSchema = z
  .object({ frames: z.array(RgbKeyframeSchema).max(CAPTURE_MAX_KEYFRAMES) })
  .superRefine((index, context) => validateUniqueFrameIds(index.frames, context))

export const DepthKeyframeSchema = z.object({
  id: z.string().min(1),
  rgbKeyframeId: z.string().min(1),
  timestamp: z.number().finite().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  intrinsics: CameraIntrinsicsSchema,
  /** Raw uint16 little-endian millimetres, row-major, `width` x `height`. */
  depth: CaptureArtifactPointerSchema,
  /** Optional uint8 confidence, same layout. */
  confidence: CaptureArtifactPointerSchema.nullable(),
})

export const DepthKeyframeIndexSchema = z
  .object({ frames: z.array(DepthKeyframeSchema).max(CAPTURE_MAX_KEYFRAMES) })
  .superRefine((index, context) => validateUniqueFrameIds(index.frames, context))

/**
 * Depth frames naming an rgb keyframe the bundle does not have. The two
 * indexes are separate artifacts, so this check runs once both are read.
 */
export function missingRgbKeyframeReferences(
  depth: { frames: ReadonlyArray<{ rgbKeyframeId: string }> },
  rgb: { frames: ReadonlyArray<{ id: string }> },
): string[] {
  const known = new Set(rgb.frames.map((frame) => frame.id))
  return [...new Set(depth.frames.map((frame) => frame.rgbKeyframeId))].filter(
    (id) => !known.has(id),
  )
}

/**
 * A `point-cloud` stream written by a capture provider: the shared payload
 * plus the contract's downsampled bound. Older scenes keep the unbounded
 * `PointCloudPayloadSchema`.
 */
export const CapturePointCloudPayloadSchema = PointCloudPayloadSchema.refine(
  (payload) => payload.positions.length <= CAPTURE_MAX_POINT_CLOUD_POINTS * 3,
  {
    message: `Capture point clouds hold at most ${CAPTURE_MAX_POINT_CLOUD_POINTS} points after downsampling.`,
    path: ['positions'],
  },
)

const PlanePoint = z.tuple([z.number().finite(), z.number().finite()])

export const CapturePlaneSchema = z
  .object({
    id: z.string().min(1),
    orientation: z.enum(['horizontal-up', 'horizontal-down', 'vertical']),
    centerPose: CaptureMatrix4Schema,
    /** Plane-local extent in metres along X and Z. */
    extent: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]),
    /** Plane-local boundary in metres. */
    polygon: z.array(PlanePoint).min(3),
    subsumedBy: z.string().min(1).nullable(),
  })
  .refine((plane) => plane.subsumedBy !== plane.id, {
    message: 'A plane cannot be subsumed by itself.',
    path: ['subsumedBy'],
  })

export const CapturePlaneSetSchema = z
  .object({ planes: z.array(CapturePlaneSchema) })
  .superRefine((set, context) => validateUniqueFrameIds(set.planes, context, 'planes'))

const Metres = z.number().finite().positive()

export const ManualOpeningSchema = z.object({
  kind: z.enum(['door', 'window']),
  /** Free label of the wall the opening sits in, e.g. `north` or `A`. */
  wall: z.string().trim().min(1).max(64).nullable(),
  width: Metres.nullable(),
  height: Metres.nullable(),
  /** Height of the opening's bottom edge above the floor; 0 for most doors. */
  sill: z.number().finite().nonnegative().nullable(),
})

export const ManualMeasurementsSchema = z.object({
  units: z.literal('m'),
  room: z.object({
    width: Metres.nullable(),
    length: Metres.nullable(),
    height: Metres.nullable(),
  }),
  openings: z.array(ManualOpeningSchema).max(64),
  notes: z.string().max(2000),
  source: z.literal('manual'),
})

/**
 * Whether a feature is available. `unknown` is the honest answer for WebXR
 * features that are only negotiated when a session starts.
 */
export const CapabilitySupportSchema = z.enum(['supported', 'unsupported', 'unknown'])

export const SensorPermissionSchema = z.enum(['granted', 'denied', 'prompt', 'not-required'])

export const BrowserCapabilitiesSchema = z.object({
  secureContext: z.boolean(),
  /** Browser family and major version, e.g. `Chrome 140`; never the full user agent. */
  browser: z.string().max(64).nullable(),
  camera: z.object({
    mediaDevices: z.boolean(),
    /** Labels need a camera permission; the count does not. Null when enumeration failed. */
    videoInputs: z.number().int().nonnegative().nullable(),
  }),
  webxr: z.object({
    api: z.boolean(),
    immersiveAr: CapabilitySupportSchema,
    /** Optional features requested at session start (`hit-test`, `depth-sensing`, ...). */
    features: z.record(z.string(), CapabilitySupportSchema),
  }),
  orientation: z.object({
    api: z.boolean(),
    permission: SensorPermissionSchema,
  }),
  motion: z.object({
    api: z.boolean(),
    permission: SensorPermissionSchema,
  }),
})

/** Result of the Android bridge `capabilities.get`; extra fields are kept for later readers. */
export const NativeCapabilitiesSchema = z
  .object({
    arcore: z
      .object({
        availability: z.string().min(1),
        depth: z.boolean(),
        rawDepth: z.boolean(),
      })
      .loose(),
    cameras: z.array(
      z
        .object({
          id: z.string().min(1),
          facing: z.string().min(1),
          focalLengths: z.array(z.number().finite()),
          intrinsics: CameraIntrinsicsSchema.nullable(),
          depthOutput: z.boolean(),
          logicalMultiCamera: z.boolean(),
          physicalIds: z.array(z.string()),
        })
        .loose(),
    ),
    sensors: z.record(z.string(), z.unknown()),
    device: z
      .object({
        manufacturer: z.string(),
        model: z.string(),
        sdkInt: z.number().int(),
        webViewVersion: z.string().nullable(),
      })
      .loose(),
  })
  .loose()

export const DeviceCapabilitiesSchema = z
  .object({
    /** Unix milliseconds. */
    probedAt: z.number().finite().nonnegative(),
    browser: BrowserCapabilitiesSchema.nullable(),
    native: NativeCapabilitiesSchema.nullable(),
  })
  .refine((value) => value.browser !== null || value.native !== null, {
    message: 'A capability probe reports the browser, the native companion, or both.',
  })

/**
 * Camera-pose convention of a bundle's keyframe and trajectory poses. ARCore
 * poses use OpenGL camera axes (+X right, +Y up, -Z forward) relative to the
 * image readout, matching the stored, unrotated JPEG and its intrinsics.
 */
export const CapturePoseConventionSchema = z.object({
  convention: z.literal('opengl'),
  frame: z.literal('image-readout'),
  sensorOrientationDeg: z.number().int().nullable(),
})

/** Provider-specific extras (the companion's `arcore` block, for one) are kept, not stripped. */
export const ScanBundleMetadataSchema = z
  .object({
    provider: CaptureProviderIdSchema,
    appVersion: z.string().min(1),
    bridgeVersion: z.number().int().positive().optional(),
    device: z.object({
      manufacturer: z.string().nullable(),
      model: z.string().nullable(),
      os: z.string().nullable(),
    }),
    /** ISO 8601. */
    createdAt: z.iso.datetime({ offset: true }),
    trackingLossCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    /** Present when the bundle has poses. */
    camera: CapturePoseConventionSchema.optional(),
    /** Present when enough compass samples exist (contract v1.1). */
    trueNorth: TrueNorthSchema.optional(),
  })
  .loose()

export type CameraIntrinsics = z.infer<typeof CameraIntrinsicsSchema>
export type CaptureArtifactPointer = z.infer<typeof CaptureArtifactPointerSchema>
export type CapturePlane = z.infer<typeof CapturePlaneSchema>
export type CapturePlaneSet = z.infer<typeof CapturePlaneSetSchema>
export type CapturePoseConvention = z.infer<typeof CapturePoseConventionSchema>
export type CapturePointCloudPayload = z.infer<typeof CapturePointCloudPayloadSchema>
export type CaptureProviderId = z.infer<typeof CaptureProviderIdSchema>
export type CaptureTrackingState = z.infer<typeof CaptureTrackingStateSchema>
export type BrowserCapabilities = z.infer<typeof BrowserCapabilitiesSchema>
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>
export type DepthKeyframe = z.infer<typeof DepthKeyframeSchema>
export type DepthKeyframeIndex = z.infer<typeof DepthKeyframeIndexSchema>
export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>
export type ManualMeasurements = z.infer<typeof ManualMeasurementsSchema>
export type ManualOpening = z.infer<typeof ManualOpeningSchema>
export type NativeCapabilities = z.infer<typeof NativeCapabilitiesSchema>
export type RgbKeyframe = z.infer<typeof RgbKeyframeSchema>
export type RgbKeyframeIndex = z.infer<typeof RgbKeyframeIndexSchema>
export type ScanBundleMetadata = z.infer<typeof ScanBundleMetadataSchema>
export type SensorPermission = z.infer<typeof SensorPermissionSchema>

function validateUniqueFrameIds(
  values: Array<{ id: string }>,
  context: {
    addIssue(issue: { code: 'custom'; message: string; path: Array<number | string> }): void
  },
  path = 'frames',
): void {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate ${path} id: ${value.id}`,
        path: [path, index, 'id'],
      })
    }
    seen.add(value.id)
  })
}
