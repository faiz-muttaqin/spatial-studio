'use client'

import { useScene } from '@pascal-app/core'
import { usePascalI18n } from '@pascal-app/core/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fitBounds,
  levelToScreen,
  type MapViewport,
  northScreenAngle,
  scaleBar,
  zoomAt,
} from '@/lib/mapping/map-view-math'
import { ScanMapCancelled, startScanMap } from '@/lib/mapping/scan-map-client'
import type { MapPhase, MapProgress, ScanMapResult } from '@/lib/mapping/scan-map-loader'
import {
  captureScans,
  overlayBounds,
  type SceneOverlays,
  sceneOverlays,
} from '@/lib/mapping/scene-overlays'

type Layer = 'top' | 'floor'
type Toggles = { map: boolean; walls: boolean; rooms: boolean; path: boolean; proposal: boolean }

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

export function progressFraction(progress: MapProgress): number {
  const start = PHASE_START[progress.phase]
  const index = PHASE_STEPS.indexOf(progress.phase)
  const next = index + 1 < PHASE_STEPS.length ? PHASE_START[PHASE_STEPS[index + 1]!] : 1
  const within = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0
  return start + (next - start) * within
}

/** The map as an ImageBitmap-free canvas the draw loop can blit. */
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
}

function draw(canvas: HTMLCanvasElement, state: DrawState): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const ratio = window.devicePixelRatio || 1
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  const { viewport, result, image, overlays, toggles } = state
  const to = (x: number, z: number) => levelToScreen(viewport, x, z)

  if (result && image && toggles.map) {
    const [x, z] = to(result.map.origin[0], result.map.origin[1])
    const size = viewport.scale * result.map.metresPerPixel
    context.globalAlpha = state.opacity
    context.imageSmoothingEnabled = true
    context.drawImage(image, x, z, image.width * size, image.height * size)
    context.globalAlpha = 1
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

export default function MappingView() {
  const i18n = usePascalI18n()
  const nodes = useScene((state) => state.nodes)
  const scans = useMemo(() => captureScans(nodes), [nodes])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const scan = scans.find((candidate) => candidate.id === selectedId) ?? scans[0] ?? null
  const [layer, setLayer] = useState<Layer>('top')
  const [opacity, setOpacity] = useState(1)
  const [toggles, setToggles] = useState<Toggles>({
    map: true,
    walls: true,
    rooms: true,
    path: false,
    proposal: false,
  })
  const [result, setResult] = useState<ScanMapResult | null>(null)
  const [progress, setProgress] = useState<MapProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const manifestUrl = scan?.manifestUrl ?? null
  const transformKey = scan ? JSON.stringify(scan.transform) : ''
  const transform = scan?.transform
  const transformRef = useRef(transform)
  transformRef.current = transform

  // Build the map in a worker; a new scan, layer or transform cancels the previous run. The
  // short delay keeps a scan being dragged in 3D from starting a build per frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: transformKey stands for the transform
  useEffect(() => {
    const currentTransform = transformRef.current
    if (!manifestUrl || !currentTransform) {
      setResult(null)
      setProgress(null)
      return
    }
    setFailure(null)
    let cancel = () => {}
    let cancelled = false
    const timer = window.setTimeout(() => {
      setProgress({ phase: 'manifest', done: 0, total: 1 })
      const job = startScanMap({ manifestUrl, transform: currentTransform, layer }, (next) =>
        setProgress(next),
      )
      cancel = job.cancel
      job.promise.then(
        (built) => {
          if (cancelled) return
          setResult(built)
          setProgress(null)
        },
        (error: unknown) => {
          if (cancelled || error instanceof ScanMapCancelled) return
          setResult(null)
          setProgress(null)
          setFailure(error instanceof Error ? error.message : 'failed')
        },
      )
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      cancel()
    }
  }, [manifestUrl, transformKey, layer, reloadToken])

  const image = useMemo(() => (result ? mapCanvas(result) : null), [result])
  const overlays = useMemo(
    () => sceneOverlays(nodes, scan?.levelId ?? null),
    [nodes, scan?.levelId],
  )

  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<MapViewport>({ offsetX: 0, offsetY: 0, scale: 50 })
  const fittedFor = useRef<ScanMapResult | null>(null)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const observer = new ResizeObserver(() =>
      setSize({ width: wrapper.clientWidth, height: wrapper.clientHeight }),
    )
    observer.observe(wrapper)
    setSize({ width: wrapper.clientWidth, height: wrapper.clientHeight })
    return () => observer.disconnect()
  }, [])

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
    const bounds = overlayBounds(points)
    if (bounds) setViewport(fitBounds(bounds, size.width, size.height))
  }, [result, overlays, size.width, size.height])

  // Fit once per built map, and again when the pane first gets a size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit only on a new map or size
  useEffect(() => {
    if (size.width && size.height && fittedFor.current !== result) {
      fittedFor.current = result
      fit()
    }
  }, [result, size.width, size.height])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * ratio)
    canvas.height = Math.round(size.height * ratio)
    draw(canvas, { viewport, result, image, overlays, opacity, toggles })
  }, [viewport, result, image, overlays, opacity, toggles, size])

  const drag = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (event: React.PointerEvent) => {
    drag.current = { x: event.clientX, y: event.clientY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    drag.current = { x: event.clientX, y: event.clientY }
    setViewport((view) => ({ ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy }))
  }
  const onPointerUp = () => {
    drag.current = null
  }
  // A passive React wheel handler cannot stop the page scrolling, so attach it by hand.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = wrapper.getBoundingClientRect()
      const factor = Math.exp(-event.deltaY * 0.0015)
      setViewport((view) =>
        zoomAt(view, event.clientX - rect.left, event.clientY - rect.top, factor),
      )
    }
    wrapper.addEventListener('wheel', onWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel)
  }, [])

  const bar = scaleBar(viewport.scale)
  const northAngle = result?.north ? northScreenAngle(result.north) : null
  const toggle = (key: keyof Toggles) =>
    setToggles((current) => ({ ...current, [key]: !current[key] }))
  const toggleLabels: Record<keyof Toggles, string> = {
    map: i18n._({ id: 'app.mapping.toggle.map', message: 'Map' }),
    walls: i18n._({ id: 'app.mapping.toggle.walls', message: 'Walls' }),
    rooms: i18n._({ id: 'app.mapping.toggle.rooms', message: 'Rooms' }),
    path: i18n._({ id: 'app.mapping.toggle.path', message: 'Walked path' }),
    proposal: i18n._({ id: 'app.mapping.toggle.proposal', message: 'Room proposal' }),
  }

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
        {(Object.keys(toggles) as Array<keyof Toggles>).map((key) => (
          <label className="flex items-center gap-1" key={key}>
            <input checked={toggles[key]} onChange={() => toggle(key)} type="checkbox" />
            {toggleLabels[key]}
          </label>
        ))}
        <button className="rounded bg-sidebar-accent px-2 py-1" onClick={fit} type="button">
          {i18n._({ id: 'app.mapping.fit', message: 'Fit' })}
        </button>
        <button
          className="rounded bg-sidebar-accent px-2 py-1"
          onClick={() => setReloadToken((token) => token + 1)}
          type="button"
        >
          {i18n._({ id: 'app.mapping.rebuild', message: 'Rebuild' })}
        </button>
      </div>
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
              <button
                className="rounded bg-white/10 px-2 py-0.5"
                onClick={() => setReloadToken((token) => token + 1)}
                type="button"
              >
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
              values: { reason: failure },
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
            className="pointer-events-none absolute top-3 right-3 flex flex-col items-center text-white text-xs"
            role="img"
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
        {result && result.notes.length > 0 && !progress && (
          <details className="absolute right-3 bottom-3 max-w-sm rounded bg-black/70 p-2 text-white text-xs">
            <summary className="cursor-pointer">
              {i18n._({ id: 'app.mapping.notes', message: 'Notes' })}
            </summary>
            <ul className="mt-1 list-disc pl-4">
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}
