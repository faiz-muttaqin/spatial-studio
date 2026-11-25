import {
  type CapturePlaneSet,
  type CaptureSessionDescriptor,
  type CaptureStreamDescriptor,
  type ManualMeasurements,
  type RgbKeyframe,
  type RgbKeyframeIndex,
  ScanBundleMetadataSchema,
} from '@pascal-app/core/capture'

/** Thumbnails shown at a time; the strip pages through the index. */
export const KEYFRAME_PAGE_SIZE = 12

export type ScanSessionSummary = {
  provider: string | null
  device: string | null
  /** ISO 8601, as the bundle recorded it. */
  capturedAt: string | null
  /** For example `opengl, image-readout`; null when the bundle has no poses. */
  cameraConvention: string | null
  coordinateFrame: string | null
  warnings: string[]
  trackingLossCount: number | null
  state: CaptureSessionDescriptor['state']
}

export function summarizeSession(descriptor: CaptureSessionDescriptor): ScanSessionSummary {
  const metadata = ScanBundleMetadataSchema.safeParse(descriptor.metadata ?? {})
  const loose = (descriptor.metadata ?? {}) as Record<string, unknown>
  const parsed = metadata.success ? metadata.data : null
  const device = parsed
    ? [parsed.device.manufacturer, parsed.device.model].filter(Boolean).join(' ') ||
      parsed.device.os ||
      null
    : null
  const camera = parsed?.camera
  return {
    cameraConvention: camera
      ? `${camera.convention}, ${camera.frame}${
          camera.sensorOrientationDeg === null ? '' : `, ${camera.sensorOrientationDeg}°`
        }`
      : null,
    capturedAt: parsed?.createdAt ?? stringOrNull(loose.createdAt),
    coordinateFrame:
      descriptor.coordinateFrames.find((frame) => !frame.parentId)?.convention ?? null,
    device,
    provider: parsed?.provider ?? stringOrNull(loose.provider),
    state: descriptor.state,
    trackingLossCount: parsed?.trackingLossCount ?? null,
    warnings: parsed?.warnings ?? [],
  }
}

export type PlaneSummary = {
  total: number
  /** Planes ARCore merged into another are not counted again. */
  distinct: number
  horizontalUp: number
  horizontalDown: number
  vertical: number
  /** World-frame heights (metres, session Y) of the largest distinct upward and downward planes. */
  floorHeight: number | null
  ceilingHeight: number | null
  /** `ceilingHeight - floorHeight` when both exist and are in order. */
  clearHeight: number | null
}

export function summarizePlanes(set: CapturePlaneSet): PlaneSummary {
  const distinctPlanes = set.planes.filter((plane) => plane.subsumedBy === null)
  const count = (orientation: string) =>
    distinctPlanes.filter((plane) => plane.orientation === orientation).length
  const largest = (orientation: 'horizontal-up' | 'horizontal-down') => {
    let best: { area: number; y: number } | null = null
    for (const plane of distinctPlanes) {
      if (plane.orientation !== orientation) continue
      const area = plane.extent[0] * plane.extent[1]
      // Column-major pose: translation sits in elements 12 to 14.
      const y = plane.centerPose[13] ?? 0
      if (!best || area > best.area) best = { area, y }
    }
    return best?.y ?? null
  }
  const floorHeight = largest('horizontal-up')
  const ceilingHeight = largest('horizontal-down')
  const clear =
    floorHeight !== null && ceilingHeight !== null && ceilingHeight > floorHeight
      ? ceilingHeight - floorHeight
      : null
  return {
    ceilingHeight,
    clearHeight: clear,
    distinct: distinctPlanes.length,
    floorHeight,
    horizontalDown: count('horizontal-down'),
    horizontalUp: count('horizontal-up'),
    total: set.planes.length,
    vertical: count('vertical'),
  }
}

export type MeasurementSummary = {
  width: number | null
  length: number | null
  height: number | null
  doors: number
  windows: number
  notes: string
}

export function summarizeMeasurements(measurements: ManualMeasurements): MeasurementSummary {
  return {
    doors: measurements.openings.filter((opening) => opening.kind === 'door').length,
    height: measurements.room.height,
    length: measurements.room.length,
    notes: measurements.notes.trim(),
    width: measurements.room.width,
    windows: measurements.openings.filter((opening) => opening.kind === 'window').length,
  }
}

export type KeyframePage = {
  frames: RgbKeyframe[]
  page: number
  pageCount: number
  total: number
}

/** A bounded slice of the keyframe index, ordered by capture time. */
export function selectKeyframePage(
  index: RgbKeyframeIndex,
  page: number,
  pageSize = KEYFRAME_PAGE_SIZE,
): KeyframePage {
  const size = Math.max(1, Math.floor(pageSize))
  const sorted = [...index.frames].sort((a, b) => a.timestamp - b.timestamp)
  const pageCount = Math.max(1, Math.ceil(sorted.length / size))
  const current = Math.min(Math.max(0, Math.floor(page)), pageCount - 1)
  return {
    frames: sorted.slice(current * size, (current + 1) * size),
    page: current,
    pageCount,
    total: sorted.length,
  }
}

export type EvidenceStreams = {
  keyframes: CaptureStreamDescriptor | null
  measurements: CaptureStreamDescriptor | null
  planes: CaptureStreamDescriptor | null
}

export function findEvidenceStreams(descriptor: CaptureSessionDescriptor): EvidenceStreams {
  const ready = descriptor.streams.filter((stream) => stream.availability === 'ready')
  const byKind = (kind: string) => ready.find((stream) => stream.kind === kind) ?? null
  return {
    keyframes: byKind('rgb-keyframes'),
    measurements: byKind('manual-measurements'),
    planes: byKind('plane-set'),
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
