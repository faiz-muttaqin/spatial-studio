import {
  type BeyondEdge,
  type DepthFrameInput,
  estimateVerticalExtent,
  pointInPolygon,
} from './depth-walls'
import {
  captureDirectionToLevel,
  captureToLevel,
  IDENTITY_SCAN_TRANSFORM,
  type ScanTransform,
  type Vec2,
} from './plane-analysis'

/**
 * A room outline from free space, for scans where walls are plain or glass and no wall planes or
 * lines can be found.
 *
 * Method after Plan3D (`src/scan/extract.ts`: `run()`, `line()`, `cutNecks()`, `snapToWalls()`;
 * github.com/apiel/plan3d at commit 8d0692f4a496), re-implemented for raw depth with confidence:
 * every depth pixel is a ray that was empty from the camera up to the point it hit. Points in a
 * wall band above furniture mark occupied cells, and rays stop at those cells, so a stray reading
 * behind a wall cannot open it. The cells many rays crossed are the room. The mask is closed,
 * filled, cut at doorway necks, reduced to its largest component, traced, simplified and squared to
 * the dominant wall direction.
 *
 * What this cannot know: rays pass through clear glass and carve the space behind it. Carving is
 * bounded by the walked path (the phone stood in free space, and nothing is carved more than
 * `REACH` from where it was) and by the floor the depth saw (free space counts only near floor
 * points, and past clear glass the floor is usually not seen), and every edge reports how much free space continues past it and how
 * far the floor planes stop short of it. An edge with such a sign is flagged `likelyGlass` and
 * rated low. Nothing here is a measured wall: the outline is an inference from what the camera saw.
 *
 * Everything works in level coordinates, like `deriveDepthWalls`; the scan node's transform is
 * applied while unprojecting. Depth pixels use the contract's convention (integer pixel indices).
 */

export type CarvedEdge = {
  /** Edge `index` runs from polygon point `index` to the next, wrapping at the end. */
  index: number
  from: Vec2
  to: Vec2
  length: number
  /** Share of the edge, sampled every 0.1 m, with wall-band depth points within 0.2 m of it. */
  wallSupport: number
  /** Free space outside the polygon, 0.5 to 3 m past the edge. `share` is of samples along the edge. */
  beyond: BeyondEdge
  /** How far past the outline the nearest floor plane stops short of this edge, metres; null with no floor planes. */
  floorGap: number | null
  likelyGlass: boolean
  confidence: 'medium' | 'low'
  reason: string
  /** `axis` when squared to the dominant direction, `free` when left at its own angle. */
  snap: 'axis' | 'free'
}

export type CarvedOutline = {
  /** Corners in level coordinates, `[x, z]` in metres; null when no outline could be made. */
  polygon: Vec2[] | null
  edges: CarvedEdge[]
  vertical: {
    floorY: number | null
    ceilingY: number | null
    floorBasis: 'given' | 'depth-histogram' | 'percentile' | null
    ceilingBasis: 'given' | 'percentile' | null
  }
  stats: {
    framesUsed: number
    rays: number
    cellSize: number
    gridWidth: number
    gridHeight: number
    /** Wall-band points as a share of all points used. */
    wallBandShare: number
    /** Direction the walls were squared to, degrees modulo 90, or null when nothing was squared. */
    snapAngleDeg: number | null
    necksCut: boolean
    /** Camera and path positions, and how many of them lie in a part the doorway cut dropped. */
    positions: number
    droppedPositions: number
  }
  notes: string[]
}

export type CarveOptions = {
  transform?: ScanTransform
  /** Level-space heights in metres. Left null, they come from height percentiles. */
  floorY?: number | null
  ceilingY?: number | null
  /** Typed floor-to-ceiling height, used for the wall band when no ceiling was seen. */
  typedHeight?: number | null
  /** Walked path as x, z pairs in level coordinates. */
  path?: Float32Array | null
  /** Floor plane outlines in level coordinates, used to see where floor planes stop short of an edge. */
  floorPolygons?: ReadonlyArray<ReadonlyArray<Vec2>>
  maxFrames?: number
  /** Depth confidence, 0 to 255, below which a pixel is ignored; defaults to 32. */
  minConfidence?: number
  maxDepthM?: number
  /** Upper bound on depth pixels cast as rays, so runtime stays bounded. */
  maxRays?: number
}

const CELL = 0.05
const MAX_GRID = 500
/** Rays that must cross a cell before it counts as free: a stray reading cannot open a hole in a wall. */
const FREE_MIN = 3
/** Wall hits that make a cell stop rays. */
const OCC_MIN = 2
const MIN_DEPTH_M = 0.4
/** Free space is not carved further than this from where the phone was. */
const REACH = 5
const SNAP_DEG = 12
/** Diagonal sides shorter than this are noise, metres. */
const STUB = 0.35
/** A step this short between two sides running the same way is noise, metres. */
const JOG = 0.25
/** The voting resultant must be this share of the total length before anything is squared. */
const MIN_ORTHOGONAL_VOTE = 0.35
const FLOOR_BAND = 0.1
const WALL_BAND_FROM = 1.5
const MIN_WALL_SHARE = 0.05
/** Free space seen through a doorway joins the next room through a neck this narrow (half width, m). */
const NECK = 0.55
const NECK_SLACK = 1
const MIN_AREA_M2 = 2
const SUPPORT_RADIUS = 0.2
const BEYOND_MIN_CELLS = 15
const BEYOND_SHARE = 0.15
const BEYOND_NEAR = 0.5
const BEYOND_FAR = 3
const FLOOR_SHORT_GAP = 1
const GOOD_SUPPORT = 0.6
const PATH_FORCE_RADIUS = 0.3
/** Free space counts only within this distance of a floor point the depth saw, or of where the phone stood: past clear glass the floor is not seen. */
const FLOOR_REACH = 0.75
const UNSEEN_FLOOR_M2 = 0.6
const DEFAULT_MAX_RAYS = 500_000
/**
 * Confidence of 0 to 255 below which a depth pixel is ignored. Lower than the wall-line fit uses:
 * plain walls, the case carving is for, give low-confidence depth, and an empty ray stays a good
 * measure of free space where a single point is too noisy to fit a line to.
 */
const DEFAULT_MIN_CONFIDENCE = 32
const SIMPLIFY_TOLERANCE = 0.12
const OPEN_CELLS = 3

type Frame = {
  /** Camera position, level x and z. */
  cam: Vec2
  /** Level x, y, z triples of every depth point used. */
  points: Float32Array
}

type Grid = {
  W: number
  H: number
  cell: number
  minX: number
  minZ: number
}

type Pass = {
  polygon: Vec2[]
  grid: Grid
  occ: Uint16Array
  free: Uint8Array
  /** Camera and path cells that fell in a part the neck cut dropped. */
  droppedCameras: number
  positions: number
  necksCut: boolean
}

export function carveRoomOutline(
  frames: readonly DepthFrameInput[],
  options: CarveOptions = {},
): CarvedOutline {
  const transform = options.transform ?? IDENTITY_SCAN_TRANSFORM
  const notes: string[] = []
  const stats: CarvedOutline['stats'] = {
    framesUsed: 0,
    rays: 0,
    cellSize: CELL,
    gridWidth: 0,
    gridHeight: 0,
    wallBandShare: 0,
    snapAngleDeg: null,
    necksCut: false,
    positions: 0,
    droppedPositions: 0,
  }
  const vertical: CarvedOutline['vertical'] = {
    floorY: null,
    ceilingY: null,
    floorBasis: null,
    ceilingBasis: null,
  }
  const none = (reason: string): CarvedOutline => ({
    polygon: null,
    edges: [],
    vertical,
    stats,
    notes: [...notes, reason],
  })

  const prepared = unproject(frames, transform, options, stats)
  const used = prepared.frames
  const allY = prepared.heights
  if (allY.length < 200 || used.length === 0) {
    return none('Too few confident depth points to carve free space.')
  }
  allY.sort()
  const percentile = (share: number) =>
    allY[Math.min(allY.length - 1, Math.floor(allY.length * share))]!

  // Floor and ceiling by height percentiles, cross-checked with the given plane and the depth peak.
  const low = percentile(0.02)
  const high = percentile(0.98)
  const histogram = estimateVerticalExtent(frames, transform, options)
  let floorY: number
  if (options.floorY !== undefined && options.floorY !== null) {
    floorY = options.floorY
    vertical.floorBasis = 'given'
    if (Math.abs(low - floorY) > 0.25) {
      notes.push(
        `The lowest depth points (y ${round(low, 2)} m) are ${round(Math.abs(low - floorY), 2)} m from the floor level used (y ${round(floorY, 2)} m); the floor level may be wrong or there is a step.`,
      )
    }
  } else if (histogram.floorY !== null) {
    floorY = histogram.floorY
    vertical.floorBasis = 'depth-histogram'
    if (Math.abs(low - floorY) > 0.25) {
      notes.push(
        `The floor level (y ${round(floorY, 2)} m) is the strongest low peak in the depth heights; the 2nd height percentile (y ${round(low, 2)} m) is ${round(Math.abs(low - floorY), 2)} m away, so a step or an outlier is possible.`,
      )
    }
  } else {
    floorY = low
    vertical.floorBasis = 'percentile'
  }
  vertical.floorY = floorY
  let ceilingY: number | null = null
  if (options.ceilingY !== undefined && options.ceilingY !== null) {
    ceilingY = options.ceilingY
    vertical.ceilingBasis = 'given'
  } else if (high - floorY > 2) {
    ceilingY = high
    vertical.ceilingBasis = 'percentile'
  }
  vertical.ceilingY = ceilingY

  // The wall band sits above furniture: from 1.5 m up to just under the ceiling.
  let bandLo = floorY + WALL_BAND_FROM
  let bandHi =
    ceilingY !== null
      ? ceilingY - 0.15
      : options.typedHeight
        ? floorY + options.typedHeight - 0.15
        : floorY + 2.3
  const inBand = (y: number) => y >= bandLo && y <= bandHi
  let upper = 0
  for (const y of allY) if (inBand(y)) upper += 1
  if (upper < Math.max(300, allY.length * MIN_WALL_SHARE)) {
    bandLo = floorY + 0.4
    bandHi = Math.max(
      bandLo + 0.3,
      Math.min(floorY + 2, (ceilingY ?? Number.POSITIVE_INFINITY) - 0.3),
    )
    notes.push(
      'Few depth points sit high on the walls, so the wall band was widened to 0.4 m above the floor; furniture may pull walls inwards.',
    )
    upper = 0
    for (const y of allY) if (inBand(y)) upper += 1
  }
  stats.wallBandShare = round(upper / allY.length, 3)

  const bands = classify(used, floorY, ceilingY, bandLo, bandHi)
  const path = options.path ?? new Float32Array(0)

  // First pass finds which way the walls run; the second runs on the rotated cloud so walls follow
  // the grid, with the doorway necks cut.
  const first = carvePass(bands, path, 0, false)
  if (!first) return none('No free space could be carved from the depth points.')
  const firstVote = dominantDirection(first.polygon)
  const rotation = firstVote && firstVote.strength >= MIN_ORTHOGONAL_VOTE ? -firstVote.phi : 0
  const second = carvePass(bands, path, rotation, true) ?? first
  const grid = second.grid
  stats.cellSize = round(grid.cell, 3)
  stats.gridWidth = grid.W
  stats.gridHeight = grid.H
  stats.necksCut = second.necksCut
  stats.positions = second.positions
  stats.droppedPositions = second.droppedCameras
  if (second.droppedCameras > 0) {
    notes.push(
      `${second.droppedCameras} camera positions lie outside the outline: in a part cut off as a doorway side, or where no floor was seen. The phone walked there, so the outline may leave out part of the scanned space; check on site.`,
    )
  }

  const snapped = snapToWalls(second.polygon)
  const polygonInGrid = snapped?.corners ?? second.polygon
  if (snapped?.snapped)
    stats.snapAngleDeg = round((((((snapped.phi - rotation) * 180) / Math.PI) % 90) + 90) % 90, 1)
  if (polygonInGrid.length < 3)
    return none('The traced outline collapsed to fewer than three corners.')
  const area = Math.abs(shoelace(polygonInGrid))
  if (area < MIN_AREA_M2) {
    return none(
      `The carved free space is only ${round(area, 1)} m², too small to be a room outline.`,
    )
  }

  const edges = describeEdges(
    polygonInGrid,
    snapped?.axes ?? [],
    second,
    options.floorPolygons,
    rotation,
  )
  const polygon = polygonInGrid.map((point) => roundPoint(rotatePoint(point, -rotation)))
  edges.forEach((edge, index) => {
    edge.from = polygon[index]!
    edge.to = polygon[(index + 1) % polygon.length]!
    edge.length = round(Math.hypot(edge.to[0] - edge.from[0], edge.to[1] - edge.from[1]))
  })
  return { polygon, edges, vertical, stats, notes }
}

// ---------- unprojection ----------

function unproject(
  frames: readonly DepthFrameInput[],
  transform: ScanTransform,
  options: CarveOptions,
  stats: CarvedOutline['stats'],
): { frames: Frame[]; heights: Float32Array } {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const maxDepth = options.maxDepthM ?? 6
  const chosen = evenIndices(frames.length, options.maxFrames ?? 120)
  let pixels = 0
  for (const index of chosen) pixels += frames[index]!.width * frames[index]!.height
  const step = Math.max(1, Math.ceil(Math.sqrt(pixels / (options.maxRays ?? DEFAULT_MAX_RAYS))))
  const out: Frame[] = []
  const heights: number[] = []
  for (const index of chosen) {
    const frame = frames[index]!
    const { width, height, intrinsics, depth, pose } = frame
    if (depth.length < width * height || pose.length !== 16) continue
    const origin = captureToLevel(transform, [pose[12]!, pose[13]!, pose[14]!])
    const axes = [0, 1, 2].map((column) => {
      const axis = captureDirectionToLevel(transform, [
        pose[column * 4]!,
        pose[column * 4 + 1]!,
        pose[column * 4 + 2]!,
      ])
      return [axis[0] * transform.scale, axis[1] * transform.scale, axis[2] * transform.scale]
    }) as [number[], number[], number[]]
    const [a0, a1, a2] = axes
    const confidence =
      frame.confidence && frame.confidence.length >= width * height ? frame.confidence : null
    const points: number[] = []
    for (let v = 0; v < height; v += step) {
      for (let u = 0; u < width; u += step) {
        const pixel = v * width + u
        const millimetres = depth[pixel]!
        if (millimetres === 0) continue
        const d = millimetres / 1000
        if (d < MIN_DEPTH_M || d > maxDepth) continue
        if (confidence && confidence[pixel]! < minConfidence) continue
        // Official ARCore sample convention: integer pixel indices, no half-pixel offset.
        const x = ((u - intrinsics.cx) / intrinsics.fx) * d
        const y = ((intrinsics.cy - v) / intrinsics.fy) * d
        const z = -d
        const lx = origin[0] + a0[0]! * x + a1[0]! * y + a2[0]! * z
        const ly = origin[1] + a0[1]! * x + a1[1]! * y + a2[1]! * z
        const lz = origin[2] + a0[2]! * x + a1[2]! * y + a2[2]! * z
        points.push(lx, ly, lz)
        heights.push(ly)
      }
    }
    if (points.length === 0) continue
    out.push({ cam: [origin[0], origin[2]], points: Float32Array.from(points) })
    stats.framesUsed += 1
    stats.rays += points.length / 3
  }
  return { frames: out, heights: Float32Array.from(heights) }
}

type Banded = {
  cam: Vec2
  /** Wall-band hits, x and z pairs. */
  wall: Float32Array
  /** Other hits that only carve: x, z, and 2 for a floor hit, 1 for a ceiling hit, 0 otherwise (floor and ceiling hits are free themselves). */
  carve: Float32Array
}

function classify(
  frames: readonly Frame[],
  floorY: number,
  ceilingY: number | null,
  bandLo: number,
  bandHi: number,
): Banded[] {
  return frames.map((frame) => {
    const wall: number[] = []
    const carve: number[] = []
    const { points } = frame
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i]!
      const y = points[i + 1]!
      const z = points[i + 2]!
      if (y >= bandLo && y <= bandHi) wall.push(x, z)
      else if (y < floorY + FLOOR_BAND) carve.push(x, z, 2)
      else if (ceilingY !== null && y > ceilingY - FLOOR_BAND) carve.push(x, z, 1)
      else carve.push(x, z, 0)
    }
    return { cam: frame.cam, wall: Float32Array.from(wall), carve: Float32Array.from(carve) }
  })
}

// ---------- one carving pass ----------

/** One extraction at a grid rotation. `cutDoors` cuts off what was seen through doorways. */
function carvePass(
  bands: readonly Banded[],
  path: Float32Array,
  rotation: number,
  cutDoors: boolean,
): Pass | null {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const rx = (x: number, z: number) => x * cos - z * sin
  const rz = (x: number, z: number) => x * sin + z * cos

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const see = (x: number, z: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  let wallHits = 0
  const cams: Vec2[] = bands.map((band) => [
    rx(band.cam[0], band.cam[1]),
    rz(band.cam[0], band.cam[1]),
  ])
  for (let i = 0; i < path.length; i += 2)
    cams.push([rx(path[i]!, path[i + 1]!), rz(path[i]!, path[i + 1]!)])
  for (const [x, z] of cams) see(x, z)
  for (const band of bands) {
    wallHits += band.wall.length / 2
    for (let k = 0; k < band.wall.length; k += 2)
      see(rx(band.wall[k]!, band.wall[k + 1]!), rz(band.wall[k]!, band.wall[k + 1]!))
    for (let k = 0; k < band.carve.length; k += 3)
      see(rx(band.carve[k]!, band.carve[k + 1]!), rz(band.carve[k]!, band.carve[k + 1]!))
  }
  if (!Number.isFinite(minX) || wallHits === 0) return null

  const cell = Math.max(CELL, Math.max(maxX - minX, maxZ - minZ) / MAX_GRID)
  const W = Math.ceil((maxX - minX) / cell) + 3
  const H = Math.ceil((maxZ - minZ) / cell) + 3
  const grid: Grid = { W, H, cell, minX, minZ }
  const ix = (x: number) => Math.floor((x - minX) / cell) + 1
  const iz = (z: number) => Math.floor((z - minZ) / cell) + 1

  // Wall hits first, then carve free space along every ray, stopping at occupied cells.
  const occ = new Uint16Array(W * H)
  for (const band of bands) {
    for (let k = 0; k < band.wall.length; k += 2) {
      const at =
        iz(rz(band.wall[k]!, band.wall[k + 1]!)) * W + ix(rx(band.wall[k]!, band.wall[k + 1]!))
      if (occ[at]! < 65535) occ[at]! += 1
    }
  }
  const free = new Uint8Array(W * H)
  const floorSeen = new Uint8Array(W * H)
  const mark = (x: number, z: number) => {
    const at = z * W + x
    if (occ[at]! >= OCC_MIN) return false
    if (free[at]! < 255) free[at]! += 1
    return true
  }
  bands.forEach((band, index) => {
    const cx = ix(cams[index]![0])
    const cz = iz(cams[index]![1])
    for (let k = 0; k < band.wall.length; k += 2) {
      traceRay(
        cx,
        cz,
        ix(rx(band.wall[k]!, band.wall[k + 1]!)),
        iz(rz(band.wall[k]!, band.wall[k + 1]!)),
        mark,
      )
    }
    for (let k = 0; k < band.carve.length; k += 3) {
      const hx = ix(rx(band.carve[k]!, band.carve[k + 1]!))
      const hz = iz(rz(band.carve[k]!, band.carve[k + 1]!))
      if (traceRay(cx, cz, hx, hz, mark) && band.carve[k + 2]) {
        mark(hx, hz)
        if (band.carve[k + 2] === 2) floorSeen[hz * W + hx] = 1
      }
    }
  })

  // Where the phone stood is free space, and nothing is carved far from where it stood.
  const stood = new Uint8Array(W * H)
  const reach = new Uint8Array(W * H)
  const reachCells = Math.ceil(REACH / cell)
  const forceCells = Math.max(1, Math.round(PATH_FORCE_RADIUS / cell))
  for (const [x, z] of cams) {
    const cx = ix(x)
    const cz = iz(z)
    stamp(reach, W, H, cx, cz, reachCells)
    stamp(stood, W, H, cx, cz, forceCells)
  }

  const supported = dilate(floorSeen, W, H, Math.round(FLOOR_REACH / cell))
  let mask: Uint8Array = new Uint8Array(W * H)
  for (let i = 0; i < mask.length; i += 1) {
    const room = free[i]! >= FREE_MIN && !occ[i]
    mask[i] = reach[i] && (room || (stood[i] && occ[i]! < OCC_MIN)) ? 1 : 0
  }
  // Closing joins gaps in the free space, but must not bridge a thin wall: occupied cells stay out.
  mask = erode(dilate(mask, W, H, 2), W, H, 2)
  for (let i = 0; i < mask.length; i += 1) if (occ[i]! >= OCC_MIN) mask[i] = 0
  mask = fillHoles(mask, W, H)
  mask = dropUnseenFloor(mask, supported, stood, W, H, cell)
  // Opening drops spurs thinner than about 0.3 m, which are noise along a wall, not part of a room.
  mask = dilate(erode(mask, W, H, OPEN_CELLS), W, H, OPEN_CELLS)
  const camCells = cams.map(([x, z]) => iz(z) * W + ix(x))
  let droppedCameras = 0
  let necksCut = false
  if (cutDoors) {
    const cut = cutNecks(mask, W, H, Math.round(NECK / cell), camCells)
    necksCut = cut.cut
    mask = cut.mask
  }
  mask = largestComponent(mask, W, H)
  if (cutDoors) {
    for (const c of camCells) if (!mask[c]) droppedCameras += 1
  }

  const loop = traceOutline(mask, W, H)
  if (!loop || loop.length < 4) return null
  const metres: Vec2[] = loop.map(([vx, vz]) => [minX + (vx - 1) * cell, minZ + (vz - 1) * cell])
  return {
    polygon: simplifyClosed(metres, SIMPLIFY_TOLERANCE),
    grid,
    occ,
    free,
    droppedCameras,
    positions: camCells.length,
    necksCut,
  }
}

/**
 * Free space with no floor seen near it is where rays passed through clear glass, or into a side
 * the phone never looked at. Patches of it smaller than `UNSEEN_FLOOR_M2` (under a table, say) stay;
 * larger ones are dropped, after hole filling so the fill cannot bring them back.
 */
function dropUnseenFloor(
  mask: Uint8Array,
  supported: Uint8Array,
  stood: Uint8Array,
  W: number,
  H: number,
  cell: number,
): Uint8Array {
  const unseen = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i += 1) unseen[i] = mask[i] && !supported[i] && !stood[i] ? 1 : 0
  const { label, sizes } = components(unseen, W, H)
  const limit = UNSEEN_FLOOR_M2 / (cell * cell)
  const out = Uint8Array.from(mask)
  for (let i = 0; i < out.length; i += 1) if (label[i] && sizes[label[i]!]! > limit) out[i] = 0
  return out
}

/** Fills a square of `radius` cells around a cell. */
function stamp(target: Uint8Array, W: number, H: number, cx: number, cz: number, radius: number) {
  for (let z = Math.max(0, cz - radius); z <= Math.min(H - 1, cz + radius); z += 1) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(W - 1, cx + radius); x += 1) {
      if ((x - cx) ** 2 + (z - cz) ** 2 <= radius * radius) target[z * W + x] = 1
    }
  }
}

/** Bresenham line from (x0, z0) up to but not including (x1, z1); false when `visit` refuses a cell. */
function traceRay(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  visit: (x: number, z: number) => boolean,
): boolean {
  const dx = Math.abs(x1 - x0)
  const dz = Math.abs(z1 - z0)
  const sx = x0 < x1 ? 1 : -1
  const sz = z0 < z1 ? 1 : -1
  let err = dx - dz
  let x = x0
  let z = z0
  while (x !== x1 || z !== z1) {
    if (!visit(x, z)) return false
    const e2 = 2 * err
    if (e2 > -dz) {
      err -= dz
      x += sx
    }
    if (e2 < dx) {
      err += dx
      z += sz
    }
  }
  return true
}

// ---------- mask operations ----------

function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return morph(mask, W, H, r, true)
}
function erode(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return morph(mask, W, H, r, false)
}

/** Square-kernel dilate or erode, as a horizontal then a vertical pass. */
function morph(mask: Uint8Array, W: number, H: number, r: number, grow: boolean): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const dst = new Uint8Array(src.length)
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let hit = grow ? 0 : 1
        for (let d = -r; d <= r; d += 1) {
          const nx = horizontal ? x + d : x
          const ny = horizontal ? y : y + d
          const value = nx < 0 || ny < 0 || nx >= W || ny >= H ? 0 : src[ny * W + nx]!
          if (grow && value) {
            hit = 1
            break
          }
          if (!grow && !value) {
            hit = 0
            break
          }
        }
        dst[y * W + x] = hit
      }
    }
    return dst
  }
  return pass(pass(mask, true), false)
}

/** Cells not reachable from the border without crossing the mask become part of it. */
function fillHoles(mask: Uint8Array, W: number, H: number): Uint8Array {
  const outside = new Uint8Array(mask.length)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const at = y * W + x
    if (!mask[at] && !outside[at]) {
      outside[at] = 1
      stack.push(at)
    }
  }
  for (let x = 0; x < W; x += 1) {
    push(x, 0)
    push(x, H - 1)
  }
  for (let y = 0; y < H; y += 1) {
    push(0, y)
    push(W - 1, y)
  }
  while (stack.length) {
    const at = stack.pop()!
    const x = at % W
    const y = (at - x) / W
    if (x > 0) push(x - 1, y)
    if (x < W - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < H - 1) push(x, y + 1)
  }
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i += 1) out[i] = outside[i] ? 0 : 1
  return out
}

/**
 * Rays through an open door carve the next room too, joined to this one through a narrow neck.
 * Shrinking the free space by `r` cells breaks such necks; the part holding most camera positions is
 * kept and grown back inside the original free space. A room too narrow to survive the shrinking is
 * left as it was.
 */
function cutNecks(
  mask: Uint8Array,
  W: number,
  H: number,
  r: number,
  cams: readonly number[],
): { mask: Uint8Array; cut: boolean } {
  const core = erode(mask, W, H, r)
  const { label, sizes } = components(core, W, H)
  const votes = new Map<number, number>()
  for (const c of cams) {
    const l = label[c]!
    if (l) votes.set(l, (votes.get(l) ?? 0) + 1)
  }
  let keep = 0
  for (const [l, v] of votes) {
    if (!keep || v > votes.get(keep)! || (v === votes.get(keep) && sizes[l]! > sizes[keep]!))
      keep = l
  }
  if (!keep) keep = sizes.reduce((best, size, l) => (size > (sizes[best] ?? 0) ? l : best), 0)
  if (!keep) return { mask, cut: false }
  const piece = new Uint8Array(mask.length)
  let pieces = 0
  for (let l = 1; l < sizes.length; l += 1) if (sizes[l]! > 0) pieces += 1
  for (let i = 0; i < mask.length; i += 1) piece[i] = label[i] === keep ? 1 : 0
  // Grown back a little further than it was shrunk: the edge along a wall is rough by a cell or two.
  const grown = dilate(piece, W, H, r + NECK_SLACK)
  for (let i = 0; i < mask.length; i += 1) grown[i]! &= mask[i]!
  return { mask: grown, cut: pieces > 1 }
}

/** 4-connected components: a label per cell (0 for empty) and each label's size. */
function components(
  mask: Uint8Array,
  W: number,
  H: number,
): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(mask.length)
  const sizes = [0]
  let next = 0
  for (let s = 0; s < mask.length; s += 1) {
    if (!mask[s] || label[s]) continue
    next += 1
    let size = 0
    const stack = [s]
    label[s] = next
    while (stack.length) {
      const at = stack.pop()!
      size += 1
      const x = at % W
      const y = (at - x) / W
      const neighbours = [
        x > 0 ? at - 1 : -1,
        x < W - 1 ? at + 1 : -1,
        y > 0 ? at - W : -1,
        y < H - 1 ? at + W : -1,
      ]
      for (const j of neighbours) {
        if (j >= 0 && mask[j] && !label[j]) {
          label[j] = next
          stack.push(j)
        }
      }
    }
    sizes.push(size)
  }
  return { label, sizes }
}

function largestComponent(mask: Uint8Array, W: number, H: number): Uint8Array {
  const { label, sizes } = components(mask, W, H)
  const best = sizes.reduce((b, size, l) => (size > sizes[b]! ? l : b), 0)
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i += 1) out[i] = label[i] === best && best > 0 ? 1 : 0
  return out
}

/** Outer boundary of the mask as grid-corner vertices, straight runs merged. */
function traceOutline(mask: Uint8Array, W: number, H: number): Array<[number, number]> | null {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1
  const key = (x: number, y: number) => y * (W + 1) + x
  const edges = new Map<number, Array<[number, number]>>()
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0)
    const list = edges.get(k)
    if (list) list.push([x1, y1])
    else edges.set(k, [[x1, y1]])
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (!mask[y * W + x]) continue
      if (!on(x, y - 1)) add(x, y, x + 1, y)
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1)
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1)
      if (!on(x - 1, y)) add(x, y + 1, x, y)
    }
  }
  let best: Array<[number, number]> | null = null
  let bestArea = 0
  for (const [startKey, ends] of edges) {
    while (ends.length) {
      const sx = startKey % (W + 1)
      const sy = (startKey - sx) / (W + 1)
      const loop: Array<[number, number]> = [[sx, sy]]
      let [cx, cy] = ends.pop()!
      let guard = 0
      while ((cx !== sx || cy !== sy) && guard++ < 4 * W * H) {
        loop.push([cx, cy])
        const list = edges.get(key(cx, cy))
        if (!list?.length) break
        ;[cx, cy] = list.pop()!
      }
      const area = Math.abs(shoelace(loop.map(([x, y]): Vec2 => [x, y])))
      if (area > bestArea) {
        bestArea = area
        best = loop
      }
    }
  }
  if (!best) return null
  const out: Array<[number, number]> = []
  for (let i = 0; i < best.length; i += 1) {
    const a = best[(i + best.length - 1) % best.length]!
    const b = best[i]!
    const c = best[(i + 1) % best.length]!
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (cross !== 0) out.push(b)
  }
  return out
}

// ---------- polygon helpers ----------

function shoelace(points: readonly Vec2[]): number {
  let sum = 0
  points.forEach(([x1, z1], index) => {
    const [x2, z2] = points[(index + 1) % points.length]!
    sum += x1 * z2 - x2 * z1
  })
  return sum / 2
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const l2 = dx * dx + dz * dz || 1
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz))
}

/** Douglas-Peucker on an open run. */
function douglasPeucker(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return points
  const a = points[0]!
  const b = points[points.length - 1]!
  let worst = -1
  let at = 0
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = distToSegment(points[i]!, a, b)
    if (d > worst) {
      worst = d
      at = i
    }
  }
  if (worst <= tolerance) return [a, b]
  return [
    ...douglasPeucker(points.slice(0, at + 1), tolerance).slice(0, -1),
    ...douglasPeucker(points.slice(at), tolerance),
  ]
}

/** Douglas-Peucker on a closed loop, anchored at the vertex furthest from the first. */
function simplifyClosed(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 4) return points
  let far = 1
  let farDistance = 0
  for (let i = 1; i < points.length; i += 1) {
    const d = Math.hypot(points[i]![0] - points[0]![0], points[i]![1] - points[0]![1])
    if (d > farDistance) {
      farDistance = d
      far = i
    }
  }
  const first = douglasPeucker(points.slice(0, far + 1), tolerance)
  const second = douglasPeucker([...points.slice(far), points[0]!], tolerance)
  return [...first.slice(0, -1), ...second.slice(0, -1)]
}

/** Dominant wall direction modulo 90 degrees by length-weighted 4θ voting, and how strong the vote is. */
function dominantDirection(polygon: readonly Vec2[]): { phi: number; strength: number } | null {
  let sx = 0
  let sy = 0
  let total = 0
  polygon.forEach(([x1, z1], index) => {
    const [x2, z2] = polygon[(index + 1) % polygon.length]!
    const length = Math.hypot(x2 - x1, z2 - z1)
    const angle = Math.atan2(z2 - z1, x2 - x1)
    sx += Math.cos(4 * angle) * length
    sy += Math.sin(4 * angle) * length
    total += length
  })
  if (total === 0) return null
  return { phi: Math.atan2(sy, sx) / 4, strength: Math.hypot(sx, sy) / total }
}

type Side = { a: Vec2; b: Vec2; axis: 'h' | 'v' | 'free'; at: number }

/**
 * Squares the outline to its dominant direction (the Plan3D `snapToWalls` method): the outline is
 * turned by the dominant direction, sides within `SNAP_DEG` of an axis become exactly axis aligned,
 * short diagonal stubs and tiny jogs are dropped, neighbours on one axis merge, and the sides are
 * re-intersected. Sides clearly off the axes keep their own angle. With no clear orthogonal vote
 * (a hexagonal room, say) nothing is squared. Corners come back in the input frame.
 */
function snapToWalls(
  polygon: readonly Vec2[],
): { corners: Vec2[]; phi: number; snapped: boolean; axes: Array<'axis' | 'free'> } | null {
  if (polygon.length < 3) return null
  const vote = dominantDirection(polygon)
  const free = (): {
    corners: Vec2[]
    phi: number
    snapped: boolean
    axes: Array<'axis' | 'free'>
  } => ({
    corners: [...polygon],
    phi: 0,
    snapped: false,
    axes: polygon.map(() => 'free'),
  })
  if (!vote || vote.strength < MIN_ORTHOGONAL_VOTE) return free()
  const phi = vote.phi
  const turn = (p: Vec2, angle: number): Vec2 => rotatePoint(p, angle)
  const points = polygon.map((p) => turn(p, -phi))
  const tolerance = Math.tan((SNAP_DEG * Math.PI) / 180)
  const sides: Side[] = points.map((a, i) => {
    const b = points[(i + 1) % points.length]!
    const dx = Math.abs(b[0] - a[0])
    const dz = Math.abs(b[1] - a[1])
    if (dz <= dx * tolerance) return { a, b, axis: 'h', at: (a[1] + b[1]) / 2 }
    if (dx <= dz * tolerance) return { a, b, axis: 'v', at: (a[0] + b[0]) / 2 }
    return { a, b, axis: 'free', at: 0 }
  })
  const length = (side: Side) => Math.hypot(side.b[0] - side.a[0], side.b[1] - side.a[1])
  let changed = true
  while (changed && sides.length > 3) {
    changed = false
    const stub = sides.findIndex((side) => side.axis === 'free' && length(side) < STUB)
    if (stub >= 0) {
      sides.splice(stub, 1)
      changed = true
      continue
    }
    const jog = sides.findIndex((side, i) => {
      const prev = sides[(i + sides.length - 1) % sides.length]!
      const next = sides[(i + 1) % sides.length]!
      return (
        side.axis !== 'free' &&
        length(side) < JOG &&
        prev.axis === next.axis &&
        prev.axis !== 'free' &&
        prev.axis !== side.axis
      )
    })
    if (jog >= 0) {
      sides.splice(jog, 1)
      changed = true
      continue
    }
    for (let i = 0; i < sides.length; i += 1) {
      const a = sides[i]!
      const b = sides[(i + 1) % sides.length]!
      if (a.axis === 'free' || a.axis !== b.axis) continue
      const total = length(a) + length(b)
      const merged: Side = {
        a: a.a,
        b: b.b,
        axis: a.axis,
        at: (a.at * length(a) + b.at * length(b)) / total,
      }
      if (i + 1 < sides.length) sides.splice(i, 2, merged)
      else {
        sides.splice(i, 1)
        sides[0] = { ...merged, b: sides[0]!.b }
      }
      changed = true
      break
    }
  }
  if (sides.length < 3) return free()
  const lineOf = (s: Side) =>
    s.axis === 'h'
      ? { p: [0, s.at] as Vec2, d: [1, 0] as Vec2 }
      : s.axis === 'v'
        ? { p: [s.at, 0] as Vec2, d: [0, 1] as Vec2 }
        : { p: s.a, d: [s.b[0] - s.a[0], s.b[1] - s.a[1]] as Vec2 }
  const corners: Vec2[] = sides.map((cur, i) => {
    const prev = sides[(i + sides.length - 1) % sides.length]!
    return intersectLines(lineOf(prev), lineOf(cur)) ?? cur.a
  })
  // Turn back into the input frame.
  return {
    corners: corners.map((p) => turn(p, phi)),
    phi,
    snapped: sides.some((side) => side.axis !== 'free'),
    axes: sides.map((side) => (side.axis === 'free' ? 'free' : 'axis')),
  }
}

function intersectLines(l1: { p: Vec2; d: Vec2 }, l2: { p: Vec2; d: Vec2 }): Vec2 | null {
  const cross = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0]
  if (Math.abs(cross) < 1e-6 * Math.hypot(l1.d[0], l1.d[1]) * Math.hypot(l2.d[0], l2.d[1]))
    return null
  const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / cross
  return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t]
}

function rotatePoint(p: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}

// ---------- edges ----------

/**
 * Evidence per edge, measured on the pass grid (the polygon is in that frame). Wall support is the
 * share of the edge with wall-band points nearby. Free space past the edge, outside the polygon, and
 * floor planes that stop short of the edge are the signs of clear glass or an open side.
 */
function describeEdges(
  polygon: readonly Vec2[],
  axes: ReadonlyArray<'axis' | 'free'>,
  pass: Pass,
  floorPolygons: CarveOptions['floorPolygons'],
  rotation: number,
): CarvedEdge[] {
  const { W, H, cell, minX, minZ } = pass.grid
  const cellAt = (x: number, z: number): number => {
    const cx = Math.floor((x - minX) / cell) + 1
    const cz = Math.floor((z - minZ) / cell) + 1
    return cx < 0 || cz < 0 || cx >= W || cz >= H ? -1 : cz * W + cx
  }
  // Floor planes are in level coordinates; the polygon is in the rotated frame.
  const floors = (floorPolygons ?? []).map((ring) => ring.map((p) => rotatePoint(p, rotation)))
  return polygon.map((from, index): CarvedEdge => {
    const to = polygon[(index + 1) % polygon.length]!
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    const ux = length > 0 ? (to[0] - from[0]) / length : 1
    const uz = length > 0 ? (to[1] - from[1]) / length : 0
    let nx = -uz
    let nz = ux
    const mid: Vec2 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
    if (pointInPolygon([mid[0] + nx * 0.2, mid[1] + nz * 0.2], polygon)) {
      nx = -nx
      nz = -nz
    }
    const samples = Math.max(1, Math.floor(length / 0.1))
    let supported = 0
    let withBeyond = 0
    let beyondCells = 0
    let beyondMax = 0
    let farFromFloor = 0
    let worstFloorGap = 0
    for (let k = 0; k < samples; k += 1) {
      const t = ((k + 0.5) / samples) * length
      const px = from[0] + ux * t
      const pz = from[1] + uz * t
      let near = false
      for (let o = -SUPPORT_RADIUS; o <= SUPPORT_RADIUS + 1e-9 && !near; o += cell) {
        const at = cellAt(px + nx * o, pz + nz * o)
        if (at >= 0 && pass.occ[at]! >= OCC_MIN) near = true
      }
      if (near) supported += 1
      if (k % 2 === 0) {
        let hit = false
        for (let d = BEYOND_NEAR; d <= BEYOND_FAR; d += 0.1) {
          const qx = px + nx * d
          const qz = pz + nz * d
          if (pointInPolygon([qx, qz], polygon)) continue
          const at = cellAt(qx, qz)
          if (at >= 0 && pass.free[at]! >= FREE_MIN && pass.occ[at]! < OCC_MIN) {
            hit = true
            beyondCells += 1
            beyondMax = Math.max(beyondMax, d)
          }
        }
        if (hit) withBeyond += 1
      }
      if (floors.length > 0) {
        const gap = floorGapAt([px - nx * 0.3, pz - nz * 0.3], floors)
        worstFloorGap = Math.max(worstFloorGap, gap)
        if (gap >= FLOOR_SHORT_GAP) farFromFloor += 1
      }
    }
    const probes = Math.max(1, Math.ceil(samples / 2))
    const beyond: BeyondEdge = {
      cells: beyondCells,
      share: round(withBeyond / probes, 3),
      maxDistance: round(beyondMax, 2),
    }
    const wallSupport = round(supported / samples, 3)
    const floorGap = floors.length > 0 ? round(worstFloorGap, 2) : null
    const freeBeyond = beyond.cells >= BEYOND_MIN_CELLS && beyond.share >= BEYOND_SHARE
    const floorShort = floors.length > 0 && farFromFloor / samples >= 0.5
    const likelyGlass = freeBeyond || floorShort
    const reasons: string[] = []
    if (freeBeyond) {
      reasons.push(
        `Free space continues up to ${beyond.maxDistance} m past this edge: clear glass, or an open side such as a doorway.`,
      )
    }
    if (floorShort) {
      reasons.push(
        `The nearest floor plane stops about ${floorGap} m short of this edge, so glass or space beyond the room cannot be ruled out.`,
      )
    }
    if (wallSupport < 0.3) {
      reasons.push(
        `Few wall points lie along it (${Math.round(wallSupport * 100)}% of its length); it is where the camera's view ended, not a seen wall.`,
      )
    } else if (wallSupport < GOOD_SUPPORT) {
      reasons.push(`Wall points lie along ${Math.round(wallSupport * 100)}% of its length.`)
    }
    const confident = !likelyGlass && wallSupport >= GOOD_SUPPORT
    return {
      index,
      from,
      to,
      length: round(length),
      wallSupport,
      beyond,
      floorGap,
      likelyGlass,
      confidence: confident ? 'medium' : 'low',
      reason:
        reasons.length > 0
          ? reasons.join(' ')
          : `The free space the camera's rays crossed ends here, with wall points along ${Math.round(wallSupport * 100)}% of the edge; an inference, not a measured wall.`,
      snap: axes[index] ?? 'free',
    }
  })
}

/** Distance from a point to the nearest floor plane ring, 0 when inside one. */
function floorGapAt(point: Vec2, rings: ReadonlyArray<ReadonlyArray<Vec2>>): number {
  let best = Number.POSITIVE_INFINITY
  for (const ring of rings) {
    if (ring.length < 3) continue
    if (pointInPolygon(point, ring)) return 0
    for (let i = 0; i < ring.length; i += 1) {
      best = Math.min(best, distToSegment(point, ring[i]!, ring[(i + 1) % ring.length]!))
    }
  }
  return Number.isFinite(best) ? best : 0
}

function evenIndices(count: number, wanted: number): number[] {
  if (count <= wanted) return Array.from({ length: count }, (_, i) => i)
  return Array.from({ length: wanted }, (_, i) => Math.floor((i * count) / wanted))
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function roundPoint(point: Vec2): Vec2 {
  return [round(point[0]), round(point[1])]
}
