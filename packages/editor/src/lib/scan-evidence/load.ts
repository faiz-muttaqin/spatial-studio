import {
  CapturePlaneSetSchema,
  type CaptureSessionDescriptor,
  type CaptureSource,
  type CaptureStreamDescriptor,
  ManualMeasurementsSchema,
  type RgbKeyframeIndex,
  RgbKeyframeIndexSchema,
} from '@pascal-app/core/capture'
import {
  findEvidenceStreams,
  type MeasurementSummary,
  type PlaneSummary,
  type ScanSessionSummary,
  summarizeMeasurements,
  summarizePlanes,
  summarizeSession,
} from './shape'

export type EvidencePart = 'keyframes' | 'measurements' | 'planes'

export type ScanEvidence = {
  descriptor: CaptureSessionDescriptor
  keyframes: RgbKeyframeIndex | null
  measurements: MeasurementSummary | null
  /** Evidence streams the bundle has but that could not be read or failed their schema. */
  problems: EvidencePart[]
  planes: PlaneSummary | null
  session: ScanSessionSummary
}

export type FetchJson = (url: string, signal?: AbortSignal) => Promise<unknown>

export const fetchJsonSameOrigin: FetchJson = async (url, signal) => {
  const response = await fetch(url, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`Could not load ${url}.`)
  return response.json()
}

/**
 * Reads the manifest and the small JSON evidence streams of one scan. A stream that is missing is
 * simply absent; one that cannot be read or fails its schema is reported in `problems` so the panel
 * can say so, and the others still show.
 */
export async function loadScanEvidence(
  source: CaptureSource,
  { fetchJson = fetchJsonSameOrigin, signal }: { fetchJson?: FetchJson; signal?: AbortSignal } = {},
): Promise<ScanEvidence> {
  const descriptor = await source.describe(signal)
  const streams = findEvidenceStreams(descriptor)
  const problems: EvidencePart[] = []

  const read = async (part: EvidencePart, stream: CaptureStreamDescriptor | null) => {
    if (!stream) return null
    try {
      if (stream.inline != null) return stream.inline
      if (!(stream.artifact && source.resolveArtifact)) throw new Error('No artifact.')
      const { url, dispose } = await source.resolveArtifact(stream.artifact, signal)
      try {
        return await fetchJson(url, signal)
      } finally {
        dispose?.()
      }
    } catch (cause) {
      if (signal?.aborted) throw cause
      problems.push(part)
      return null
    }
  }

  const [rawPlanes, rawMeasurements, rawKeyframes] = await Promise.all([
    read('planes', streams.planes),
    read('measurements', streams.measurements),
    read('keyframes', streams.keyframes),
  ])

  const parse = <T>(
    part: EvidencePart,
    raw: unknown,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): T | null => {
    if (raw == null) return null
    const result = schema.safeParse(raw)
    if (result.success) return result.data
    if (!problems.includes(part)) problems.push(part)
    return null
  }

  const planes = parse('planes', rawPlanes, CapturePlaneSetSchema)
  const measurements = parse('measurements', rawMeasurements, ManualMeasurementsSchema)
  const keyframes = parse('keyframes', rawKeyframes, RgbKeyframeIndexSchema)

  return {
    descriptor,
    keyframes,
    measurements: measurements ? summarizeMeasurements(measurements) : null,
    planes: planes ? summarizePlanes(planes) : null,
    problems,
    session: summarizeSession(descriptor),
  }
}
