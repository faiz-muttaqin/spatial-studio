import { describe, expect, test } from 'bun:test'
import {
  CaptureSessionManifestV2Schema,
  ManualMeasurementsSchema,
  normalizeCaptureSessionManifest,
  RgbKeyframeIndexSchema,
} from '@pascal-app/core/capture'
import { prepareArtifact } from './artifacts'
import { buildBrowserPhotoBundle } from './browser-photo-bundle'

const browserCapabilities = {
  secureContext: true,
  browser: 'Chrome 140',
  camera: { mediaDevices: true, videoInputs: 1 },
  webxr: { api: false, immersiveAr: 'unsupported' as const, features: {} },
  orientation: { api: true, permission: 'not-required' as const },
  motion: { api: true, permission: 'not-required' as const },
}

async function bundle(room = { width: 3.6, length: 4.2, height: 2.7 }) {
  const photo = await prepareArtifact(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), 'image/jpeg')
  return {
    photo,
    result: await buildBrowserPhotoBundle({
      sessionId: 'capture_test',
      projectId: 'scene-1',
      appVersion: '0.1.0',
      createdAt: new Date('2026-11-25T08:00:00.000Z'),
      device: { manufacturer: null, model: null, os: 'Android' },
      photos: [
        { id: 'frame-001', timestamp: 1_764_057_600_000, width: 1920, height: 1440, image: photo },
      ],
      measurements: {
        units: 'm',
        room,
        openings: [{ kind: 'window', wall: 'east', width: 1.2, height: 1.4, sill: 0.9 }],
        notes: '',
        source: 'manual',
      },
      capabilities: { probedAt: 1, browser: browserCapabilities, native: null },
    }),
  }
}

async function readJson(blob: Blob): Promise<unknown> {
  return JSON.parse(await blob.text())
}

describe('browser-photo bundle', () => {
  test('writes a valid V2 manifest whose artifact references match the uploads', async () => {
    const { photo, result } = await bundle()
    const manifest = CaptureSessionManifestV2Schema.parse(
      await readJson(result.manifestArtifact.body),
    )
    expect(result.manifestUrl).toBe(`/api/artifacts/${result.manifestArtifact.sha256}`)
    expect(manifest.coordinateFrames).toEqual([])
    expect(manifest.streams.map((stream) => [stream.kind, stream.role])).toEqual([
      ['rgb-keyframes', 'photos'],
      ['manual-measurements', 'measurements'],
      ['device-capabilities', 'capabilities'],
    ])
    expect(manifest.metadata).toMatchObject({
      provider: 'browser-photo',
      trackingLossCount: 0,
      warnings: ['no-pose', 'no-intrinsics'],
    })

    const uploaded = new Map(result.artifacts.map((artifact) => [artifact.sha256, artifact]))
    for (const stream of manifest.streams.filter((s) => s.artifact)) {
      const artifact = uploaded.get(stream.artifact!.sha256!)!
      expect(stream.artifact!.uri).toBe(`/api/artifacts/${artifact.sha256}`)
      expect(stream.artifact!.byteLength).toBe(artifact.byteLength)
    }
    expect(uploaded.has(photo.sha256)).toBe(true)
    // Normalizes like any other manifest the viewer reads.
    expect(normalizeCaptureSessionManifest(manifest).streams).toHaveLength(3)
  })

  test('the keyframe index points at the photo with null pose and intrinsics', async () => {
    const { photo, result } = await bundle()
    const indexStream = result.manifest.streams.find((stream) => stream.kind === 'rgb-keyframes')!
    const indexArtifact = result.artifacts.find(
      (artifact) => artifact.sha256 === indexStream.artifact?.sha256,
    )!
    const index = RgbKeyframeIndexSchema.parse(await readJson(indexArtifact.body))
    expect(index.frames).toEqual([
      {
        id: 'frame-001',
        timestamp: 1_764_057_600_000,
        image: { uri: `/api/artifacts/${photo.sha256}`, sha256: photo.sha256 },
        width: 1920,
        height: 1440,
        intrinsics: null,
        pose: null,
        trackingState: 'none',
      },
    ])
  })

  test('stores measurements as entered and warns when room dimensions are missing', async () => {
    const { result } = await bundle({ width: 3.6, length: null as never, height: 2.7 })
    const stream = result.manifest.streams.find((s) => s.kind === 'manual-measurements')!
    const artifact = result.artifacts.find((a) => a.sha256 === stream.artifact?.sha256)!
    const measurements = ManualMeasurementsSchema.parse(await readJson(artifact.body))
    expect(measurements.room.length).toBeNull()
    expect(result.manifest.metadata?.warnings).toContain('room-dimensions-incomplete')
  })

  test('is content addressed: the same input hashes the same', async () => {
    const first = await bundle()
    const second = await bundle()
    expect(second.result.manifestArtifact.sha256).toBe(first.result.manifestArtifact.sha256)
  })
})
