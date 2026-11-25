import {
  captureDirectionToLevel,
  captureToLevel,
  IDENTITY_SCAN_TRANSFORM,
  planePointToWorld,
  type ScanTransform,
  type Vec2,
} from './plane-analysis'
import type { CameraIntrinsics, CapturePlane } from './streams'

/**
 * Wall candidates from raw depth, for scans where the capture provider found no vertical planes.
 *
 * Depth pixels are unprojected through each frame's intrinsics and pose, the points between the
 * floor and the ceiling are flattened onto the floor plane, and straight lines are fitted to them
 * with a seeded RANSAC. The outer boundary of the floor planes gives weaker lines. Candidates that
 * cut the walked path are rejected, and lines that sit behind a nearer boundary (seen through glass,
 * or a reflection) are set aside and reported, never used as walls.
 *
 * Everything works in level coordinates: the scan node's transform is applied while unprojecting, so
 * the caller passes level-space floor and ceiling heights. Inputs and outputs that scale with the
 * scan are typed arrays, so the work can move to a worker.
 *
 * Camera convention (CAPTURE_CONTRACT.md): OpenGL axes (+X right, +Y up, -Z forward) relative to the
 * image readout, depth is the distance along the optical axis (not the ray), intrinsics are in depth
 * pixels. A pixel (u, v) at depth d is `[(u - cx) / fx * d, (cy - v) / fy * d, -d]` with integer pixel indices and no half-pixel offset, as in the ARCore raw depth sample.
 */

export type DepthFrameInput = {
  id: string
  width: number
  height: number
  intrinsics: CameraIntrinsics
  /** Column-major camera-to-world matrix, in the capture world. */
  pose: readonly number[]
  /** Millimetres, row-major; 0 means no measurement. */
  depth: Uint16Array
  /** Same layout; 255 is the most confident. Null when the capture has none. */
  confidence?: Uint8Array | null
}

export type DepthWallBasis = 'depth-fit' | 'floor-boundary'

export type WallCandidate = {
  /** `depth-fit:N` or `floor-boundary:N`. */
  id: string
  basis: DepthWallBasis
  a: Vec2
  b: Vec2
  length: number
  /** Grid cells (depth) or boundary cells (floor) that sit on the line. */
  support: number
  /** Root-mean-square distance of those cells from the line, metres. */
  rmse: number
  /** A few depth frames whose points lie on the line; empty for a floor boundary. */
  frameIds: string[]
}

export type DepthWallEvidence = {
  candidates: WallCandidate[]
  rejected: Array<{ id: string; basis: DepthWallBasis; reason: string }>
  /** A line set aside because a nearer accepted boundary hides it. */
  seenThrough: Array<{
    id: string
    behindId: string
    /** Distance between the two lines, metres. */
    gap: number
  }>
  /** Floor boundaries kept as the boundary although depth runs past them, with no floor beyond. */
  likelyGlassIds: string[]
  /**
   * A floor plane that ends well short of a wall depth measured, with floor seen all the way: the
   * wall is used, and both positions are reported because glass cannot be ruled out.
   */
  ambiguous: Array<{
    floorBoundaryId: string
    wallId: string
    /** Mean distance from the walked path to each, metres. */
    floorDistance: number
    wallDistance: number
  }>
  /** Depth-observed floor cells as `ix * 65536 + iz` keys on a 0.15 m grid, for edge checks. */
  floorCells: Float64Array
  /** The floor and ceiling levels used, and where they came from. */
  vertical: {
    floorY: number | null
    ceilingY: number | null
    floorBasis: 'given' | 'depth-histogram' | null
    ceilingBasis: 'given' | 'depth-histogram' | null
    /** Metres between a given floor and the depth height peak, when they disagree by over 0.25 m. */
    floorMismatch: number | null
    /** A distinct, lower, strong depth height peak: a possible step or level change, y in metres. */
    lowerLevelY: number | null
  }
  notes: string[]
  stats: {
    framesUsed: number
    framesSkipped: number
    pointsUsed: number
    cells: number
    tallCells: number
  }
  /** Tall grid cell centres as x, z pairs in level coordinates, for edge checks. */
  cells: Float32Array
}

export type DepthWallOptions = {
  transform?: ScanTransform
  /** Level-space heights in metres. Left null, they are estimated from the depth height histogram. */
  floorY?: number | null
  ceilingY?: number | null
  /** Typed floor-to-ceiling height, used when no ceiling was seen. */
  typedHeight?: number | null
  /** Walked path as x, z pairs in level coordinates. */
  path?: Float32Array | null
  /** Floor plane outlines in level coordinates (see `floorPolygonsFromPlanes`). */
  floorPolygons?: ReadonlyArray<ReadonlyArray<Vec2>>
  maxFrames?: number
  pixelStep?: number
  minConfidence?: number
  maxDepthM?: number
  seed?: number
}

const MIN_DEPTH_M = 0.4
const BAND_MARGIN = 0.3
const NO_CEILING_BAND_TOP = 2.0
const CELL = 0.05
const MIN_CELL_HITS = 3
/** A grid cell is structure (not furniture) when its points span at least this much height. */
const MIN_CELL_SPREAD = 0.5
const FLOOR_HIT_TOLERANCE = 0.08
const FLOOR_CELL = 0.15
/** Least floor area depth must have seen before its extent stands in for floor planes, m2. */
const MIN_DEPTH_FLOOR_AREA = 3
const INLIER_DISTANCE = 0.07
const FLOOR_INLIER_DISTANCE = 0.12
const MIN_DEPTH_LINE_LENGTH = 0.8
const MIN_FLOOR_LINE_LENGTH = 1.0
const RUN_GAP = 0.35
const CHAIN_GAP = 0.8
/** Share of a line's length that must be backed by dense points. */
const MIN_COVERAGE = 0.5
const MIN_RUN = 0.3
const PATH_MARGIN = 0.15
const PATH_CUT_POINTS = 3
const MAX_PATH_POINTS = 400
/** A line is behind another when most of its length is hidden from the path by it. */
const SHADOW_FRACTION = 0.5
const SHADOW_MIN_GAP = 0.4
const MAX_FRAME_IDS = 8
/**
 * A floor plane that stops this far or less before a depth-seen wall, with floor visible between,
 * is read as a short plane. Further out it is read as glass or an open side: a floor plane ending
 * more than a metre before a solid wall is rarer than clear glass, and the heuristic errs towards
 * not counting the far side as room.
 */
const SHORT_FLOOR_GAP = 1
const MAX_FLOOR_RASTER_CELLS = 4_000_000

type Cells = {
  /** Sums and counts per occupied cell. */
  x: number[]
  z: number[]
  n: number[]
  lastFrame: number[]
  yMin: number[]
  yMax: number[]
  /** Frame indices that hit the cell, up to a few, for evidence ids. */
  frames: number[][]
  index: Map<number, number>
}

type Fitted = {
  q: Vec2
  d: Vec2
  tMin: number
  tMax: number
  support: number
  rmse: number
  members: number[]
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function evenIndices(count: number, wanted: number): number[] {
  if (count <= wanted) return Array.from({ length: count }, (_, index) => index)
  return Array.from({ length: wanted }, (_, index) =>
    Math.round((index * (count - 1)) / (wanted - 1)),
  )
}

/** Outlines of the upward planes that stand at the floor, in level coordinates. */
export function floorPolygonsFromPlanes(
  planes: readonly CapturePlane[],
  transform: ScanTransform,
  floorY: number,
  tolerance = 0.25,
): Vec2[][] {
  const polygons: Vec2[][] = []
  for (const plane of planes) {
    if (plane.subsumedBy || plane.orientation !== 'horizontal-up') continue
    const points = plane.polygon.map(([x, z]) =>
      captureToLevel(transform, planePointToWorld(plane.centerPose, x, z)),
    )
    const y = points.reduce((sum, point) => sum + point[1], 0) / points.length
    if (Math.abs(y - floorY) > tolerance) continue
    polygons.push(points.map((point): Vec2 => [point[0], point[2]]))
  }
  return polygons
}

export function deriveDepthWalls(
  frames: readonly DepthFrameInput[],
  options: DepthWallOptions,
): DepthWallEvidence {
  const transform = options.transform ?? IDENTITY_SCAN_TRANSFORM
  const notes: string[] = []
  const stats = { framesUsed: 0, framesSkipped: 0, pointsUsed: 0, cells: 0, tallCells: 0 }
  const vertical: DepthWallEvidence['vertical'] = {
    floorY: options.floorY ?? null,
    ceilingY: options.ceilingY ?? null,
    floorBasis: options.floorY === undefined || options.floorY === null ? null : 'given',
    ceilingBasis: options.ceilingY === undefined || options.ceilingY === null ? null : 'given',
    floorMismatch: null,
    lowerLevelY: null,
  }
  const empty = (reason?: string): DepthWallEvidence => ({
    candidates: [],
    rejected: [],
    seenThrough: [],
    likelyGlassIds: [],
    ambiguous: [],
    floorCells: new Float64Array(0),
    vertical,
    notes: reason ? [...notes, reason] : notes,
    stats,
    cells: new Float32Array(0),
  })
  if (vertical.floorY === null) {
    const estimate = estimateVerticalExtent(frames, transform, options)
    if (estimate.floorY === null) {
      return empty('No floor level was found in the depth, so no wall band could be set.')
    }
    vertical.floorY = estimate.floorY
    vertical.floorBasis = 'depth-histogram'
    vertical.lowerLevelY = estimate.lowerLevelY
    if (estimate.lowerLevelY !== null) {
      notes.push(
        `A second strong depth height peak sits at y ${round(estimate.lowerLevelY, 2)} m, below the floor level used: a step or level change is possible. Check on site.`,
      )
    }
    notes.push(
      `The floor level (y ${round(estimate.floorY, 2)} m) is the strongest low peak in the depth heights, not a detected plane.`,
    )
    if (vertical.ceilingY === null && estimate.ceilingY !== null) {
      vertical.ceilingY = estimate.ceilingY
      vertical.ceilingBasis = 'depth-histogram'
      notes.push(
        `The ceiling level (y ${round(estimate.ceilingY, 2)} m) is a peak in the depth heights, not a detected plane.`,
      )
    }
  } else {
    // A given floor is cross-checked against where the depth points pile up.
    const check = estimateVerticalExtent(frames, transform, options)
    if (check.floorY !== null && Math.abs(check.floorY - vertical.floorY) > 0.25) {
      vertical.floorMismatch = round(Math.abs(check.floorY - vertical.floorY), 2)
      notes.push(
        `Depth points pile up at y ${round(check.floorY, 2)} m, ${round(Math.abs(check.floorY - vertical.floorY), 2)} m from the floor level used (y ${round(vertical.floorY, 2)} m); the floor level may be wrong or there is a step.`,
      )
    }
  }
  const floorY = vertical.floorY
  const ceilingY = vertical.ceilingY
  const bandLo = BAND_MARGIN
  let bandHi: number
  if (ceilingY !== null) bandHi = ceilingY - floorY - BAND_MARGIN
  else if (options.typedHeight) bandHi = options.typedHeight - BAND_MARGIN
  else {
    bandHi = NO_CEILING_BAND_TOP
    notes.push(
      `No ceiling height is known, so points up to ${NO_CEILING_BAND_TOP} m above the floor were used as the wall band.`,
    )
  }
  if (!(bandHi > bandLo + 0.5))
    return empty('The floor-to-ceiling band is too thin to find walls in.')

  const maxFrames = options.maxFrames ?? 120
  const step = Math.max(1, Math.round(options.pixelStep ?? 2))
  const minConfidence = options.minConfidence ?? 100
  const maxDepth = options.maxDepthM ?? 8
  const chosen = evenIndices(frames.length, maxFrames)

  const cells: Cells = {
    x: [],
    z: [],
    n: [],
    lastFrame: [],
    yMin: [],
    yMax: [],
    frames: [],
    index: new Map(),
  }
  const floorHits = new Set<number>()
  const positions: number[] = []
  let anyConfidence = false

  chosen.forEach((frameIndex, order) => {
    const frame = frames[frameIndex]!
    const { width, height, intrinsics, depth } = frame
    if (depth.length < width * height || frame.pose.length !== 16) {
      stats.framesSkipped += 1
      return
    }
    stats.framesUsed += 1
    const pose = frame.pose
    const origin = captureToLevel(transform, [pose[12]!, pose[13]!, pose[14]!])
    const scaleAxis = (column: number) => {
      const axis = captureDirectionToLevel(transform, [
        pose[column * 4]!,
        pose[column * 4 + 1]!,
        pose[column * 4 + 2]!,
      ])
      return [axis[0] * transform.scale, axis[1] * transform.scale, axis[2] * transform.scale]
    }
    const [a0, a1, a2] = [scaleAxis(0), scaleAxis(1), scaleAxis(2)] as [
      number[],
      number[],
      number[],
    ]
    positions.push(origin[0], origin[2])
    const confidence =
      frame.confidence && frame.confidence.length >= width * height ? frame.confidence : null
    if (confidence) anyConfidence = true
    for (let v = 0; v < height; v += step) {
      for (let u = 0; u < width; u += step) {
        const pixel = v * width + u
        const millimetres = depth[pixel]!
        if (millimetres === 0) continue
        const d = millimetres / 1000
        if (d < MIN_DEPTH_M || d > maxDepth) continue
        if (confidence && confidence[pixel]! < minConfidence) continue
        const x = ((u - intrinsics.cx) / intrinsics.fx) * d
        const y = (-(v - intrinsics.cy) / intrinsics.fy) * d
        const z = -d
        const lx = origin[0] + a0[0]! * x + a1[0]! * y + a2[0]! * z
        const ly = origin[1] + a0[1]! * x + a1[1]! * y + a2[1]! * z
        const lz = origin[2] + a0[2]! * x + a1[2]! * y + a2[2]! * z
        const above = ly - floorY
        if (Math.abs(above) <= FLOOR_HIT_TOLERANCE) {
          floorHits.add(cellKey(Math.floor(lx / FLOOR_CELL), Math.floor(lz / FLOOR_CELL)))
        }
        if (above < bandLo || above > bandHi) continue
        stats.pointsUsed += 1
        const key = cellKey(Math.floor(lx / CELL), Math.floor(lz / CELL))
        let slot = cells.index.get(key)
        if (slot === undefined) {
          slot = cells.n.length
          cells.index.set(key, slot)
          cells.x.push(0)
          cells.z.push(0)
          cells.n.push(0)
          cells.lastFrame.push(-1)
          cells.yMin.push(above)
          cells.yMax.push(above)
          cells.frames.push([])
        }
        cells.x[slot]! += lx
        cells.z[slot]! += lz
        cells.n[slot]! += 1
        if (above < cells.yMin[slot]!) cells.yMin[slot] = above
        if (above > cells.yMax[slot]!) cells.yMax[slot] = above
        if (cells.lastFrame[slot] !== order) {
          cells.lastFrame[slot] = order
          const list = cells.frames[slot]!
          if (list.length < 3) list.push(frameIndex)
        }
      }
    }
  })
  if (stats.framesSkipped)
    notes.push(
      `${stats.framesSkipped} depth frame(s) had a malformed image or pose and were skipped.`,
    )
  if (stats.framesUsed === 0) return empty('No usable depth frames.')
  if (!anyConfidence)
    notes.push('The depth frames carry no confidence image, so every non-zero pixel was used.')
  stats.cells = cells.n.length

  // Tall cells: structure that rises through the band, with enough hits to trust.
  const tall: number[] = []
  for (let slot = 0; slot < cells.n.length; slot += 1) {
    if (
      cells.n[slot]! >= MIN_CELL_HITS &&
      cells.yMax[slot]! - cells.yMin[slot]! >= MIN_CELL_SPREAD
    ) {
      tall.push(slot)
    }
  }
  stats.tallCells = tall.length
  const points = new Float32Array(tall.length * 2)
  const weights = new Float32Array(tall.length)
  tall.forEach((slot, i) => {
    points[i * 2] = cells.x[slot]! / cells.n[slot]!
    points[i * 2 + 1] = cells.z[slot]! / cells.n[slot]!
    weights[i] = Math.min(cells.n[slot]!, 6)
  })

  const random = mulberry32(options.seed ?? 1)
  const depthLines = fitLines(points, weights, {
    inlierDistance: INLIER_DISTANCE,
    minLength: MIN_DEPTH_LINE_LENGTH,
    maxLines: 14,
    iterations: 400,
    minWeight: 12,
    random,
  })

  let floorLines: Fitted[] = []
  let floorPoints: Float32Array = new Float32Array(0)
  // Wall feet sit within a few centimetres of the floor and look like floor to the height test, so
  // floor cells beside structure are dropped; the floor is the open ground between the walls.
  const structure = new Set<number>()
  for (let i = 0; i < points.length; i += 2) {
    structure.add(
      cellKey(Math.floor(points[i]! / FLOOR_CELL), Math.floor(points[i + 1]! / FLOOR_CELL)),
    )
  }
  for (const key of [...floorHits]) {
    const ix = Math.floor(key / 65536) - 32768
    const iz = (key % 65536) - 32768
    let near = false
    for (let dx = -1; dx <= 1 && !near; dx += 1) {
      for (let dz = -1; dz <= 1 && !near; dz += 1) near = structure.has(cellKey(ix + dx, iz + dz))
    }
    if (near) floorHits.delete(key)
  }
  const floorCellKeys = Float64Array.from(floorHits)
  let polygonsForFloor: ReadonlyArray<ReadonlyArray<Vec2>> = options.floorPolygons ?? []
  if (
    polygonsForFloor.length === 0 &&
    floorHits.size * FLOOR_CELL * FLOOR_CELL >= MIN_DEPTH_FLOOR_AREA
  ) {
    // No floor planes: the floor depth itself saw stands in for them, as small squares.
    polygonsForFloor = Array.from(floorHits, (key): Vec2[] => {
      const ix = Math.floor(key / 65536) - 32768
      const iz = (key % 65536) - 32768
      const x0 = ix * FLOOR_CELL
      const z0 = iz * FLOOR_CELL
      return [
        [x0, z0],
        [x0 + FLOOR_CELL, z0],
        [x0 + FLOOR_CELL, z0 + FLOOR_CELL],
        [x0, z0 + FLOOR_CELL],
      ]
    })
  }
  if (polygonsForFloor.length) {
    const boundary = floorBoundaryPoints(polygonsForFloor)
    if ('reason' in boundary) notes.push(boundary.reason)
    else {
      floorPoints = boundary.points
      floorLines = fitLines(floorPoints, new Float32Array(floorPoints.length / 2).fill(1), {
        inlierDistance: FLOOR_INLIER_DISTANCE,
        minLength: MIN_FLOOR_LINE_LENGTH,
        maxLines: 8,
        iterations: 300,
        minWeight: 10,
        random,
      })
    }
  }

  const all: Array<WallCandidate & { line: Fitted }> = []
  depthLines.forEach((line, index) => {
    const frameIds = new Set<number>()
    for (const member of line.members) {
      for (const frame of cells.frames[tall[member]!]!) {
        if (frameIds.size < MAX_FRAME_IDS) frameIds.add(frame)
      }
    }
    all.push(
      candidateOf(
        `depth-fit:${index + 1}`,
        'depth-fit',
        line,
        [...frameIds].map((i) => frames[i]!.id),
      ),
    )
  })
  floorLines.forEach((line, index) => {
    all.push(candidateOf(`floor-boundary:${index + 1}`, 'floor-boundary', line, []))
  })

  const path = pathSamples(options.path ?? null, positions)
  const rejected: DepthWallEvidence['rejected'] = []
  const seenThrough: DepthWallEvidence['seenThrough'] = []
  const likelyGlassIds: string[] = []
  const ambiguous: DepthWallEvidence['ambiguous'] = []
  let accepted: Array<WallCandidate & { line: Fitted }> = []

  if (!options.path?.length) {
    notes.push(
      'No walked path was given, so the enclosure and see-through checks used only the camera positions of the depth frames.',
    )
  }
  if (path.length === 0) {
    accepted = all
  } else {
    const kept: typeof all = []
    for (const candidate of all) {
      const pieces = splitAtPathCrossings(candidate, options.path ?? null)
      if (pieces) {
        notes.push(
          `${candidate.id} was split at ${pieces.crossings} place(s) where the walked path crosses it (doorways), and the stretches beside the crossing were dropped.`,
        )
        if (pieces.parts.length === 0) {
          rejected.push({
            id: candidate.id,
            basis: candidate.basis,
            reason: 'the walked path crosses it and no stretch long enough remains',
          })
        }
        for (const part of pieces.parts) kept.push(part)
        continue
      }
      const cut = cutsPath(candidate, path)
      if (cut) rejected.push({ id: candidate.id, basis: candidate.basis, reason: cut })
      else kept.push(candidate)
    }
    kept.sort((left, right) => distanceToPath(left, path) - distanceToPath(right, path))
    const floorCells = floorHits
    for (const candidate of kept) {
      const blocker = accepted.find((other) => hides(other, candidate, path))
      if (!blocker) {
        accepted.push(candidate)
        continue
      }
      const gap = round(lineGap(blocker, candidate))
      if (candidate.basis === 'floor-boundary') {
        rejected.push({
          id: candidate.id,
          basis: candidate.basis,
          reason: `behind ${blocker.id}, ${gap} m further out: the floor plane runs past a nearer boundary`,
        })
      } else if (
        blocker.basis === 'floor-boundary' &&
        floorContinues(blocker, candidate, path, floorCells)
      ) {
        // Depth sees floor all the way to this line. A plane that stops a little short is the usual
        // ARCore case; further out it is ambiguous (glass with floor beyond it looks the same), so
        // the measured wall is used and both positions are reported.
        accepted = accepted.filter((other) => other !== blocker)
        if (gap <= SHORT_FLOOR_GAP) {
          rejected.push({
            id: blocker.id,
            basis: blocker.basis,
            reason: `the floor plane ends ${gap} m short of ${candidate.id}, and depth sees floor between them: the plane edge is not a wall`,
          })
        } else {
          ambiguous.push({
            floorBoundaryId: blocker.id,
            wallId: candidate.id,
            floorDistance: round(distanceToPath(blocker, path), 2),
            wallDistance: round(distanceToPath(candidate, path), 2),
          })
          rejected.push({
            id: blocker.id,
            basis: blocker.basis,
            reason: `ambiguous: the floor ends ${gap} m before ${candidate.id}, where depth measured a wall; floor was seen in between, so glass is possible but not shown`,
          })
        }
        accepted.push(candidate)
      } else {
        seenThrough.push({ id: candidate.id, behindId: blocker.id, gap })
        rejected.push({
          id: candidate.id,
          basis: candidate.basis,
          reason: `seen through ${blocker.id}: ${gap} m beyond it, so glass, a reflection or an opening, not a wall`,
        })
        if (blocker.basis === 'floor-boundary' && !likelyGlassIds.includes(blocker.id)) {
          likelyGlassIds.push(blocker.id)
        }
      }
    }
  }

  // Stretches of a wall that run on behind a likely-glass boundary are seen through it, not room.
  if (path.length > 0 && likelyGlassIds.length > 0) {
    const blockers = accepted.filter((candidate) => likelyGlassIds.includes(candidate.id))
    const trimmed: typeof accepted = []
    for (const candidate of accepted) {
      if (blockers.includes(candidate)) {
        trimmed.push(candidate)
        continue
      }
      const samples = lineSamples(candidate)
      const hidden = samples.map((sample) => {
        const { point, distance } = nearest(sample, path)
        return blockers.some((blocker) => {
          const fraction = crossing(point, sample, blocker)
          return fraction !== null && (1 - fraction) * distance >= SHADOW_MIN_GAP
        })
      })
      if (!hidden.some(Boolean)) {
        trimmed.push(candidate)
        continue
      }
      let best: [number, number] | null = null
      let start = -1
      for (let i = 0; i <= samples.length; i += 1) {
        if (i < samples.length && !hidden[i]) {
          if (start < 0) start = i
        } else if (start >= 0) {
          if (!best || i - start > best[1] - best[0]) best = [start, i]
          start = -1
        }
      }
      const tOf = (i: number) => onLine(candidate, samples[i]!).t
      if (!best || tOf(best[1] - 1) - tOf(best[0]) < MIN_DEPTH_LINE_LENGTH) {
        rejected.push({
          id: candidate.id,
          basis: candidate.basis,
          reason: 'lies behind a likely-glass boundary, so it is seen through it, not a wall',
        })
        continue
      }
      const tMin = tOf(best[0])
      const tMax = tOf(best[1] - 1)
      const at = (t: number): Vec2 => [
        round(candidate.line.q[0] + candidate.line.d[0] * t),
        round(candidate.line.q[1] + candidate.line.d[1] * t),
      ]
      notes.push(
        `${candidate.id} was cut from ${candidate.length} m to ${round(tMax - tMin)} m where it runs on behind a likely-glass boundary.`,
      )
      trimmed.push({
        ...candidate,
        line: { ...candidate.line, tMin, tMax },
        a: at(tMin),
        b: at(tMax),
        length: round(tMax - tMin),
      })
    }
    accepted = trimmed
  }

  const cellsOut = Float32Array.from(points)
  return {
    candidates: accepted.map(({ line: _line, ...candidate }) => candidate),
    rejected,
    seenThrough,
    likelyGlassIds,
    ambiguous,
    floorCells: floorCellKeys,
    vertical,
    notes,
    stats,
    cells: cellsOut,
  }
}

const HEIGHT_BIN = 0.05
/** A level needs this share of the points within 7.5 cm, and this many times its surroundings. */
const MIN_LEVEL_SHARE = 0.008
const LEVEL_PROMINENCE = 2.5

/**
 * Floor and ceiling levels from the heights of every depth point: the floor is the lowest strong peak
 * below the cameras, the ceiling the strongest peak above them that is 2 to 6 m over the floor. An
 * estimate for scans with no plane set; the caller says so.
 */
export function estimateVerticalExtent(
  frames: readonly DepthFrameInput[],
  transform: ScanTransform,
  options: Pick<DepthWallOptions, 'maxFrames' | 'minConfidence' | 'maxDepthM'> = {},
): { floorY: number | null; ceilingY: number | null; lowerLevelY: number | null } {
  const bins = new Map<number, number>()
  const cameraHeights: number[] = []
  let total = 0
  const minConfidence = options.minConfidence ?? 100
  const maxDepth = options.maxDepthM ?? 8
  for (const frameIndex of evenIndices(frames.length, Math.min(options.maxFrames ?? 120, 60))) {
    const frame = frames[frameIndex]!
    const { width, height, intrinsics, depth, pose } = frame
    if (depth.length < width * height || pose.length !== 16) continue
    const origin = captureToLevel(transform, [pose[12]!, pose[13]!, pose[14]!])
    cameraHeights.push(origin[1])
    const row = [0, 1, 2].map((column) => {
      const axis = captureDirectionToLevel(transform, [
        pose[column * 4]!,
        pose[column * 4 + 1]!,
        pose[column * 4 + 2]!,
      ])
      return axis[1] * transform.scale
    }) as [number, number, number]
    const confidence =
      frame.confidence && frame.confidence.length >= width * height ? frame.confidence : null
    for (let v = 0; v < height; v += 3) {
      for (let u = 0; u < width; u += 3) {
        const pixel = v * width + u
        const d = depth[pixel]! / 1000
        if (d < MIN_DEPTH_M || d > maxDepth) continue
        if (confidence && confidence[pixel]! < minConfidence) continue
        const y =
          origin[1] +
          row[0] * ((u - intrinsics.cx) / intrinsics.fx) * d +
          row[1] * (-(v - intrinsics.cy) / intrinsics.fy) * d -
          row[2] * d
        const bin = Math.round(y / HEIGHT_BIN)
        bins.set(bin, (bins.get(bin) ?? 0) + 1)
        total += 1
      }
    }
  }
  if (total === 0 || cameraHeights.length === 0)
    return { floorY: null, ceilingY: null, lowerLevelY: null }
  cameraHeights.sort((left, right) => left - right)
  const lowestCamera = cameraHeights[0]!
  const highestCamera = cameraHeights[cameraHeights.length - 1]!
  const share = (bin: number) =>
    ((bins.get(bin - 1) ?? 0) + (bins.get(bin) ?? 0) + (bins.get(bin + 1) ?? 0)) / total
  // A level is a peak that stands well above the heights around it: walls spread points evenly over
  // the band, floors and ceilings pile them up at one height.
  const surround = (bin: number) => {
    let sum = 0
    let count = 0
    for (let offset = 4; offset <= 10; offset += 1) {
      for (const at of [bin - offset, bin + offset]) {
        sum += bins.get(at) ?? 0
        count += 1
      }
    }
    return (3 * sum) / count / total
  }
  const peaks = [...bins.keys()]
    .filter(
      (bin) =>
        (bins.get(bin) ?? 0) >= (bins.get(bin - 1) ?? 0) &&
        (bins.get(bin) ?? 0) >= (bins.get(bin + 1) ?? 0) &&
        share(bin) >= MIN_LEVEL_SHARE &&
        share(bin) >= LEVEL_PROMINENCE * surround(bin),
    )
    .map((bin) => ({ y: bin * HEIGHT_BIN, share: share(bin) }))
  const below = peaks.filter((peak) => peak.y < lowestCamera - 0.5)
  // The strongest peak is the floor; a distinct lower one is reported, not chosen.
  const floor = [...below].sort((left, right) => right.share - left.share)[0]
  if (!floor) return { floorY: null, ceilingY: null, lowerLevelY: null }
  const lower = below
    .filter((peak) => peak.y <= floor.y - 0.3 && peak.share >= 0.4 * floor.share)
    .sort((left, right) => right.share - left.share)[0]
  const ceiling = peaks
    .filter(
      (peak) => peak.y > highestCamera + 0.4 && peak.y - floor.y >= 2 && peak.y - floor.y <= 6,
    )
    .sort((left, right) => right.share - left.share)[0]
  return {
    floorY: round(floor.y, 2),
    ceilingY: ceiling ? round(ceiling.y, 2) : null,
    lowerLevelY: lower ? round(lower.y, 2) : null,
  }
}

function cellKey(ix: number, iz: number): number {
  return (ix + 32768) * 65536 + (iz + 32768)
}

function candidateOf(
  id: string,
  basis: DepthWallBasis,
  line: Fitted,
  frameIds: string[],
): WallCandidate & { line: Fitted } {
  const at = (t: number): Vec2 => [
    round(line.q[0] + line.d[0] * t),
    round(line.q[1] + line.d[1] * t),
  ]
  return {
    id,
    basis,
    a: at(line.tMin),
    b: at(line.tMax),
    length: round(line.tMax - line.tMin),
    support: line.support,
    rmse: round(line.rmse, 3),
    frameIds,
    line,
  }
}

type FitOptions = {
  inlierDistance: number
  minLength: number
  maxLines: number
  iterations: number
  minWeight: number
  random: () => number
}

/** Sequential RANSAC with a total-least-squares refit; each line keeps only its long runs. */
function fitLines(points: Float32Array, weights: Float32Array, options: FitOptions): Fitted[] {
  const count = weights.length
  const active = new Uint8Array(count).fill(1)
  let remaining = count
  const lines: Fitted[] = []
  let attempts = 0
  while (lines.length < options.maxLines && remaining >= 6 && attempts < options.maxLines * 2) {
    attempts += 1
    const list: number[] = []
    for (let i = 0; i < count; i += 1) if (active[i]) list.push(i)
    let best: { score: number; q: Vec2; d: Vec2 } | null = null
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      const i = list[Math.floor(options.random() * list.length)]!
      const j = list[Math.floor(options.random() * list.length)]!
      const dx = points[j * 2]! - points[i * 2]!
      const dz = points[j * 2 + 1]! - points[i * 2 + 1]!
      const span = Math.hypot(dx, dz)
      if (span < 0.4) continue
      const d: Vec2 = [dx / span, dz / span]
      const q: Vec2 = [points[i * 2]!, points[i * 2 + 1]!]
      let weight = 0
      let tLo = Number.POSITIVE_INFINITY
      let tHi = Number.NEGATIVE_INFINITY
      for (const k of list) {
        const px = points[k * 2]! - q[0]
        const pz = points[k * 2 + 1]! - q[1]
        if (Math.abs(px * -d[1] + pz * d[0]) > options.inlierDistance) continue
        weight += weights[k]!
        const t = px * d[0] + pz * d[1]
        if (t < tLo) tLo = t
        if (t > tHi) tHi = t
      }
      const score = weight * (0.3 + Math.min(tHi - tLo, 4) / 4)
      if (!best || score > best.score) best = { score, q, d }
    }
    if (!best) break
    let { q, d } = best
    let members: number[] = []
    for (let pass = 0; pass < 3; pass += 1) {
      members = []
      for (const k of list) {
        const px = points[k * 2]! - q[0]
        const pz = points[k * 2 + 1]! - q[1]
        if (Math.abs(px * -d[1] + pz * d[0]) <= options.inlierDistance) members.push(k)
      }
      if (members.length < 3) break
      ;({ q, d } = totalLeastSquares(points, weights, members))
    }
    if (members.length < 3) break
    const weight = members.reduce((sum, k) => sum + weights[k]!, 0)
    if (weight < options.minWeight) break

    const along = members
      .map((k) => ({
        k,
        t: (points[k * 2]! - q[0]) * d[0] + (points[k * 2 + 1]! - q[1]) * d[1],
      }))
      .sort((left, right) => left.t - right.t)
    const runs: Array<typeof along> = []
    let run: typeof along = []
    for (const item of along) {
      if (run.length && item.t - run[run.length - 1]!.t > RUN_GAP) {
        runs.push(run)
        run = []
      }
      run.push(item)
    }
    if (run.length) runs.push(run)
    const usable = runs.filter(
      (candidate) => candidate[candidate.length - 1]!.t - candidate[0]!.t >= MIN_RUN,
    )
    // Runs joined across gaps of at most CHAIN_GAP form one wall (a door or a mullion is a gap);
    // the chain with the most wall in it is this line.
    const chains: Array<typeof usable> = []
    for (const candidate of usable) {
      const last = chains[chains.length - 1]
      const previous = last?.[last.length - 1]
      if (last && previous && candidate[0]!.t - previous[previous.length - 1]!.t <= CHAIN_GAP) {
        last.push(candidate)
      } else chains.push([candidate])
    }
    const runLength = (run: (typeof usable)[number]) => run[run.length - 1]!.t - run[0]!.t
    const covered = (chain: (typeof chains)[number]) =>
      chain.reduce((sum, run) => sum + runLength(run), 0)
    const chain = chains.sort((left, right) => covered(right) - covered(left))[0]
    const used = chain?.flat() ?? []
    const tMin = used.length ? used[0]!.t : 0
    const tMax = used.length ? used[used.length - 1]!.t : 0
    const good =
      chain !== undefined &&
      tMax - tMin >= options.minLength &&
      covered(chain) / (tMax - tMin) >= MIN_COVERAGE
    // A rejected seed spends everything it matched, so a clutter line cannot be found again; an
    // accepted one spends only its chain, leaving other stretches of the same line to be found.
    const spent = good ? used.map((item) => item.k) : members
    for (const k of spent) {
      active[k] = 0
      remaining -= 1
    }
    if (!good) continue
    const usedMembers = used.map((item) => item.k)
    const sumSquares = usedMembers.reduce((sum, k) => {
      const distance = (points[k * 2]! - q[0]) * -d[1] + (points[k * 2 + 1]! - q[1]) * d[0]
      return sum + distance * distance * weights[k]!
    }, 0)
    const usedWeight = usedMembers.reduce((sum, k) => sum + weights[k]!, 0)
    lines.push({
      q,
      d,
      tMin,
      tMax,
      support: usedMembers.length,
      rmse: Math.sqrt(sumSquares / usedWeight),
      members: usedMembers,
    })
  }
  return lines
}

function totalLeastSquares(
  points: Float32Array,
  weights: Float32Array,
  members: readonly number[],
): { q: Vec2; d: Vec2 } {
  let sw = 0
  let mx = 0
  let mz = 0
  for (const k of members) {
    sw += weights[k]!
    mx += points[k * 2]! * weights[k]!
    mz += points[k * 2 + 1]! * weights[k]!
  }
  mx /= sw
  mz /= sw
  let sxx = 0
  let szz = 0
  let sxz = 0
  for (const k of members) {
    const dx = points[k * 2]! - mx
    const dz = points[k * 2 + 1]! - mz
    sxx += weights[k]! * dx * dx
    szz += weights[k]! * dz * dz
    sxz += weights[k]! * dx * dz
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  return { q: [mx, mz], d: [Math.cos(angle), Math.sin(angle)] }
}

function pathSamples(path: Float32Array | null, framePositions: number[]): Vec2[] {
  const out: Vec2[] = []
  const take = (source: ArrayLike<number>) => {
    const total = source.length / 2
    const stride = Math.max(1, Math.ceil(total / MAX_PATH_POINTS))
    for (let i = 0; i < total; i += stride) out.push([source[i * 2]!, source[i * 2 + 1]!])
  }
  if (path) take(path)
  take(framePositions)
  return out
}

function onLine(
  candidate: WallCandidate & { line: Fitted },
  point: Vec2,
): { t: number; s: number } {
  const { q, d } = candidate.line
  const px = point[0] - q[0]
  const pz = point[1] - q[1]
  return { t: px * d[0] + pz * d[1], s: px * -d[1] + pz * d[0] }
}

/**
 * Where consecutive walked-path samples step from one side of a line to the other inside its run,
 * the path went through it (a doorway): the line is cut there, leaving 0.35 m either side. Null when
 * the path never steps across it.
 */
function splitAtPathCrossings(
  candidate: WallCandidate & { line: Fitted },
  ordered: Float32Array | null,
): { parts: Array<WallCandidate & { line: Fitted }>; crossings: number } | null {
  if (!ordered || ordered.length < 4) return null
  const crossingsAt: number[] = []
  for (let i = 0; i + 1 < ordered.length / 2; i += 1) {
    const a = onLine(candidate, [ordered[i * 2]!, ordered[i * 2 + 1]!])
    const b = onLine(candidate, [ordered[i * 2 + 2]!, ordered[i * 2 + 3]!])
    if (!((a.s > PATH_MARGIN && b.s < -PATH_MARGIN) || (a.s < -PATH_MARGIN && b.s > PATH_MARGIN))) {
      continue
    }
    const t = a.t + (b.t - a.t) * (a.s / (a.s - b.s))
    if (t >= candidate.line.tMin - 0.2 && t <= candidate.line.tMax + 0.2) crossingsAt.push(t)
  }
  if (crossingsAt.length === 0) return null
  crossingsAt.sort((left, right) => left - right)
  const cuts = crossingsAt.filter((t, index) => index === 0 || t - crossingsAt[index - 1]! > 0.7)
  const edges = [
    candidate.line.tMin,
    ...cuts.flatMap((t) => [t - 0.35, t + 0.35]),
    candidate.line.tMax,
  ]
  const parts: Array<WallCandidate & { line: Fitted }> = []
  for (let i = 0; i < edges.length; i += 2) {
    const tMin = edges[i]!
    const tMax = edges[i + 1]!
    if (tMax - tMin < MIN_DEPTH_LINE_LENGTH) continue
    const line = { ...candidate.line, tMin, tMax }
    const part = candidateOf(
      `${candidate.id}.${parts.length + 1}`,
      candidate.basis,
      line,
      candidate.frameIds,
    )
    parts.push(part)
  }
  return { parts, crossings: cuts.length }
}

/** Why the path says this line is not a boundary, or null. A wall has the whole path on one side. */
function cutsPath(
  candidate: WallCandidate & { line: Fitted },
  path: readonly Vec2[],
): string | null {
  let left = 0
  let right = 0
  for (const point of path) {
    const { t, s } = onLine(candidate, point)
    if (t < candidate.line.tMin - 0.2 || t > candidate.line.tMax + 0.2) continue
    if (s > PATH_MARGIN) left += 1
    else if (s < -PATH_MARGIN) right += 1
  }
  return Math.min(left, right) >= PATH_CUT_POINTS
    ? 'cuts the walked path: the path has points on both sides of it'
    : null
}

function distanceToPath(
  candidate: WallCandidate & { line: Fitted },
  path: readonly Vec2[],
): number {
  let sum = 0
  let count = 0
  for (const sample of lineSamples(candidate)) {
    sum += nearest(sample, path).distance
    count += 1
  }
  return count ? sum / count : 0
}

function lineSamples(candidate: WallCandidate & { line: Fitted }): Vec2[] {
  const { q, d, tMin, tMax } = candidate.line
  const total = Math.max(2, Math.ceil((tMax - tMin) / 0.2))
  return Array.from({ length: total + 1 }, (_, index): Vec2 => {
    const t = tMin + ((tMax - tMin) * index) / total
    return [q[0] + d[0] * t, q[1] + d[1] * t]
  })
}

function nearest(point: Vec2, path: readonly Vec2[]): { point: Vec2; distance: number } {
  let best = path[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of path) {
    const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1])
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return { point: best, distance: bestDistance }
}

/** Where the segment from `from` to `to` crosses the extended line segment of `blocker`, as a 0..1 fraction. */
function crossing(from: Vec2, to: Vec2, blocker: WallCandidate & { line: Fitted }): number | null {
  const a = onLine(blocker, from)
  const b = onLine(blocker, to)
  if (a.s * b.s >= 0) return null
  const fraction = a.s / (a.s - b.s)
  const t = a.t + (b.t - a.t) * fraction
  if (t < blocker.line.tMin - 0.2 || t > blocker.line.tMax + 0.2) return null
  return fraction
}

function hides(
  blocker: WallCandidate & { line: Fitted },
  behind: WallCandidate & { line: Fitted },
  path: readonly Vec2[],
): boolean {
  const samples = lineSamples(behind)
  let hidden = 0
  for (const sample of samples) {
    const { point, distance } = nearest(sample, path)
    const fraction = crossing(point, sample, blocker)
    if (fraction !== null && (1 - fraction) * distance >= SHADOW_MIN_GAP) hidden += 1
  }
  return hidden / samples.length >= SHADOW_FRACTION
}

function lineGap(
  blocker: WallCandidate & { line: Fitted },
  behind: WallCandidate & { line: Fitted },
): number {
  const samples = lineSamples(behind)
  const total = samples.reduce((sum, sample) => sum + Math.abs(onLine(blocker, sample).s), 0)
  return total / samples.length
}

/** Whether depth saw floor along most of the way from the nearer boundary out to the further line. */
function floorContinues(
  blocker: WallCandidate & { line: Fitted },
  behind: WallCandidate & { line: Fitted },
  path: readonly Vec2[],
  floorCells: ReadonlySet<number>,
): boolean {
  let seen = 0
  let total = 0
  for (const sample of lineSamples(behind)) {
    const { point } = nearest(sample, path)
    const fraction = crossing(point, sample, blocker)
    if (fraction === null) continue
    const length = Math.hypot(sample[0] - point[0], sample[1] - point[1])
    const from = length * fraction
    for (let distance = from + 0.1; distance < length - 0.1; distance += 0.1) {
      const x = point[0] + ((sample[0] - point[0]) * distance) / length
      const z = point[1] + ((sample[1] - point[1]) * distance) / length
      const ix = Math.floor(x / FLOOR_CELL)
      const iz = Math.floor(z / FLOOR_CELL)
      total += 1
      let hit = false
      for (let dx = -1; dx <= 1 && !hit; dx += 1) {
        for (let dz = -1; dz <= 1 && !hit; dz += 1) hit = floorCells.has(cellKey(ix + dx, iz + dz))
      }
      if (hit) seen += 1
    }
  }
  return total > 0 && seen / total >= 0.5
}

/** Boundary cells of the filled union of the floor polygons, at 0.1 m, as x, z pairs. */
function floorBoundaryPoints(
  polygons: ReadonlyArray<ReadonlyArray<Vec2>>,
): { points: Float32Array } | { reason: string } {
  const size = 0.1
  const margin = 1
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const polygon of polygons) {
    for (const [x, z] of polygon) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
  }
  minX -= margin
  minZ -= margin
  const width = Math.ceil((maxX + margin - minX) / size)
  const height = Math.ceil((maxZ + margin - minZ) / size)
  if (!(width > 0 && height > 0) || width * height > MAX_FLOOR_RASTER_CELLS) {
    return { reason: 'The floor planes span too large an area to read their boundary.' }
  }
  const covered = new Uint8Array(width * height)
  for (const polygon of polygons) {
    const xs = polygon.map((point) => point[0])
    const zs = polygon.map((point) => point[1])
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - minX) / size))
    const i1 = Math.min(width - 1, Math.floor((Math.max(...xs) - minX) / size))
    const j0 = Math.max(0, Math.floor((Math.min(...zs) - minZ) / size))
    const j1 = Math.min(height - 1, Math.floor((Math.max(...zs) - minZ) / size))
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        if (insidePolygon(minX + (i + 0.5) * size, minZ + (j + 0.5) * size, polygon)) {
          covered[j * width + i] = 1
        }
      }
    }
  }
  // Close small holes (furniture) so only the outer boundary remains.
  const closeRadius = 3
  const closed = dilate(covered, width, height, closeRadius)
  const outside = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  const push = (i: number, j: number) => {
    const at = j * width + i
    if (closed[at] || outside[at]) return
    outside[at] = 1
    queue[tail++] = at
  }
  for (let i = 0; i < width; i += 1) {
    push(i, 0)
    push(i, height - 1)
  }
  for (let j = 0; j < height; j += 1) {
    push(0, j)
    push(width - 1, j)
  }
  while (head < tail) {
    const at = queue[head++]!
    const i = at % width
    const j = (at - i) / width
    if (i > 0) push(i - 1, j)
    if (i < width - 1) push(i + 1, j)
    if (j > 0) push(i, j - 1)
    if (j < height - 1) push(i, j + 1)
  }
  const nearOutside = dilate(outside, width, height, closeRadius + 1)
  const out: number[] = []
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const at = j * width + i
      if (covered[at] && nearOutside[at]) out.push(minX + (i + 0.5) * size, minZ + (j + 0.5) * size)
    }
  }
  return { points: Float32Array.from(out) }
}

/** Square max filter of radius `radius` cells, as two separable passes. */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(mask.length)
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      if (!mask[j * width + i]) continue
      for (let k = Math.max(0, i - radius); k <= Math.min(width - 1, i + radius); k += 1) {
        horizontal[j * width + k] = 1
      }
    }
  }
  const out = new Uint8Array(mask.length)
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      if (!horizontal[j * width + i]) continue
      for (let k = Math.max(0, j - radius); k <= Math.min(height - 1, j + radius); k += 1) {
        out[k * width + i] = 1
      }
    }
  }
  return out
}

function insidePolygon(x: number, z: number, polygon: ReadonlyArray<Vec2>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export function pointInPolygon(point: Vec2, polygon: ReadonlyArray<Vec2>): boolean {
  return insidePolygon(point[0], point[1], polygon)
}

export type BeyondEdge = {
  /** Structure cells lying outside the edge, between 0.4 and 8 m past it, across the edge's run. */
  cells: number
  /** Those cells as a share of all structure cells across the run, in and out. */
  share: number
  /** How far the furthest of them is past the edge, metres. */
  maxDistance: number
}

/**
 * How much depth structure lies past an edge. A solid wall has almost none; clear glass, an opening
 * or a mirror has plenty, because the sensor sees through or into it.
 */
export function measureBeyondEdge(
  evidence: DepthWallEvidence,
  from: Vec2,
  to: Vec2,
  outward: Vec2,
): BeyondEdge {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  if (length === 0) return { cells: 0, share: 0, maxDistance: 0 }
  const dx = (to[0] - from[0]) / length
  const dz = (to[1] - from[1]) / length
  const nx = -dz * Math.sign(outward[0] * -dz + outward[1] * dx || 1)
  const nz = dx * Math.sign(outward[0] * -dz + outward[1] * dx || 1)
  let beyond = 0
  let total = 0
  let maxDistance = 0
  const points = evidence.cells
  for (let i = 0; i < points.length; i += 2) {
    const px = points[i]! - from[0]
    const pz = points[i + 1]! - from[1]
    const t = px * dx + pz * dz
    if (t < 0 || t > length) continue
    const s = px * nx + pz * nz
    if (s > 8 || s < -8) continue
    total += 1
    if (s >= 0.4) {
      beyond += 1
      if (s > maxDistance) maxDistance = s
    }
  }
  return { cells: beyond, share: total ? beyond / total : 0, maxDistance: round(maxDistance, 2) }
}

/** The share of walked-path points outside an outline, ignoring a margin along its edges. */
export function pathOutside(
  path: Float32Array,
  polygon: ReadonlyArray<Vec2>,
  margin = 0.2,
): { outside: number; total: number } {
  let outside = 0
  const total = path.length / 2
  for (let i = 0; i < total; i += 1) {
    const point: Vec2 = [path[i * 2]!, path[i * 2 + 1]!]
    if (pointInPolygon(point, polygon)) continue
    let near = Number.POSITIVE_INFINITY
    for (let k = 0; k < polygon.length; k += 1) {
      near = Math.min(
        near,
        distanceToSegment(point, polygon[k]!, polygon[(k + 1) % polygon.length]!),
      )
    }
    if (near > margin) outside += 1
  }
  return { outside, total }
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const lengthSquared = dx * dx + dz * dz
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lengthSquared))
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t))
}

/** The least distance from the walked path to an edge segment, metres; infinity with no path. */
export function distanceFromPath(path: Float32Array, from: Vec2, to: Vec2): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < path.length; i += 2) {
    best = Math.min(best, distanceToSegment([path[i]!, path[i + 1]!], from, to))
  }
  return best
}

/**
 * The share of an edge, sampled every 0.15 m and looked at 0.4 m inside it, where depth saw floor.
 * Low where the floor was never seen up to the edge, so the edge may be glass or beyond the room.
 */
export function floorSeenAlongEdge(
  evidence: DepthWallEvidence,
  from: Vec2,
  to: Vec2,
  inward: Vec2,
): number {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  if (length === 0 || evidence.floorCells.length === 0) return 0
  const keys = new Set(evidence.floorCells)
  const norm = Math.hypot(inward[0], inward[1]) || 1
  let seen = 0
  let total = 0
  for (let distance = 0; distance <= length; distance += 0.15) {
    const x = from[0] + ((to[0] - from[0]) * distance) / length + (inward[0] / norm) * 0.4
    const z = from[1] + ((to[1] - from[1]) * distance) / length + (inward[1] / norm) * 0.4
    const ix = Math.floor(x / FLOOR_CELL)
    const iz = Math.floor(z / FLOOR_CELL)
    total += 1
    let hit = false
    for (let dx = -1; dx <= 1 && !hit; dx += 1) {
      for (let dz = -1; dz <= 1 && !hit; dz += 1) hit = keys.has(cellKey(ix + dx, iz + dz))
    }
    if (hit) seen += 1
  }
  return total ? seen / total : 0
}
