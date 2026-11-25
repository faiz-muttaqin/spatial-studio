import { z } from 'zod'
import {
  type CaptureSessionDescriptor,
  type CaptureStreamDescriptor,
  normalizeCaptureSessionManifest,
} from './schema'
import { Sha256HexSchema } from './streams'

/**
 * The `gaussian-splat` stream (ROADMAP R6): a trained 3D Gaussian splat of the scan, stored as
 * one artifact. The contract is in `docs/spatial-studio/CAPTURE_CONTRACT.md`, "Gaussian splat
 * stream (v1.4)".
 */

export const GAUSSIAN_SPLAT_STREAM_ID = 'gaussian-splat'
export const GAUSSIAN_SPLAT_KIND = 'gaussian-splat'
export const GAUSSIAN_SPLAT_ROLE = 'splat'
/** The one media type v1.4 accepts: the 3DGS binary PLY Brush and the reference trainers write. */
export const GAUSSIAN_SPLAT_MEDIA_TYPE = 'application/ply'
/**
 * Largest splat artifact. Above the 16 MB bound of every other artifact because a trained splat
 * is tens of megabytes: a 1M-splat file at SH degree 0 is about 60 MB, at degree 1 about 92 MB. Kept under the
 * 100 MB request limit of the deployment proxy and of Next.js.
 */
export const CAPTURE_MAX_SPLAT_ARTIFACT_BYTES = 96 * 1024 * 1024
/** Most splats the viewer layer draws; a larger file is thinned evenly. */
export const CAPTURE_MAX_RENDERED_SPLATS = 1_000_000

export const GaussianSplatMetadataSchema = z.object({
  format: z.literal('ply'),
  /** Spherical-harmonics degree stored in the file, 0 to 3. The viewer draws the DC colour only. */
  shDegree: z.number().int().min(0).max(3),
  units: z.literal('m'),
  /** Convention of the frame the splat is in: the world its training poses were given in. */
  frame: z.string().min(1),
  splatCount: z.number().int().positive(),
  trainer: z.string().min(1).max(64),
  trainerVersion: z.string().min(1).max(64).optional(),
  /** Hash of the Brush dataset zip the splat was trained from, when known. */
  datasetSha256: Sha256HexSchema.optional(),
})

export type GaussianSplatMetadata = z.infer<typeof GaussianSplatMetadataSchema>

const TYPE_BYTES: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
}

const REQUIRED_PROPERTIES = [
  'x',
  'y',
  'z',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
] as const

export type SplatPlyHeader = {
  splatCount: number
  shDegree: number
  /** Byte offset of the first vertex. */
  dataOffset: number
  stride: number
  properties: ReadonlyArray<{ name: string; type: string; offset: number }>
}

export class SplatPlyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SplatPlyError'
  }
}

const HEADER_END = 'end_header\n'
const MAX_HEADER_BYTES = 64 * 1024

/** Reads and checks the header of a binary little-endian 3DGS PLY. Throws {@link SplatPlyError}. */
export function readSplatPlyHeader(bytes: Uint8Array): SplatPlyHeader {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, MAX_HEADER_BYTES))
  const end = head.indexOf(HEADER_END)
  if (!head.startsWith('ply') || end < 0) throw new SplatPlyError('Not a PLY file.')
  const lines = head.slice(0, end).split(/\r?\n/)
  if (!lines.includes('format binary_little_endian 1.0')) {
    throw new SplatPlyError('Only binary little-endian PLY files are supported.')
  }
  let splatCount = 0
  let element: string | null = null
  const properties: Array<{ name: string; type: string; offset: number }> = []
  let stride = 0
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'element') {
      element = parts[1] ?? null
      if (element === 'vertex') splatCount = Number(parts[2])
      else if (splatCount > 0) element = null
    } else if (parts[0] === 'property' && element === 'vertex') {
      if (parts[1] === 'list') throw new SplatPlyError('List properties are not supported.')
      const type = parts[1] ?? ''
      const size = TYPE_BYTES[type]
      if (!size) throw new SplatPlyError(`Unsupported property type: ${type}.`)
      properties.push({ name: parts[2] ?? '', type, offset: stride })
      stride += size
    }
  }
  if (!Number.isInteger(splatCount) || splatCount <= 0) {
    throw new SplatPlyError('The file has no vertices.')
  }
  const names = new Set(properties.map((property) => property.name))
  const missing = REQUIRED_PROPERTIES.filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new SplatPlyError(`Not a 3D Gaussian splat; missing ${missing.join(', ')}.`)
  }
  const rest = properties.filter((property) => property.name.startsWith('f_rest_')).length
  const shDegree = [0, 9, 24, 45].indexOf(rest)
  if (shDegree < 0) throw new SplatPlyError(`Unexpected number of f_rest properties: ${rest}.`)
  const dataOffset = end + HEADER_END.length
  if (bytes.byteLength < dataOffset + splatCount * stride) {
    throw new SplatPlyError('The file is shorter than its header says.')
  }
  return { splatCount, shDegree, dataOffset, stride, properties }
}

export type GaussianSplatData = {
  count: number
  /** The file's splat count; above `count` when the file was thinned. */
  sourceCount: number
  /** xyz, metres. */
  positions: Float32Array
  /** DC colour as sRGB 0..1. */
  colors: Float32Array
  /** 0..1. */
  opacities: Float32Array
  /** Standard deviations along the splat's axes, metres. */
  scales: Float32Array
  /** Unit quaternions as w, x, y, z. */
  rotations: Float32Array
}

const SH_C0 = 0.28209479177387814
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * The splats of a 3DGS PLY as render-ready arrays: opacity through the sigmoid, scales through
 * `exp`, quaternions normalised, and the degree-0 spherical-harmonics term as an sRGB colour.
 * Splats beyond `maxSplats` are thinned evenly across the file.
 */
export function parseGaussianSplatPly(
  bytes: Uint8Array,
  options: { maxSplats?: number } = {},
): GaussianSplatData {
  const header = readSplatPlyHeader(bytes)
  const limit = Math.max(1, Math.floor(options.maxSplats ?? CAPTURE_MAX_RENDERED_SPLATS))
  const count = Math.min(header.splatCount, limit)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offsetOf = (name: string) => {
    const property = header.properties.find((entry) => entry.name === name)!
    return { offset: property.offset, type: property.type }
  }
  const readers = Object.fromEntries(REQUIRED_PROPERTIES.map((name) => [name, offsetOf(name)]))
  const read = (name: (typeof REQUIRED_PROPERTIES)[number], base: number): number => {
    const { offset, type } = readers[name]!
    const at = base + offset
    switch (type) {
      case 'double':
      case 'float64':
        return view.getFloat64(at, true)
      case 'float':
      case 'float32':
        return view.getFloat32(at, true)
      default:
        throw new SplatPlyError(`Property ${name} must be a float.`)
    }
  }
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const opacities = new Float32Array(count)
  const scales = new Float32Array(count * 3)
  const rotations = new Float32Array(count * 4)
  for (let index = 0; index < count; index += 1) {
    const source =
      count === header.splatCount ? index : Math.floor((index * header.splatCount) / count)
    const base = header.dataOffset + source * header.stride
    positions[index * 3] = read('x', base)
    positions[index * 3 + 1] = read('y', base)
    positions[index * 3 + 2] = read('z', base)
    colors[index * 3] = clamp01(0.5 + SH_C0 * read('f_dc_0', base))
    colors[index * 3 + 1] = clamp01(0.5 + SH_C0 * read('f_dc_1', base))
    colors[index * 3 + 2] = clamp01(0.5 + SH_C0 * read('f_dc_2', base))
    opacities[index] = 1 / (1 + Math.exp(-read('opacity', base)))
    scales[index * 3] = Math.exp(read('scale_0', base))
    scales[index * 3 + 1] = Math.exp(read('scale_1', base))
    scales[index * 3 + 2] = Math.exp(read('scale_2', base))
    const w = read('rot_0', base)
    const x = read('rot_1', base)
    const y = read('rot_2', base)
    const z = read('rot_3', base)
    const length = Math.hypot(w, x, y, z) || 1
    rotations[index * 4] = w / length
    rotations[index * 4 + 1] = x / length
    rotations[index * 4 + 2] = y / length
    rotations[index * 4 + 3] = z / length
  }
  return { count, sourceCount: header.splatCount, positions, colors, opacities, scales, rotations }
}

/** The metadata a splat file's header supports; the caller adds the trainer and the frame. */
export function describeSplatPly(bytes: Uint8Array): { splatCount: number; shDegree: number } {
  const { splatCount, shDegree } = readSplatPlyHeader(bytes)
  return { splatCount, shDegree }
}

export type AttachSplatInput = {
  sha256: string
  byteLength: number
  metadata: Omit<GaussianSplatMetadata, 'frame' | 'units' | 'format'> & { frame?: string }
}

/**
 * A manifest with the splat added as its `gaussian-splat` stream, replacing an earlier one. The
 * stream takes the frame of the keyframes, so the splat draws in the world its poses were given
 * in with no extra transform. The result is a new manifest: it has a new hash, and the scan node
 * must point at that. Throws when the bytes exceed the splat bound or the metadata is invalid.
 */
export function withGaussianSplatStream(
  manifest: unknown,
  input: AttachSplatInput,
): CaptureSessionDescriptor {
  const descriptor = normalizeCaptureSessionManifest(manifest)
  if (input.byteLength > CAPTURE_MAX_SPLAT_ARTIFACT_BYTES) {
    throw new Error(
      `Splat artifacts are limited to ${CAPTURE_MAX_SPLAT_ARTIFACT_BYTES} bytes, got ${input.byteLength}.`,
    )
  }
  const anchor =
    descriptor.streams.find((stream) => stream.kind === 'rgb-keyframes' && stream.frameId) ??
    descriptor.streams.find((stream) => stream.kind === 'point-cloud' && stream.frameId)
  const frameConvention = descriptor.coordinateFrames.find(
    (frame) => frame.id === anchor?.frameId,
  )?.convention
  const metadata = GaussianSplatMetadataSchema.parse({
    ...input.metadata,
    format: 'ply',
    units: 'm',
    frame: input.metadata.frame ?? frameConvention ?? 'capture-world',
  })
  const stream: CaptureStreamDescriptor = {
    id: GAUSSIAN_SPLAT_STREAM_ID,
    kind: GAUSSIAN_SPLAT_KIND,
    role: GAUSSIAN_SPLAT_ROLE,
    availability: 'ready',
    ...(anchor?.frameId ? { frameId: anchor.frameId } : {}),
    artifact: {
      id: `${descriptor.sessionId}:${GAUSSIAN_SPLAT_STREAM_ID}`,
      uri: `/api/artifacts/${input.sha256}`,
      mediaType: GAUSSIAN_SPLAT_MEDIA_TYPE,
      byteLength: input.byteLength,
      sha256: Sha256HexSchema.parse(input.sha256),
    },
    metadata,
  }
  return {
    ...descriptor,
    streams: [...descriptor.streams.filter((entry) => entry.kind !== GAUSSIAN_SPLAT_KIND), stream],
  }
}
