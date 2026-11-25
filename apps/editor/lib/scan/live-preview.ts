import {
  type CarvedOutline,
  carveRoomOutline,
  type DepthFrameInput,
  type LiveCoverageFrame,
  type LiveFrame,
} from '@pascal-app/core/capture'

/**
 * State behind the live scan preview. It folds the streamed frames into a coverage grid, the walked path
 * and a short ring of depth frames, and re-runs the capture library's free-space carving on that ring.
 * The recorded bundle stays the source of truth; this is a preview and nothing here is saved.
 */

/** A depth frame joins the ring when the camera moved or turned enough since the last one kept. */
const KEEP_DISTANCE_M = 0.15
const KEEP_ANGLE_COS = Math.cos((10 * Math.PI) / 180)
const MAX_RING = 24
const MAX_PATH_POINTS = 800
/** Rays cast per carve; keeps one pass to a few tens of milliseconds on a phone. */
const MAX_RAYS = 40_000

export type PreviewSnapshot = {
  /** Camera position on the floor plane and its heading, in the capture world. */
  camera: { x: number; z: number; headingX: number; headingZ: number } | null
  tracking: string
  coverage: { cellMetres: number; cells: Int32Array; percent: number | null } | null
  outline: Array<[number, number]> | null
  outlineNote: string | null
  depthFrames: number
  ringSize: number
}

export class LivePreviewState {
  private ring: DepthFrameInput[] = []
  private path: number[] = []
  private camera: PreviewSnapshot['camera'] = null
  private tracking = 'none'
  private coverage: LiveCoverageFrame | null = null
  private floorY: number | null = null
  private depthFrames = 0
  private dirty = false
  private outline: CarvedOutline | null = null

  ingest(frame: LiveFrame): void {
    switch (frame.type) {
      case 'pose':
        this.tracking = frame.tracking
        if (frame.tracking === 'tracking') this.setCamera(frame.pose)
        break
      case 'coverage':
        this.coverage = frame
        if (frame.floorY !== null) this.floorY = frame.floorY
        break
      case 'depth':
        this.depthFrames += 1
        this.setCamera(frame.pose)
        this.keepDepth(frame)
        break
      case 'planes':
        break
    }
  }

  private setCamera(pose: readonly number[]): void {
    const x = pose[12]!
    const z = pose[14]!
    // The camera looks along its -Z axis.
    this.camera = { x, z, headingX: -pose[8]!, headingZ: -pose[10]! }
    const n = this.path.length
    const last =
      n >= 2 ? Math.hypot(x - this.path[n - 2]!, z - this.path[n - 1]!) : Number.POSITIVE_INFINITY
    if (last >= 0.1) {
      if (n >= MAX_PATH_POINTS * 2) this.path.splice(0, 2)
      this.path.push(x, z)
    }
  }

  private keepDepth(frame: Extract<LiveFrame, { type: 'depth' }>): void {
    const previous = this.ring[this.ring.length - 1]
    if (previous) {
      const moved = Math.hypot(
        frame.pose[12]! - previous.pose[12]!,
        frame.pose[14]! - previous.pose[14]!,
      )
      const facing =
        frame.pose[8]! * previous.pose[8]! +
        frame.pose[9]! * previous.pose[9]! +
        frame.pose[10]! * previous.pose[10]!
      if (moved < KEEP_DISTANCE_M && facing > KEEP_ANGLE_COS) return
    }
    this.ring.push({
      id: `live-${frame.seq}`,
      width: frame.width,
      height: frame.height,
      intrinsics: frame.intrinsics,
      pose: frame.pose,
      depth: frame.depth,
      confidence: frame.confidence,
    })
    if (this.ring.length > MAX_RING) this.ring.shift()
    this.dirty = true
  }

  /** True when a depth frame joined the ring since the last [carve]. */
  get needsCarve(): boolean {
    return this.dirty && this.ring.length >= 4
  }

  /** Runs the carving on the ring. Takes tens of milliseconds, so the caller paces it. */
  carve(): CarvedOutline {
    this.dirty = false
    this.outline = carveRoomOutline(this.ring, {
      maxFrames: MAX_RING,
      maxRays: MAX_RAYS,
      floorY: this.floorY,
      path: new Float32Array(this.path),
    })
    return this.outline
  }

  snapshot(): PreviewSnapshot {
    return {
      camera: this.camera,
      tracking: this.tracking,
      coverage: this.coverage
        ? {
            cellMetres: this.coverage.cellMetres,
            cells: this.coverage.cells,
            percent: this.coverage.percent,
          }
        : null,
      outline: this.outline?.polygon ? this.outline.polygon.map(([x, z]) => [x, z]) : null,
      outlineNote: this.outline ? (this.outline.notes[0] ?? null) : null,
      depthFrames: this.depthFrames,
      ringSize: this.ring.length,
    }
  }

  reset(): void {
    this.ring = []
    this.path = []
    this.camera = null
    this.coverage = null
    this.floorY = null
    this.outline = null
    this.depthFrames = 0
    this.dirty = false
  }
}
