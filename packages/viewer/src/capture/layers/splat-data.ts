import type { GaussianSplatData } from '@pascal-app/core/capture'

/**
 * Splat data packed for the GPU: one texel per splat in four textures read by index in the
 * vertex shader, so a depth re-sort only rewrites a list of indices, never the splat data.
 */
export const SPLAT_TEXTURE_WIDTH = 2048

export type SplatTextures = {
  width: number
  height: number
  /** RGBA32F: centre xyz, opacity. */
  centres: Float32Array
  /** RGBA8: sRGB colour, 255. */
  colours: Uint8Array
  /** RGBA32F: covariance xx, xy, xz, yy. */
  covarianceA: Float32Array
  /** RGBA32F: covariance yz, zz, 0, 0. */
  covarianceB: Float32Array
}

/** The 3D covariance `R S S^T R^T` of a splat, as `[xx, xy, xz, yy, yz, zz]`. */
export function splatCovariance(
  scale: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
): [number, number, number, number, number, number] {
  const [w, x, y, z] = quaternion
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  const s2 = [scale[0] ** 2, scale[1] ** 2, scale[2] ** 2]
  const entry = (i: number, j: number) =>
    r[i]![0]! * s2[0]! * r[j]![0]! + r[i]![1]! * s2[1]! * r[j]![1]! + r[i]![2]! * s2[2]! * r[j]![2]!
  return [entry(0, 0), entry(0, 1), entry(0, 2), entry(1, 1), entry(1, 2), entry(2, 2)]
}

export function buildSplatTextures(data: GaussianSplatData): SplatTextures {
  const width = SPLAT_TEXTURE_WIDTH
  const height = Math.max(1, Math.ceil(data.count / width))
  const texels = width * height
  const centres = new Float32Array(texels * 4)
  const colours = new Uint8Array(texels * 4)
  const covarianceA = new Float32Array(texels * 4)
  const covarianceB = new Float32Array(texels * 4)
  for (let index = 0; index < data.count; index += 1) {
    const at = index * 4
    centres[at] = data.positions[index * 3]!
    centres[at + 1] = data.positions[index * 3 + 1]!
    centres[at + 2] = data.positions[index * 3 + 2]!
    centres[at + 3] = data.opacities[index]!
    colours[at] = Math.round(data.colors[index * 3]! * 255)
    colours[at + 1] = Math.round(data.colors[index * 3 + 1]! * 255)
    colours[at + 2] = Math.round(data.colors[index * 3 + 2]! * 255)
    colours[at + 3] = 255
    const [xx, xy, xz, yy, yz, zz] = splatCovariance(
      [data.scales[index * 3]!, data.scales[index * 3 + 1]!, data.scales[index * 3 + 2]!],
      [
        data.rotations[index * 4]!,
        data.rotations[index * 4 + 1]!,
        data.rotations[index * 4 + 2]!,
        data.rotations[index * 4 + 3]!,
      ],
    )
    covarianceA[at] = xx
    covarianceA[at + 1] = xy
    covarianceA[at + 2] = xz
    covarianceA[at + 3] = yy
    covarianceB[at] = yz
    covarianceB[at + 1] = zz
  }
  return { width, height, centres, colours, covarianceA, covarianceB }
}

const BUCKETS = 65_536

/**
 * Fills `order` with splat indices from the farthest to the nearest along `forward`, as alpha
 * blending needs. A 16-bit counting sort: depth is quantised to 65,536 steps across the splats'
 * own range, so two splats less than 1/65,536 of the scene depth apart may swap, which is not
 * visible. `scratch` holds the keys and is reused between calls.
 */
export function sortSplatsBackToFront(
  positions: Float32Array,
  count: number,
  origin: readonly [number, number, number],
  forward: readonly [number, number, number],
  order: Float32Array,
  scratch: { keys: Uint16Array; counts: Uint32Array },
): void {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  const depths = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const depth =
      (positions[index * 3]! - origin[0]) * forward[0] +
      (positions[index * 3 + 1]! - origin[1]) * forward[1] +
      (positions[index * 3 + 2]! - origin[2]) * forward[2]
    depths[index] = depth
    if (depth < min) min = depth
    if (depth > max) max = depth
  }
  const range = max - min || 1
  scratch.counts.fill(0)
  for (let index = 0; index < count; index += 1) {
    const bucket = Math.min(
      BUCKETS - 1,
      Math.floor(((depths[index]! - min) / range) * (BUCKETS - 1)),
    )
    scratch.keys[index] = bucket
    scratch.counts[bucket] = (scratch.counts[bucket] ?? 0) + 1
  }
  // Farthest first: the highest bucket takes the lowest slots.
  let running = 0
  for (let bucket = BUCKETS - 1; bucket >= 0; bucket -= 1) {
    const size = scratch.counts[bucket]!
    scratch.counts[bucket] = running
    running += size
  }
  for (let index = 0; index < count; index += 1) {
    order[scratch.counts[scratch.keys[index]!]!++] = index
  }
}

export function createSortScratch(count: number): { keys: Uint16Array; counts: Uint32Array } {
  return { keys: new Uint16Array(count), counts: new Uint32Array(BUCKETS) }
}
