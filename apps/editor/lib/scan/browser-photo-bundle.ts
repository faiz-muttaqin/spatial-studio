import {
  type CaptureSessionManifestV2,
  CaptureSessionManifestV2Schema,
  type DeviceCapabilities,
  DeviceCapabilitiesSchema,
  type ManualMeasurements,
  ManualMeasurementsSchema,
  RgbKeyframeIndexSchema,
  type ScanBundleMetadata,
  ScanBundleMetadataSchema,
} from '@pascal-app/core/capture'
import { artifactUri, type PreparedArtifact, prepareArtifact } from './artifacts'

export type BrowserPhoto = {
  id: string
  /** Unix milliseconds. */
  timestamp: number
  width: number
  height: number
  image: PreparedArtifact
}

export type BrowserPhotoBundleInput = {
  sessionId: string
  projectId?: string
  appVersion: string
  createdAt: Date
  device: ScanBundleMetadata['device']
  photos: readonly BrowserPhoto[]
  measurements: ManualMeasurements
  capabilities: DeviceCapabilities
}

export type PreparedBundle = {
  manifest: CaptureSessionManifestV2
  /** Photos, keyframe index and measurements; upload these before the manifest. */
  artifacts: PreparedArtifact[]
  manifestArtifact: PreparedArtifact
  manifestUrl: string
}

/**
 * Builds the `browser-photo` scan bundle of the capture contract: photos with
 * no pose or intrinsics, manual measurements and the capability probe. Every
 * payload is validated against the core schemas before it is hashed.
 */
export async function buildBrowserPhotoBundle(
  input: BrowserPhotoBundleInput,
): Promise<PreparedBundle> {
  const index = RgbKeyframeIndexSchema.parse({
    frames: input.photos.map((photo) => ({
      id: photo.id,
      timestamp: photo.timestamp,
      image: { uri: artifactUri(photo.image.sha256), sha256: photo.image.sha256 },
      width: photo.width,
      height: photo.height,
      intrinsics: null,
      pose: null,
      trackingState: 'none',
    })),
  })
  const measurements = ManualMeasurementsSchema.parse(input.measurements)
  const capabilities = DeviceCapabilitiesSchema.parse(input.capabilities)

  const indexArtifact = await prepareArtifact(JSON.stringify(index), 'application/json')
  const measurementsArtifact = await prepareArtifact(
    JSON.stringify(measurements),
    'application/json',
  )

  const warnings = ['no-pose', 'no-intrinsics']
  const room = measurements.room
  if (room.width === null || room.length === null || room.height === null) {
    warnings.push('room-dimensions-incomplete')
  }
  const metadata = ScanBundleMetadataSchema.parse({
    provider: 'browser-photo',
    appVersion: input.appVersion,
    device: input.device,
    createdAt: input.createdAt.toISOString(),
    trackingLossCount: 0,
    warnings,
  })

  const manifest = CaptureSessionManifestV2Schema.parse({
    schemaVersion: 2,
    sessionId: input.sessionId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    state: 'ready',
    clocks: [{ id: 'wall', timebase: 'milliseconds', epoch: 'unix' }],
    // Browser photos have no world frame.
    coordinateFrames: [],
    streams: [
      {
        id: 'photos',
        kind: 'rgb-keyframes',
        role: 'photos',
        availability: 'ready',
        clockId: 'wall',
        artifact: artifactReference(input.sessionId, 'photos', indexArtifact),
        metadata: { frameCount: index.frames.length },
      },
      {
        id: 'measurements',
        kind: 'manual-measurements',
        role: 'measurements',
        availability: 'ready',
        artifact: artifactReference(input.sessionId, 'measurements', measurementsArtifact),
      },
      {
        id: 'capabilities',
        kind: 'device-capabilities',
        role: 'capabilities',
        availability: 'ready',
        inline: capabilities,
      },
    ],
    metadata,
  })

  const manifestArtifact = await prepareArtifact(JSON.stringify(manifest), 'application/json')
  return {
    manifest,
    artifacts: [...input.photos.map((photo) => photo.image), indexArtifact, measurementsArtifact],
    manifestArtifact,
    manifestUrl: artifactUri(manifestArtifact.sha256),
  }
}

function artifactReference(sessionId: string, streamId: string, artifact: PreparedArtifact) {
  return {
    id: `${sessionId}:${streamId}`,
    uri: artifactUri(artifact.sha256),
    mediaType: artifact.mediaType,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  }
}
