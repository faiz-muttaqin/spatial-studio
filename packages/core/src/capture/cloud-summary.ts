import type { Vec3 } from './plane-analysis'

/**
 * Robust summaries of a capture's point cloud and walked path. A feature-point cloud holds stray
 * points (glass and polished surfaces reflect), so extents are percentiles, not min and max, and
 * the share of points far from the walked path is reported rather than hidden.
 */

export type CloudSummary = {
  pointCount: number
  /** 2nd and 98th percentile per axis, `[x, y, z]`. */
  boundsP2: Vec3
  boundsP98: Vec3
  /** Present when a path was given: how far points sit from the nearest path sample. */
  farFromPath: {
    thresholdM: number
    fraction: number
    distanceP50: number
    distanceP95: number
    /** How many points were measured (large clouds are strided). */
    sampled: number
    /** 2nd and 98th percentile per axis of the points within the threshold of the path, the usual room extent. */
    nearPathBoundsP2: Vec3 | null
    nearPathBoundsP98: Vec3 | null
  } | null
}

const MAX_MEASURED_POINTS = 20_000
const MAX_PATH_SAMPLES = 2_000
const FAR_THRESHOLD_M = 6

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
  ]!
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Applies a column-major 4x4 to flat XYZ triples. */
export function transformPositions(
  positions: readonly number[],
  matrix: readonly number[],
): number[] {
  const out = new Array<number>(positions.length)
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!
    const y = positions[i + 1]!
    const z = positions[i + 2]!
    out[i] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!
    out[i + 1] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!
    out[i + 2] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!
  }
  return out
}

export function summarisePointCloud(
  positions: readonly number[],
  path: ReadonlyArray<Vec3> | null,
): CloudSummary | null {
  const count = Math.floor(positions.length / 3)
  if (count === 0) return null
  const axes = [0, 1, 2].map((axis) => {
    const values: number[] = []
    for (let i = axis; i < count * 3; i += 3) values.push(positions[i]!)
    return values.sort((left, right) => left - right)
  })
  const p = (fraction: number): Vec3 => [
    round(percentile(axes[0]!, fraction)),
    round(percentile(axes[1]!, fraction)),
    round(percentile(axes[2]!, fraction)),
  ]

  let farFromPath: CloudSummary['farFromPath'] = null
  if (path && path.length > 0) {
    const pathStride = Math.max(1, Math.ceil(path.length / MAX_PATH_SAMPLES))
    const pointStride = Math.max(1, Math.ceil(count / MAX_MEASURED_POINTS))
    const distances: number[] = []
    const near: number[][] = [[], [], []]
    for (let point = 0; point < count; point += pointStride) {
      const x = positions[point * 3]!
      const y = positions[point * 3 + 1]!
      const z = positions[point * 3 + 2]!
      let nearest = Number.POSITIVE_INFINITY
      for (let sample = 0; sample < path.length; sample += pathStride) {
        const [px, py, pz] = path[sample]!
        const squared = (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2
        if (squared < nearest) nearest = squared
      }
      const distance = Math.sqrt(nearest)
      distances.push(distance)
      if (distance <= FAR_THRESHOLD_M) {
        near[0]!.push(x)
        near[1]!.push(y)
        near[2]!.push(z)
      }
    }
    distances.sort((left, right) => left - right)
    for (const axis of near) axis.sort((left, right) => left - right)
    const nearBounds = (fraction: number): Vec3 | null =>
      near[0]!.length
        ? [
            round(percentile(near[0]!, fraction)),
            round(percentile(near[1]!, fraction)),
            round(percentile(near[2]!, fraction)),
          ]
        : null
    farFromPath = {
      thresholdM: FAR_THRESHOLD_M,
      fraction: round(
        distances.filter((distance) => distance > FAR_THRESHOLD_M).length / distances.length,
      ),
      distanceP50: round(percentile(distances, 0.5)),
      distanceP95: round(percentile(distances, 0.95)),
      sampled: distances.length,
      nearPathBoundsP2: nearBounds(0.02),
      nearPathBoundsP98: nearBounds(0.98),
    }
  }
  return { pointCount: count, boundsP2: p(0.02), boundsP98: p(0.98), farFromPath }
}

export type PathSummary = {
  sampleCount: number
  segments: number
  lengthM: number
  boundsMin: Vec3
  boundsMax: Vec3
}

/** The walked path: camera positions from the trajectory's column-major transforms. */
export function pathPositions(
  samples: ReadonlyArray<{ transform: readonly number[] }>,
  matrix: readonly number[] | null,
): Vec3[] {
  return samples.map(({ transform }) => {
    const [x, y, z] = [transform[12]!, transform[13]!, transform[14]!]
    return matrix
      ? [
          matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
          matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
          matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
        ]
      : [x, y, z]
  })
}

export function summarisePath(
  positions: ReadonlyArray<Vec3>,
  segments: number,
): PathSummary | null {
  if (positions.length === 0) return null
  let length = 0
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  positions.forEach((point, index) => {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!)
      max[axis] = Math.max(max[axis]!, point[axis]!)
    }
    if (index > 0) {
      const previous = positions[index - 1]!
      length += Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2])
    }
  })
  return {
    sampleCount: positions.length,
    segments,
    lengthM: round(length),
    boundsMin: [round(min[0]), round(min[1]), round(min[2])],
    boundsMax: [round(max[0]), round(max[1]), round(max[2])],
  }
}
