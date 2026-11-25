import { describe, expect, it } from 'bun:test'
import {
  type CaptureSessionDescriptor,
  CaptureSessionDescriptorSchema,
  type CaptureSource,
} from '@pascal-app/core/capture'
import { loadScanEvidence } from './load'

const sha = 'd'.repeat(64)

const descriptor: CaptureSessionDescriptor = CaptureSessionDescriptorSchema.parse({
  schemaVersion: 2,
  sessionId: 's1',
  state: 'ready',
  clocks: [],
  coordinateFrames: [],
  streams: [
    {
      id: 'planes',
      kind: 'plane-set',
      artifact: { id: 'planes', mediaType: 'application/json', uri: '/p' },
    },
    {
      id: 'photos',
      kind: 'rgb-keyframes',
      artifact: { id: 'photos', mediaType: 'application/json', uri: '/k' },
    },
    {
      id: 'meas',
      kind: 'manual-measurements',
      inline: {
        units: 'm',
        room: { width: 3, length: 4, height: null },
        openings: [],
        notes: '',
        source: 'manual',
      },
    },
  ],
})

function source(): CaptureSource {
  return {
    describe: async () => descriptor,
    resolveArtifact: async (artifact) => ({ url: `https://x.test${artifact.uri}` }),
  }
}

describe('loadScanEvidence', () => {
  it('reads artifact and inline streams', async () => {
    const evidence = await loadScanEvidence(source(), {
      fetchJson: async (url) =>
        url.endsWith('/p')
          ? { planes: [] }
          : {
              frames: [
                {
                  id: 'k1',
                  timestamp: 1,
                  image: { uri: '/i', sha256: sha },
                  width: 4,
                  height: 3,
                  intrinsics: null,
                  pose: null,
                  trackingState: 'none',
                },
              ],
            },
    })
    expect(evidence.problems).toEqual([])
    expect(evidence.planes?.total).toBe(0)
    expect(evidence.measurements).toMatchObject({ width: 3, length: 4, height: null })
    expect(evidence.keyframes?.frames).toHaveLength(1)
  })

  it('reports an unreadable or invalid stream and still returns the rest', async () => {
    const evidence = await loadScanEvidence(source(), {
      fetchJson: async (url) => {
        if (url.endsWith('/p')) throw new Error('boom')
        return { frames: [{ id: 'bad' }] }
      },
    })
    expect(evidence.problems.sort()).toEqual(['keyframes', 'planes'])
    expect(evidence.keyframes).toBeNull()
    expect(evidence.measurements?.width).toBe(3)
  })

  it('rethrows aborts instead of reporting them as problems', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      loadScanEvidence(source(), {
        signal: abort.signal,
        fetchJson: async () => {
          throw new Error('aborted')
        },
      }),
    ).rejects.toThrow()
  })
})
