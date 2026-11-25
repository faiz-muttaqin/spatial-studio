'use client'

import { FLOORPLAN_VIEW_ROTATION_DEG, useScene } from '@pascal-app/core'
import { useLocale, usePascalI18n } from '@pascal-app/core/i18n'
import { useScanReview } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fitBounds,
  levelToScreen,
  type MapViewport,
  northScreenAngle,
  scaleBar,
  screenToLevel,
  zoomAt,
} from '@/lib/mapping/map-view-math'
import {
  cachedScanMap,
  ScanMapCancelled,
  ScanMapFailure,
  scanMapKey,
  startScanMap,
} from '@/lib/mapping/scan-map-client'
import type {
  MapNote,
  MapPhase,
  MapProgress,
  MapRefusalCode,
  ScanMapResult,
} from '@/lib/mapping/scan-map-loader'
import {
  cornerAt,
  edgeAt,
  edgeTone,
  moveCorner,
  type ReviewState,
  solveReview,
  startReview,
  TONE_COLOURS,
} from '@/lib/mapping/scan-review'
import {
  buildingRotationOf,
  type CaptureScan,
  captureScans,
  overlayBounds,
  type SceneOverlays,
  sceneOverlays,
} from '@/lib/mapping/scene-overlays'
import { ScanReviewPanel } from './scan-review-panel'

type Layer = 'top' | 'floor'
type Toggles = { map: boolean; walls: boolean; rooms: boolean; path: boolean; proposal: boolean }
type Built = { key: string; result: ScanMapResult }

const PHASE_STEPS: MapPhase[] = ['manifest', 'streams', 'frames', 'fuse', 'outline', 'map']
/** How far along the whole build each phase starts; `frames` is the long one. */
const PHASE_START: Record<MapPhase, number> = {
  manifest: 0,
  streams: 0.05,
  frames: 0.1,
  fuse: 0.7,
  outline: 0.85,
  map: 0.95,
}
/** A scan being dragged in 3D must not start a build per frame. */
const BUILD_DELAY_MILLIS = 400

export function progressFraction(progress: MapProgress): number {
  const start = PHASE_START[progress.phase]
  const index = PHASE_STEPS.indexOf(progress.phase)
  const next = index + 1 < PHASE_STEPS.length ? PHASE_START[PHASE_STEPS[index + 1]!] : 1
  const within = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0
  return start + (next - start) * within
}

/** The map as a canvas the draw loop can blit. */
function mapCanvas(result: ScanMapResult): HTMLCanvasElement {
  const { map } = result
  const canvas = document.createElement('canvas')
  canvas.width = map.width
  canvas.height = map.height
  const context = canvas.getContext('2d')!
  const pixels = new Uint8ClampedArray(map.rgba.length)
  for (let at = 0; at < map.width * map.height; at += 1) {
    const alpha = map.rgba[at * 4 + 3]!
    if (alpha === 255) {
      pixels.set(map.rgba.subarray(at * 4, at * 4 + 3), at * 4)
      pixels[at * 4 + 3] = 255
    } else if (alpha === 128) {
      // Surface seen, no photo colour: a neutral grey, not a real colour.
      pixels.set([96, 96, 96, 255], at * 4)
    }
  }
  context.putImageData(new ImageData(pixels, map.width, map.height), 0, 0)
  return canvas
}

type DrawState = {
  viewport: MapViewport
  result: ScanMapResult | null
  image: HTMLCanvasElement | null
  overlays: SceneOverlays
  opacity: number
  toggles: Toggles
  ratio: number
  review: ReviewDraw | null
}

/** The outline under review, as the draw loop needs it. */
type ReviewDraw = {
  proposal: Array<[number, number]>
  polygon: Array<[number, number]>
  colours: string[]
  labels: string[]
  selectedEdge: number | null
  dragCorner: number | null
  showGrid: boolean
}

function drawReview(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: DrawState,
  review: ReviewDraw,
): void {
  const { viewport } = state
  const to = (x: number, z: number) => levelToScreen(viewport, x, z)
  if (review.showGrid) {
    // A one metre grid over the visible area, as the plain background for the outline.
    context.strokeStyle = 'rgba(255, 255, 255, 0.12)'
    context.lineWidth = 1
    const width = canvas.width / state.ratio
    const height = canvas.height / state.ratio
    const corners = [
      screenToLevel(viewport, 0, 0),
      screenToLevel(viewport, width, 0),
      screenToLevel(viewport, 0, height),
      screenToLevel(viewport, width, height),
    ]
    const xs = corners.map((corner) => corner[0])
    const zs = corners.map((corner) => corner[1])
    const x0 = Math.floor(Math.min(...xs))
    const x1 = Math.ceil(Math.max(...xs))
    const z0 = Math.floor(Math.min(...zs))
    const z1 = Math.ceil(Math.max(...zs))
    if ((x1 - x0) * (z1 - z0) < 6000) {
      context.beginPath()
      for (let x = x0; x <= x1; x += 1) {
        const [ax, ay] = to(x, z0)
        const [bx, by] = to(x, z1)
        context.moveTo(ax, ay)
        context.lineTo(bx, by)
      }
      for (let z = z0; z <= z1; z += 1) {
        const [ax, ay] = to(x0, z)
        const [bx, by] = to(x1, z)
        context.moveTo(ax, ay)
        context.lineTo(bx, by)
      }
      context.stroke()
    }
  }
  const trace = (points: Array<[number, number]>) => {
    context.beginPath()
    points.forEach(([px, pz], index) => {
      const [sx, sy] = to(px, pz)
      if (index === 0) context.moveTo(sx, sy)
      else context.lineTo(sx, sy)
    })
    context.closePath()
  }
  // The proposal as it was, faint, so the correction can be seen.
  context.setLineDash([4, 4])
  context.strokeStyle = 'rgba(255, 255, 255, 0.4)'
  context.lineWidth = 1
  trace(review.proposal)
  context.stroke()
  context.setLineDash([])
  const n = review.polygon.length
  context.lineCap = 'round'
  context.lineWidth = 4
  for (let i = 0; i < n; i += 1) {
    const [ax, ay] = to(...review.polygon[i]!)
    const [bx, by] = to(...review.polygon[(i + 1) % n]!)
    context.strokeStyle = review.colours[i]!
    context.lineWidth = review.selectedEdge === i ? 7 : 4
    context.beginPath()
    context.moveTo(ax, ay)
    context.lineTo(bx, by)
    context.stroke()
  }
  context.font = '12px system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (let i = 0; i < n; i += 1) {
    const [ax, ay] = to(...review.polygon[i]!)
    const [bx, by] = to(...review.polygon[(i + 1) % n]!)
    const text = review.labels[i]!
    const width = context.measureText(text).width + 10
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    context.fillStyle = 'rgba(0, 0, 0, 0.75)'
    context.fillRect(mx - width / 2, my - 9, width, 18)
    context.fillStyle = 'white'
    context.fillText(text, mx, my)
  }
  review.polygon.forEach(([px, pz], index) => {
    const [sx, sy] = to(px, pz)
    context.beginPath()
    context.arc(sx, sy, review.dragCorner === index ? 8 : 6, 0, Math.PI * 2)
    context.fillStyle = 'white'
    context.fill()
    context.strokeStyle = 'rgba(0, 0, 0, 0.8)'
    context.lineWidth = 2
    context.stroke()
  })
}

function draw(canvas: HTMLCanvasElement, state: DrawState): void {
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(state.ratio, 0, 0, state.ratio, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  const { viewport, result, image, overlays, toggles } = state
  const to = (x: number, z: number) => levelToScreen(viewport, x, z)

  if (result && image && toggles.map) {
    // The picture is placed by the same turn as the vectors: translate, rotate, then scale.
    const radians = (viewport.rotationDeg * Math.PI) / 180
    const cell = result.map.metresPerPixel * viewport.scale
    const [ox, oy] = to(result.map.origin[0], result.map.origin[1])
    context.save()
    context.transform(
      state.ratio * Math.cos(radians),
      state.ratio * Math.sin(radians),
      -state.ratio * Math.sin(radians),
      state.ratio * Math.cos(radians),
      state.ratio * ox,
      state.ratio * oy,
    )
    context.globalAlpha = state.opacity
    context.imageSmoothingEnabled = true
    context.drawImage(image, 0, 0, image.width * cell, image.height * cell)
    context.restore()
  }
  if (toggles.rooms) {
    context.fillStyle = 'rgba(80, 160, 255, 0.14)'
    context.strokeStyle = 'rgba(80, 160, 255, 0.9)'
    context.lineWidth = 1.5
    for (const zone of overlays.zones) {
      context.beginPath()
      zone.polygon.forEach(([px, pz], index) => {
        const [sx, sy] = to(px, pz)
        if (index === 0) context.moveTo(sx, sy)
        else context.lineTo(sx, sy)
      })
      context.closePath()
      context.fill()
      context.stroke()
    }
  }
  if (toggles.walls) {
    context.strokeStyle = 'rgba(255, 214, 10, 0.95)'
    context.lineCap = 'butt'
    for (const wall of overlays.walls) {
      const [ax, ay] = to(wall.a[0], wall.a[1])
      const [bx, by] = to(wall.b[0], wall.b[1])
      context.lineWidth = Math.max(2, wall.thickness * viewport.scale)
      context.beginPath()
      context.moveTo(ax, ay)
      context.lineTo(bx, by)
      context.stroke()
    }
  }
  if (toggles.proposal && result?.proposal && result.proposal.length >= 2) {
    context.strokeStyle = 'rgb(255, 0, 255)'
    context.lineWidth = 2
    context.setLineDash([6, 4])
    context.beginPath()
    result.proposal.forEach(([px, pz], index) => {
      const [sx, sy] = to(px, pz)
      if (index === 0) context.moveTo(sx, sy)
      else context.lineTo(sx, sy)
    })
    context.closePath()
    context.stroke()
    context.setLineDash([])
  }
  if (state.review) drawReview(context, canvas, state, state.review)
  if (toggles.path && result && result.path.length > 1) {
    context.strokeStyle = 'rgba(80, 255, 160, 0.95)'
    context.lineWidth = 2
    context.beginPath()
    result.path.forEach(([px, pz], index) => {
      const [sx, sy] = to(px, pz)
      if (index === 0) context.moveTo(sx, sy)
      else context.lineTo(sx, sy)
    })
    context.stroke()
  }
}

const PHASE_LABELS = {
  manifest: { id: 'app.mapping.phase.manifest', message: 'Reading the scan manifest' },
  streams: { id: 'app.mapping.phase.streams', message: 'Reading the scan streams' },
  frames: { id: 'app.mapping.phase.frames', message: 'Reading photos and depth' },
  fuse: { id: 'app.mapping.phase.fuse', message: 'Fusing the coloured cloud' },
  outline: { id: 'app.mapping.phase.outline', message: 'Estimating the room outline' },
  map: { id: 'app.mapping.phase.map', message: 'Drawing the map' },
} as const

const REFUSAL_LABELS: Record<MapRefusalCode | 'failed', { id: string; message: string }> = {
  'manifest-unreadable': /* i18n */ {
    id: 'app.mapping.refusal.manifestUnreadable',
    message: 'The scan manifest could not be read.',
  },
  'manifest-invalid': /* i18n */ {
    id: 'app.mapping.refusal.manifestInvalid',
    message: 'The scan manifest does not match the capture contract.',
  },
  'no-depth': /* i18n */ {
    id: 'app.mapping.refusal.noDepth',
    message: 'This scan has no depth keyframes with photo keyframes.',
  },
  'no-frames': /* i18n */ {
    id: 'app.mapping.refusal.noFrames',
    message: 'No depth frame could be read with a tracked pose.',
  },
  'no-surface': /* i18n */ {
    id: 'app.mapping.refusal.noSurface',
    message: 'No surface was seen in two or more depth frames.',
  },
  'no-map': /* i18n */ {
    id: 'app.mapping.refusal.noMap',
    message: 'No points lie between the floor and the ceiling.',
  },
  timeout: /* i18n */ {
    id: 'app.mapping.refusal.timeout',
    message: 'Reading the scan took too long.',
  },
  failed: /* i18n */ {
    id: 'app.mapping.refusal.failed',
    message: 'Something went wrong while building it.',
  },
}

function noteText(note: MapNote, i18n: ReturnType<typeof usePascalI18n>): string {
  switch (note.code) {
    case 'frame-coordinates':
      return i18n._({
        id: 'app.mapping.note.frameCoordinates',
        message: '{kind}: its coordinate frame is not usable, so it is read as the capture world.',
        values: { kind: note.kind },
      })
    case 'time-budget-reading':
      return i18n._({
        id: 'app.mapping.note.timeBudgetReading',
        message: 'Reading stopped at the time budget; later keyframes were left out.',
      })
    case 'memory-budget':
      return i18n._({
        id: 'app.mapping.note.memoryBudget',
        message:
          'Reading stopped at the memory limit after {frames} frames; later keyframes were left out.',
        values: { frames: note.frames },
      })
    case 'photos-unused':
      return i18n._({
        id: 'app.mapping.note.photosUnused',
        message: 'Photos that could not be used: {count}. Their frames add shape but no colour.',
        values: { count: note.count },
      })
    case 'fuse-time-budget':
      return i18n._({
        id: 'app.mapping.note.fuseTimeBudget',
        message: 'Fusing stopped at the time budget after {frames} frames.',
        values: { frames: note.frames },
      })
    case 'outline-skipped':
      return i18n._({
        id: 'app.mapping.note.outlineSkipped',
        message: 'The room outline was skipped at the time budget.',
      })
    case 'outline-failed':
      return i18n._({
        id: 'app.mapping.note.outlineFailed',
        message: 'The room outline could not be computed, so none is available.',
      })
    case 'streams-unreadable':
      return i18n._({
        id: 'app.mapping.note.streamsUnreadable',
        message: 'Some scan streams could not be read; the technical details say which.',
      })
  }
}

export default function MappingView() {
  const i18n = usePascalI18n()
  const locale = useLocale()
  // Selectors return strings and numbers, so a store update that changes none of them (a wall
  // elsewhere, an item moving) does not render this view.
  const scansJson = useScene((state) => JSON.stringify(captureScans(state.nodes)))
  const scans = useMemo(() => JSON.parse(scansJson) as CaptureScan[], [scansJson])
  const activeLevelId = useViewer((state) => state.selection.levelId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const scan =
    scans.find((candidate) => candidate.id === selectedId) ??
    scans.find((candidate) => candidate.levelId === activeLevelId) ??
    scans[0] ??
    null
  const levelId = scan?.levelId ?? null
  const overlaysJson = useScene((state) => JSON.stringify(sceneOverlays(state.nodes, levelId)))
  const overlays = useMemo(() => JSON.parse(overlaysJson) as SceneOverlays, [overlaysJson])
  const buildingRotationY = useScene((state) => buildingRotationOf(state.nodes, levelId))
  const siteNorthRotation = useScene((state) => {
    for (const node of Object.values(state.nodes)) {
      if (node.type === 'site') return (node as { northRotation?: number }).northRotation ?? null
    }
    return null
  })

  // The 2D plan turns its scene by view rotation + its own user rotation - the building's turn.
  // The user rotation lives in the plan's component state and is not reachable from here.
  const rotationDeg = FLOORPLAN_VIEW_ROTATION_DEG - (buildingRotationY * 180) / Math.PI

  const [layer, setLayer] = useState<Layer>('top')
  const [opacity, setOpacity] = useState(1)
  const [toggles, setToggles] = useState<Toggles>({
    map: true,
    walls: true,
    rooms: true,
    path: false,
    proposal: false,
  })
  const [built, setBuilt] = useState<Built | null>(null)
  const [progress, setProgress] = useState<MapProgress | null>(null)
  const [failure, setFailure] = useState<MapRefusalCode | 'failed' | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const forceRef = useRef(false)

  const manifestUrl = scan?.manifestUrl ?? null
  const transformKey = scan ? JSON.stringify(scan.transform) : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: transformKey stands for the transform
  const request = useMemo(
    () => (scan ? { manifestUrl: scan.manifestUrl, transform: scan.transform, layer } : null),
    [manifestUrl, transformKey, layer],
  )
  const key = request ? scanMapKey(request) : null
  // A map made for another scan, layer or transform is never drawn while the next one loads.
  const result = built && built.key === key ? built.result : null

  useEffect(() => {
    if (!request || !key) {
      setProgress(null)
      return
    }
    const force = forceRef.current
    forceRef.current = false
    setFailure(null)
    if (!force) {
      const hit = cachedScanMap(request)
      if (hit) {
        setBuilt({ key, result: hit })
        setProgress(null)
        return
      }
    }
    let cancel = () => {}
    let cancelled = false
    const timer = window.setTimeout(
      () => {
        setProgress({ phase: 'manifest', done: 0, total: 1 })
        const job = startScanMap(request, (next) => setProgress(next), { force })
        cancel = job.cancel
        job.promise.then(
          (value) => {
            if (cancelled) return
            setBuilt({ key, result: value })
            setProgress(null)
          },
          (error: unknown) => {
            if (cancelled || error instanceof ScanMapCancelled) return
            setProgress(null)
            setFailure(error instanceof ScanMapFailure ? error.code : 'failed')
          },
        )
      },
      force ? 0 : BUILD_DELAY_MILLIS,
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      cancel()
    }
  }, [request, key, reloadToken])

  const rebuild = () => {
    forceRef.current = true
    setReloadToken((token) => token + 1)
  }

  const image = useMemo(() => (result ? mapCanvas(result) : null), [result])

  // Review mode: the proposed outline over the map, corrected by the person before walls are built.
  const [reviewing, setReviewing] = useState(false)
  const [reviewState, setReviewState] = useState<ReviewState | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
  const [dragCorner, setDragCorner] = useState<number | null>(null)
  const requestedScanId = useScanReview((review) => review.requestedScanId)
  const clearRequest = useScanReview((review) => review.clear)
  useEffect(() => {
    if (!requestedScanId) return
    if (scans.some((candidate) => candidate.id === requestedScanId)) {
      setSelectedId(requestedScanId)
      setReviewing(true)
    }
    clearRequest()
  }, [requestedScanId, scans, clearRequest])
  const proposalReview = result?.review ?? null
  // The state is keyed on the proposal it started from, so a rebuilt map starts a fresh review.
  useEffect(() => {
    setReviewState((current) => {
      if (!reviewing || !proposalReview) return null
      return current && current.proposal === proposalReview ? current : startReview(proposalReview)
    })
    setSelectedEdge(null)
  }, [reviewing, proposalReview])
  const solution = useMemo(() => (reviewState ? solveReview(reviewState) : null), [reviewState])
  const reviewDraw = useMemo<ReviewDraw | null>(() => {
    if (!(reviewState && solution)) return null
    const formatter = new Intl.NumberFormat(locale, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    })
    return {
      proposal: reviewState.proposal.polygon,
      polygon: solution.polygon,
      colours: solution.polygon.map((_, i) => TONE_COLOURS[edgeTone(reviewState, i)]),
      labels: solution.edges.map((edge) =>
        i18n._({
          id: 'app.review.metres',
          message: '{value} m',
          values: { value: formatter.format(edge.length) },
        }),
      ),
      selectedEdge,
      dragCorner,
      showGrid: !toggles.map || !result,
    }
  }, [reviewState, solution, selectedEdge, dragCorner, toggles.map, result, i18n, locale])

  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0, ratio: 1 })
  const viewportRef = useRef<MapViewport>({ offsetX: 0, offsetY: 0, scale: 50, rotationDeg: 0 })
  // Only the scale reaches React (for the scale bar); panning never re-renders.
  const [scale, setScale] = useState(50)
  const latest = useRef<Omit<DrawState, 'viewport'>>(null as never)
  latest.current = {
    result,
    image,
    overlays,
    opacity,
    toggles,
    ratio: size.ratio,
    review: reviewDraw,
  }
  const frame = useRef(0)

  const paint = useCallback(() => {
    frame.current = 0
    const canvas = canvasRef.current
    if (canvas && canvas.width > 0)
      draw(canvas, { ...latest.current, viewport: viewportRef.current })
  }, [])
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }, [paint])
  useEffect(
    () => () => {
      // Strict mode runs this cleanup and then the effects again: a stale id would block paints.
      cancelAnimationFrame(frame.current)
      frame.current = 0
    },
    [],
  )

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const measure = () =>
      setSize((current) => {
        const next = {
          width: wrapper.clientWidth,
          height: wrapper.clientHeight,
          ratio: window.devicePixelRatio || 1,
        }
        return next.width === current.width &&
          next.height === current.height &&
          next.ratio === current.ratio
          ? current
          : next
      })
    const observer = new ResizeObserver(measure)
    observer.observe(wrapper)
    measure()
    return () => observer.disconnect()
  }, [])

  // The backing store is resized only when the pane or the pixel ratio changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width) return
    canvas.width = Math.round(size.width * size.ratio)
    canvas.height = Math.round(size.height * size.ratio)
    schedule()
  }, [size, schedule])

  // biome-ignore lint/correctness/useExhaustiveDependencies: any drawn input repaints
  useEffect(() => {
    schedule()
  }, [result, image, overlays, opacity, toggles, reviewDraw, schedule])

  const fit = useCallback(() => {
    if (!size.width || !size.height) return
    const points: Array<[number, number]> = []
    if (result) {
      points.push(
        [result.map.origin[0], result.map.origin[1]],
        [
          result.map.origin[0] + result.map.width * result.map.metresPerPixel,
          result.map.origin[1] + result.map.height * result.map.metresPerPixel,
        ],
      )
    }
    for (const wall of overlays.walls) points.push(wall.a, wall.b)
    for (const zone of overlays.zones) points.push(...zone.polygon)
    if (reviewState) points.push(...reviewState.proposal.polygon)
    const bounds = overlayBounds(points)
    if (!bounds) return false
    viewportRef.current = fitBounds(bounds, size.width, size.height, rotationDeg)
    setScale(viewportRef.current.scale)
    schedule()
    return true
  }, [result, overlays, reviewState, size.width, size.height, rotationDeg, schedule])

  // Fit when a new map arrives, when the building's turn changes, and, while there is no map, when
  // the overlays first give something to fit to.
  const fitted = useRef<{ token: string; withBounds: boolean } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit reruns only for the token and size
  useEffect(() => {
    const token = `${built && built.key === key ? key : `none:${scan?.id}`}|${rotationDeg}`
    const previous = fitted.current
    if (previous && previous.token === token && previous.withBounds) return
    if (!size.width || !size.height) return
    const withBounds = fit() !== false
    fitted.current = { token, withBounds }
  }, [result, key, rotationDeg, size.width, size.height, overlays])

  const drag = useRef<{ x: number; y: number } | null>(null)
  const cornerDrag = useRef<number | null>(null)
  const levelPoint = (event: React.PointerEvent): [number, number] => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    return screenToLevel(viewportRef.current, event.clientX - rect.left, event.clientY - rect.top)
  }
  const onPointerDown = (event: React.PointerEvent) => {
    if (solution) {
      const point = levelPoint(event)
      const metresPerPixel = 1 / viewportRef.current.scale
      const corner = cornerAt(solution.polygon, point, 14 * metresPerPixel)
      if (corner !== null) {
        cornerDrag.current = corner
        setDragCorner(corner)
        setSelectedEdge(null)
        ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
        return
      }
      setSelectedEdge(edgeAt(solution.polygon, point, 10 * metresPerPixel))
    }
    drag.current = { x: event.clientX, y: event.clientY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const dragged = cornerDrag.current
    if (dragged !== null) {
      const point = levelPoint(event)
      setReviewState((current) => (current ? moveCorner(current, dragged, point) : current))
      return
    }
    const start = drag.current
    if (!start) return
    const view = viewportRef.current
    viewportRef.current = {
      ...view,
      offsetX: view.offsetX + event.clientX - start.x,
      offsetY: view.offsetY + event.clientY - start.y,
    }
    drag.current = { x: event.clientX, y: event.clientY }
    schedule()
  }
  const onPointerUp = () => {
    drag.current = null
    cornerDrag.current = null
    setDragCorner(null)
  }
  // A passive React wheel handler cannot stop the page scrolling, so attach it by hand.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = wrapper.getBoundingClientRect()
      const factor = Math.exp(-event.deltaY * 0.0015)
      viewportRef.current = zoomAt(
        viewportRef.current,
        event.clientX - rect.left,
        event.clientY - rect.top,
        factor,
      )
      setScale(viewportRef.current.scale)
      schedule()
    }
    wrapper.addEventListener('wheel', onWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel)
  }, [schedule])

  const bar = scaleBar(scale)
  const northAngle = result?.north ? northScreenAngle(result.north, rotationDeg) : null
  const toggle = (name: keyof Toggles) =>
    setToggles((current) => ({ ...current, [name]: !current[name] }))
  const toggleLabels: Record<keyof Toggles, string> = {
    map: i18n._({ id: 'app.mapping.toggle.map', message: 'Map' }),
    walls: i18n._({ id: 'app.mapping.toggle.walls', message: 'Walls' }),
    rooms: i18n._({ id: 'app.mapping.toggle.rooms', message: 'Rooms' }),
    path: i18n._({ id: 'app.mapping.toggle.path', message: 'Walked path' }),
    proposal: i18n._({ id: 'app.mapping.toggle.proposal', message: 'Room proposal' }),
  }
  const northTitle = result?.north
    ? [
        i18n._({ id: 'app.mapping.north.scan', message: 'Compass north from the scan.' }),
        result.northReference === 'magnetic'
          ? i18n._({
              id: 'app.mapping.north.magnetic',
              message: 'This is magnetic north, not true north.',
            })
          : null,
        siteNorthRotation !== null
          ? i18n._({
              id: 'app.mapping.north.site',
              message: 'The site north rotation is {degrees} degrees and is not shown here.',
              values: { degrees: Math.round((siteNorthRotation * 180) / Math.PI) },
            })
          : null,
      ]
        .filter(Boolean)
        .join(' ')
    : ''

  if (scans.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-sidebar p-6 text-center">
        <div className="max-w-xs">
          <p className="font-medium text-sidebar-foreground text-sm">
            {i18n._({ id: 'app.mapping.empty.title', message: 'No capture scans in this project' })}
          </p>
          <p className="mt-1 text-sidebar-foreground/50 text-xs">
            {i18n._({
              id: 'app.mapping.empty.body',
              message: 'Scan a room with a phone and attach it to see its top-down map here.',
            })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-sidebar-border border-b px-3 py-2 text-xs">
        {scans.length > 1 && (
          <select
            aria-label={i18n._({ id: 'app.mapping.scan', message: 'Scan' })}
            className="rounded bg-sidebar-accent px-2 py-1"
            onChange={(event) => setSelectedId(event.target.value)}
            value={scan?.id ?? ''}
          >
            {scans.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label={i18n._({ id: 'app.mapping.layer', message: 'Layer' })}
          className="rounded bg-sidebar-accent px-2 py-1"
          onChange={(event) => setLayer(event.target.value as Layer)}
          value={layer}
        >
          <option value="top">
            {i18n._({ id: 'app.mapping.layer.top', message: 'Top surfaces' })}
          </option>
          <option value="floor">
            {i18n._({ id: 'app.mapping.layer.floor', message: 'Floor only' })}
          </option>
        </select>
        <label className="flex items-center gap-2">
          <span>{i18n._({ id: 'app.mapping.opacity', message: 'Map opacity' })}</span>
          <input
            max={100}
            min={0}
            onChange={(event) => setOpacity(Number(event.target.value) / 100)}
            type="range"
            value={Math.round(opacity * 100)}
          />
        </label>
        {(Object.keys(toggles) as Array<keyof Toggles>).map((name) => (
          <label className="flex items-center gap-1" key={name}>
            <input checked={toggles[name]} onChange={() => toggle(name)} type="checkbox" />
            {toggleLabels[name]}
          </label>
        ))}
        <button className="rounded bg-sidebar-accent px-2 py-1" onClick={fit} type="button">
          {i18n._({ id: 'app.mapping.fit', message: 'Fit' })}
        </button>
        <button className="rounded bg-sidebar-accent px-2 py-1" onClick={rebuild} type="button">
          {i18n._({ id: 'app.mapping.rebuild', message: 'Rebuild' })}
        </button>
        <button
          aria-pressed={reviewing}
          className={`rounded px-2 py-1 ${reviewing ? 'bg-primary text-primary-foreground' : 'bg-sidebar-accent'}`}
          data-testid="scan-review-toggle"
          onClick={() => setReviewing((on) => !on)}
          type="button"
        >
          {i18n._({ id: 'app.review.open', message: 'Review scan' })}
        </button>
        {rotationDeg !== FLOORPLAN_VIEW_ROTATION_DEG && (
          <span className="text-sidebar-foreground/60">
            {i18n._({
              id: 'app.mapping.rotationHint',
              message:
                'Turned with the building, like the 2D plan. A turn set by hand in the 2D plan is not followed.',
            })}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-neutral-900 active:cursor-grabbing"
          data-testid="mapping-surface"
          onDoubleClick={fit}
          onPointerCancel={onPointerUp}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          ref={wrapperRef}
        >
          <canvas
            className="absolute inset-0 h-full w-full"
            ref={canvasRef}
            style={{ width: size.width, height: size.height }}
          />
          {progress && (
            <div className="absolute inset-x-6 top-4 rounded bg-black/70 p-3 text-xs">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span>{i18n._(PHASE_LABELS[progress.phase])}</span>
                <button className="rounded bg-white/10 px-2 py-0.5" onClick={rebuild} type="button">
                  {i18n._({ id: 'app.mapping.restart', message: 'Restart' })}
                </button>
              </div>
              <progress
                className="h-1.5 w-full"
                max={100}
                value={Math.round(progressFraction(progress) * 100)}
              />
            </div>
          )}
          {failure && !progress && (
            <div className="absolute inset-x-6 top-4 rounded bg-red-950/80 p-3 text-xs">
              {i18n._({
                id: 'app.mapping.failed',
                message: 'The map could not be built: {reason}',
                values: { reason: i18n._(REFUSAL_LABELS[failure]) },
              })}
            </div>
          )}
          <div className="pointer-events-none absolute bottom-3 left-3 text-white text-xs">
            <div className="h-1.5 border-white border-x border-b" style={{ width: bar.pixels }} />
            <div>
              {i18n._({
                id: 'app.mapping.scaleBar',
                message: '{metres} m',
                values: { metres: bar.metres },
              })}
            </div>
          </div>
          {northAngle !== null && (
            <div
              aria-label={i18n._({ id: 'app.mapping.north', message: 'North' })}
              className="absolute top-3 right-3 flex flex-col items-center text-white text-xs"
              role="img"
              title={northTitle}
            >
              <svg
                aria-hidden
                height="36"
                style={{ transform: `rotate(${northAngle}deg)` }}
                viewBox="-12 -18 24 36"
                width="24"
              >
                <path d="M0 -16 L7 12 L0 7 L-7 12 Z" fill="white" />
              </svg>
              <span>{i18n._({ id: 'app.mapping.northLetter', message: 'N' })}</span>
            </div>
          )}
          {result && (result.notes.length > 0 || result.diagnostics.length > 0) && !progress && (
            <details className="absolute right-3 bottom-3 max-w-sm rounded bg-black/70 p-2 text-white text-xs">
              <summary className="cursor-pointer">
                {i18n._({ id: 'app.mapping.notes', message: 'Notes' })}
              </summary>
              <ul className="mt-1 list-disc pl-4">
                {result.notes.map((note) => (
                  <li key={JSON.stringify(note)}>{noteText(note, i18n)}</li>
                ))}
              </ul>
              {result.diagnostics.length > 0 && (
                <>
                  <p className="mt-2 font-medium">
                    {i18n._({ id: 'app.mapping.details', message: 'Technical details' })}
                  </p>
                  <ul className="mt-1 list-disc pl-4 text-white/70" lang="en">
                    {result.diagnostics.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          )}
          {reviewing && !proposalReview && !progress && (
            <div className="absolute inset-x-6 bottom-12 rounded bg-black/70 p-3 text-white text-xs">
              {i18n._({
                id: 'app.review.noProposal',
                message:
                  'No outline could be proposed from this scan, so there is nothing to review yet.',
              })}
            </div>
          )}
        </div>
        {reviewing && scan && reviewState && solution && (
          <ScanReviewPanel
            onBuilt={() => setReviewing(false)}
            onChange={setReviewState}
            onClose={() => setReviewing(false)}
            onReset={() => setReviewState(proposalReview ? startReview(proposalReview) : null)}
            onSelectEdge={setSelectedEdge}
            scan={scan}
            selectedEdge={selectedEdge}
            solution={solution}
            state={reviewState}
          />
        )}
      </div>
    </div>
  )
}
