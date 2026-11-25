import { describe, expect, test } from 'bun:test'
import {
  CAPTURE_MAX_SPLAT_ARTIFACT_BYTES,
  parseGaussianSplatPly,
  readSplatPlyHeader,
  SplatPlyError,
  withGaussianSplatStream,
} from './splat'

type Splat = {
  position: [number, number, number]
  dc: [number, number, number]
  opacity: number
  scale: [number, number, number]
  rot: [number, number, number, number]
}

/** A binary 3DGS PLY, with `restProperties` zero-filled f_rest_ floats per splat. */
export function makeSplatPly(splats: Splat[], restProperties = 0): Uint8Array {
  const names = [
    'x',
    'y',
    'z',
    'nx',
    'ny',
    'nz',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    ...Array.from({ length: restProperties }, (_, index) => `f_rest_${index}`),
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
  ]
  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${names.map((name) => `property float ${name}`).join('\n')}\nend_header\n`,
  )
  const body = new Float32Array(splats.length * names.length)
  splats.forEach((splat, row) => {
    const values: Record<string, number> = {
      x: splat.position[0],
      y: splat.position[1],
      z: splat.position[2],
      f_dc_0: splat.dc[0],
      f_dc_1: splat.dc[1],
      f_dc_2: splat.dc[2],
      opacity: splat.opacity,
      scale_0: splat.scale[0],
      scale_1: splat.scale[1],
      scale_2: splat.scale[2],
      rot_0: splat.rot[0],
      rot_1: splat.rot[1],
      rot_2: splat.rot[2],
      rot_3: splat.rot[3],
    }
    names.forEach((name, column) => {
      body[row * names.length + column] = values[name] ?? 0
    })
  })
  const bytes = new Uint8Array(header.length + body.byteLength)
  bytes.set(header, 0)
  bytes.set(new Uint8Array(body.buffer), header.length)
  return bytes
}

const SPLAT: Splat = {
  position: [1, 2, 3],
  dc: [0, 1, -1],
  opacity: 0,
  scale: [Math.log(0.1), Math.log(0.2), Math.log(0.3)],
  rot: [2, 0, 0, 0],
}

describe('3DGS PLY', () => {
  test('reads the header and the SH degree from the f_rest count', () => {
    expect(readSplatPlyHeader(makeSplatPly([SPLAT])).shDegree).toBe(0)
    expect(readSplatPlyHeader(makeSplatPly([SPLAT], 9)).shDegree).toBe(1)
    expect(readSplatPlyHeader(makeSplatPly([SPLAT], 24)).shDegree).toBe(2)
    expect(() => readSplatPlyHeader(makeSplatPly([SPLAT], 5))).toThrow(SplatPlyError)
  })

  test('decodes opacity, scale, rotation and colour', () => {
    const data = parseGaussianSplatPly(makeSplatPly([SPLAT, { ...SPLAT, position: [4, 5, 6] }], 9))
    expect(data.count).toBe(2)
    expect([...data.positions]).toEqual([1, 2, 3, 4, 5, 6])
    expect(data.opacities[0]).toBeCloseTo(0.5)
    expect(data.scales[0]).toBeCloseTo(0.1)
    expect(data.scales[2]).toBeCloseTo(0.3)
    expect(data.rotations[0]).toBeCloseTo(1)
    expect(data.colors[0]).toBeCloseTo(0.5)
    expect(data.colors[1]).toBeCloseTo(0.5 + 0.28209479)
    expect(data.colors[2]).toBeCloseTo(0.5 - 0.28209479)
  })

  test('thins evenly beyond the limit and reports the source count', () => {
    const splats = Array.from({ length: 10 }, (_, index) => ({
      ...SPLAT,
      position: [index, 0, 0] as [number, number, number],
    }))
    const data = parseGaussianSplatPly(makeSplatPly(splats), { maxSplats: 5 })
    expect(data.count).toBe(5)
    expect(data.sourceCount).toBe(10)
    expect([...data.positions].filter((_, index) => index % 3 === 0)).toEqual([0, 2, 4, 6, 8])
  })

  test('refuses ASCII files, plain point clouds and truncated files', () => {
    expect(() =>
      readSplatPlyHeader(
        new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 1\nend_header\n'),
      ),
    ).toThrow('binary')
    const cloud = new TextEncoder().encode(
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n' +
        'x'.repeat(12),
    )
    expect(() => readSplatPlyHeader(cloud)).toThrow('missing')
    const full = makeSplatPly([SPLAT])
    expect(() => readSplatPlyHeader(full.subarray(0, full.length - 4))).toThrow('shorter')
  })
})

describe('withGaussianSplatStream', () => {
  const manifest = {
    schemaVersion: 2,
    sessionId: 'capture_1',
    state: 'ready',
    coordinateFrames: [{ id: 'world', convention: 'arcore-world' }],
    streams: [{ id: 'photos', kind: 'rgb-keyframes', role: 'photos', frameId: 'world' }],
  }
  const input = {
    sha256: 'b'.repeat(64),
    byteLength: 1000,
    metadata: { shDegree: 1, splatCount: 10, trainer: 'brush' },
  }

  test('adds the stream in the keyframes frame with its metadata, replacing an earlier one', () => {
    const first = withGaussianSplatStream(manifest, input)
    const stream = first.streams.find((entry) => entry.kind === 'gaussian-splat')!
    expect(stream.frameId).toBe('world')
    expect(stream.artifact).toMatchObject({
      uri: `/api/artifacts/${'b'.repeat(64)}`,
      mediaType: 'application/ply',
      byteLength: 1000,
    })
    expect(stream.metadata).toMatchObject({
      format: 'ply',
      units: 'm',
      frame: 'arcore-world',
      shDegree: 1,
      splatCount: 10,
    })
    const second = withGaussianSplatStream(first, { ...input, sha256: 'c'.repeat(64) })
    expect(second.streams.filter((entry) => entry.kind === 'gaussian-splat')).toHaveLength(1)
    expect(second.streams).toHaveLength(2)
  })

  test('refuses an oversized file and bad metadata', () => {
    expect(() =>
      withGaussianSplatStream(manifest, {
        ...input,
        byteLength: CAPTURE_MAX_SPLAT_ARTIFACT_BYTES + 1,
      }),
    ).toThrow('limited')
    expect(() =>
      withGaussianSplatStream(manifest, { ...input, metadata: { ...input.metadata, shDegree: 4 } }),
    ).toThrow()
    expect(() => withGaussianSplatStream(manifest, { ...input, sha256: 'xyz' })).toThrow()
  })
})
