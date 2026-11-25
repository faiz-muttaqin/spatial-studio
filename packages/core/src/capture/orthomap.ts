/**
 * Top-down colour map (orthomap) of a coloured dense cloud.
 *
 * The cloud is moved to level coordinates through the scan node transform, then every voxel is
 * splatted into a grid of square cells on the x, z plane. Seen from above with +Y up, +X runs to
 * the right and +Z runs down the image, so the picture reads like a plan and is not mirrored.
 * Per cell the highest voxel below the clip height wins, and voxels within `topTolerance` of it
 * are averaged, so a floor does not flicker between noisy heights. Two layer choices: `top` (what
 * a person sees looking down into the room with the ceiling cut away) and `floor` (only voxels
 * near the floor, which leaves furniture footprints empty).
 *
 * Idea of the layers follows SceneView `PlaneBake.kt` and 3DLiveScanner `postproc/texturize.cc`
 * (Apache-2.0, see ALGORITHM_STUDY.md) in spirit only; this is a plain point splat, no code copied.
 */
import { captureToLevel, IDENTITY_SCAN_TRANSFORM, type ScanTransform } from './plane-analysis'

export type OrthomapLayer = 'top' | 'floor'

export type OrthomapOptions = {
  /** Level y of the floor. Null: the 2nd percentile of the cloud heights. */
  floorY?: number | null
  /** Level y of the ceiling, when known; the clip height sits below it. */
  ceilingY?: number | null
  /** Capture to level transform. Default identity. */
  transform?: ScanTransform
  /** Default `top`. */
  layer?: OrthomapLayer
  /** Cell edge in metres. Default 0.02. */
  metresPerPixel?: number
  /** The longest side in pixels; the cell grows to fit. Default 2048. */
  maxPixels?: number
  /** `top` draws nothing above this height over the floor. Default 2.2 m, or ceiling - 0.2 m. */
  clipHeight?: number
  /** Voxels this close to a cell's highest are averaged. Default 0.05 m. */
  topTolerance?: number
  /** `floor` keeps voxels within this of the floor. Default 0.15 m. */
  floorBand?: number
  /** Empty cells with enough coloured neighbours are filled this many times. Default 2. */
  fillPasses?: number
  /** Voxel edge of the cloud, used to size the splat. Default 0.02. */
  voxelSize?: number
}

export type OrthomapSource = {
  /** Capture-world xyz per point. */
  positions: Float32Array
  /** RGB per point. */
  colors: Uint8Array
  count: number
}

export type Orthomap = {
  width: number
  height: number
  /** RGBA, row-major, row 0 at the smallest z. Alpha 0 marks cells nothing reached. */
  rgba: Uint8Array
  /**
   * World transform of the image, in level coordinates: pixel (column i, row j) covers x from
   * `origin[0] + i * metresPerPixel` and z from `origin[1] + j * metresPerPixel`.
   */
  origin: [number, number]
  metresPerPixel: number
  layer: OrthomapLayer
  /** Level heights used. */
  floorY: number
  clipY: number | null
  /** Cells that received at least one point, and cells filled from neighbours. */
  coveredCells: number
  filledCells: number
  pointsUsed: number
  /** True when the cell was made larger than asked so the image fits `maxPixels`. */
  coarsened: boolean
  notes: string[]
}

function quantile(sorted: Float32Array, fraction: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))
  ]!
}

/** Level-coordinate xyz for every point, three numbers per point. */
function toLevel(source: OrthomapSource, transform: ScanTransform): Float32Array {
  const out = new Float32Array(source.count * 3)
  for (let i = 0; i < source.count; i += 1) {
    const point = captureToLevel(transform, [
      source.positions[i * 3]!,
      source.positions[i * 3 + 1]!,
      source.positions[i * 3 + 2]!,
    ])
    out[i * 3] = point[0]
    out[i * 3 + 1] = point[1]
    out[i * 3 + 2] = point[2]
  }
  return out
}

export function buildOrthomap(source: OrthomapSource, options: OrthomapOptions = {}): Orthomap {
  const transform = options.transform ?? IDENTITY_SCAN_TRANSFORM
  const layer = options.layer ?? 'top'
  const notes: string[] = []
  const empty = (reason: string): Orthomap => ({
    width: 0,
    height: 0,
    rgba: new Uint8Array(0),
    origin: [0, 0],
    metresPerPixel: options.metresPerPixel ?? 0.02,
    layer,
    floorY: options.floorY ?? 0,
    clipY: null,
    coveredCells: 0,
    filledCells: 0,
    pointsUsed: 0,
    coarsened: false,
    notes: [reason],
  })
  if (source.count === 0) return empty('The cloud is empty.')

  const level = toLevel(source, transform)
  const heights = Float32Array.from({ length: source.count }, (_, i) => level[i * 3 + 1]!).sort()
  let floorY = options.floorY
  if (floorY === undefined || floorY === null) {
    floorY = quantile(heights, 0.02)
    notes.push('No floor height was given, so the 2nd percentile of the point heights was used.')
  }
  const ceilingY = options.ceilingY ?? null
  const clipY =
    layer === 'top'
      ? options.clipHeight !== undefined
        ? floorY + options.clipHeight
        : ceilingY !== null
          ? ceilingY - 0.2
          : floorY + 2.2
      : null
  const floorBand = options.floorBand ?? 0.15
  const lowY = floorY - 0.2
  const highY = layer === 'floor' ? floorY + floorBand : (clipY as number)

  // Extent from the points inside the height window; stray ends are trimmed by quantile.
  const xs: number[] = []
  const zs: number[] = []
  for (let i = 0; i < source.count; i += 1) {
    const y = level[i * 3 + 1]!
    if (y < lowY || y > highY) continue
    xs.push(level[i * 3]!)
    zs.push(level[i * 3 + 2]!)
  }
  if (xs.length === 0) return empty('No points lie between the floor and the clip height.')
  const sx = Float32Array.from(xs).sort()
  const sz = Float32Array.from(zs).sort()
  const pad = 0.1
  const minX = quantile(sx, 0.001) - pad
  const maxX = quantile(sx, 0.999) + pad
  const minZ = quantile(sz, 0.001) - pad
  const maxZ = quantile(sz, 0.999) + pad

  const maxPixels = options.maxPixels ?? 2048
  let cell = options.metresPerPixel ?? 0.02
  const longest = Math.max(maxX - minX, maxZ - minZ)
  let coarsened = false
  if (longest / cell > maxPixels) {
    cell = longest / maxPixels
    coarsened = true
    notes.push(`The cell was made ${cell.toFixed(3)} m so the image fits ${maxPixels} pixels.`)
  }
  const width = Math.max(1, Math.ceil((maxX - minX) / cell))
  const height = Math.max(1, Math.ceil((maxZ - minZ) / cell))

  const tolerance = options.topTolerance ?? 0.05
  const top = new Float32Array(width * height).fill(Number.NEGATIVE_INFINITY)
  const sumR = new Float32Array(width * height)
  const sumG = new Float32Array(width * height)
  const sumB = new Float32Array(width * height)
  const sumW = new Float32Array(width * height)
  let used = 0
  for (let i = 0; i < source.count; i += 1) {
    const y = level[i * 3 + 1]!
    if (y < lowY || y > highY) continue
    const column = Math.floor((level[i * 3]! - minX) / cell)
    const row = Math.floor((level[i * 3 + 2]! - minZ) / cell)
    if (column < 0 || row < 0 || column >= width || row >= height) continue
    const at = row * width + column
    if (y > top[at]! + tolerance) {
      // A clearly higher surface replaces what the cell held.
      top[at] = y
      sumR[at] = 0
      sumG[at] = 0
      sumB[at] = 0
      sumW[at] = 0
    } else if (y < top[at]! - tolerance) {
      continue
    } else if (y > top[at]!) {
      top[at] = y
    }
    sumR[at] = sumR[at]! + source.colors[i * 3]!
    sumG[at] = sumG[at]! + source.colors[i * 3 + 1]!
    sumB[at] = sumB[at]! + source.colors[i * 3 + 2]!
    sumW[at] = sumW[at]! + 1
    used += 1
  }

  const rgba = new Uint8Array(width * height * 4)
  let covered = 0
  for (let at = 0; at < width * height; at += 1) {
    if (sumW[at]! > 0) {
      rgba[at * 4] = Math.round(sumR[at]! / sumW[at]!)
      rgba[at * 4 + 1] = Math.round(sumG[at]! / sumW[at]!)
      rgba[at * 4 + 2] = Math.round(sumB[at]! / sumW[at]!)
      rgba[at * 4 + 3] = 255
      covered += 1
    }
  }

  // Hole filling: an empty cell with three or more coloured neighbours takes their mean.
  let filled = 0
  for (let pass = 0; pass < (options.fillPasses ?? 2); pass += 1) {
    const additions: Array<[number, number, number, number]> = []
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const at = row * width + column
        if (rgba[at * 4 + 3] !== 0) continue
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) continue
            const nr = row + dr
            const nc = column + dc
            if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue
            const neighbour = nr * width + nc
            if (rgba[neighbour * 4 + 3] === 0) continue
            r += rgba[neighbour * 4]!
            g += rgba[neighbour * 4 + 1]!
            b += rgba[neighbour * 4 + 2]!
            n += 1
          }
        }
        if (n >= 3) additions.push([at, r / n, g / n, b / n])
      }
    }
    for (const [at, r, g, b] of additions) {
      rgba[at * 4] = Math.round(r)
      rgba[at * 4 + 1] = Math.round(g)
      rgba[at * 4 + 2] = Math.round(b)
      rgba[at * 4 + 3] = 255
      filled += 1
    }
    if (additions.length === 0) break
  }

  return {
    width,
    height,
    rgba,
    origin: [minX, minZ],
    metresPerPixel: cell,
    layer,
    floorY,
    clipY,
    coveredCells: covered,
    filledCells: filled,
    pointsUsed: used,
    coarsened,
    notes,
  }
}

/** Box-filter downscale so the longest side is at most `maxSide`; alpha-weighted so empty cells stay empty. */
export function downscaleOrthomap(map: Orthomap, maxSide: number): Orthomap {
  const factor = Math.ceil(Math.max(map.width, map.height) / maxSide)
  if (factor <= 1) return map
  const width = Math.ceil(map.width / factor)
  const height = Math.ceil(map.height / factor)
  const rgba = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let dr = 0; dr < factor; dr += 1) {
        const sr = row * factor + dr
        if (sr >= map.height) break
        for (let dc = 0; dc < factor; dc += 1) {
          const sc = column * factor + dc
          if (sc >= map.width) break
          const at = (sr * map.width + sc) * 4
          if (map.rgba[at + 3] === 0) continue
          r += map.rgba[at]!
          g += map.rgba[at + 1]!
          b += map.rgba[at + 2]!
          n += 1
        }
      }
      const out = (row * width + column) * 4
      if (n > 0) {
        rgba[out] = Math.round(r / n)
        rgba[out + 1] = Math.round(g / n)
        rgba[out + 2] = Math.round(b / n)
        rgba[out + 3] = 255
      }
    }
  }
  return { ...map, width, height, rgba, metresPerPixel: map.metresPerPixel * factor }
}
