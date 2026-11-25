'use client'

import { usePascalI18n } from '@pascal-app/core/i18n'
import { useEffect, useRef, useState } from 'react'
import type { PreviewSnapshot } from '@/lib/scan/live-preview'
import type { LiveStats, LiveWorkerIn, LiveWorkerOut } from './live-worker'

/** What the companion injects for this page only: open or close the preview stream. */
type LiveBridge = {
  postMessage(message: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

type Phase = 'no-app' | 'waiting' | 'open' | 'paused' | 'failed'

const PORT_MESSAGE = 'live.port'

function bridge(): LiveBridge | null {
  const value = (window as unknown as { SpatialStudioLive?: LiveBridge }).SpatialStudioLive
  return value ?? null
}

function draw(canvas: HTMLCanvasElement, snapshot: PreviewSnapshot | null) {
  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio)
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (!snapshot) return

  // Fit what is known: covered cells, the outline and the camera.
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const grow = (x: number, z: number) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  const cell = snapshot.coverage?.cellMetres ?? 0.25
  const cells = snapshot.coverage?.cells
  if (cells) {
    for (let i = 0; i < cells.length; i += 2) {
      grow(cells[i]! * cell, cells[i + 1]! * cell)
      grow((cells[i]! + 1) * cell, (cells[i + 1]! + 1) * cell)
    }
  }
  for (const [x, z] of snapshot.outline ?? []) grow(x, z)
  if (snapshot.camera) grow(snapshot.camera.x, snapshot.camera.z)
  if (!Number.isFinite(minX)) return
  const pad = 12
  const span = Math.max(maxX - minX, maxZ - minZ, 2)
  const scale = (Math.min(width, height) - pad * 2) / span
  const ox = (width - (maxX - minX) * scale) / 2 - minX * scale
  const oz = (height - (maxZ - minZ) * scale) / 2 - minZ * scale
  const px = (x: number) => x * scale + ox
  const pz = (z: number) => z * scale + oz

  if (cells) {
    ctx.fillStyle = 'rgba(96, 165, 250, 0.45)'
    for (let i = 0; i < cells.length; i += 2) {
      ctx.fillRect(
        px(cells[i]! * cell),
        pz(cells[i + 1]! * cell),
        cell * scale + 0.5,
        cell * scale + 0.5,
      )
    }
  }
  if (snapshot.outline && snapshot.outline.length > 2) {
    ctx.strokeStyle = '#fbbf24'
    ctx.lineWidth = 2
    ctx.beginPath()
    snapshot.outline.forEach(([x, z], i) => {
      if (i === 0) ctx.moveTo(px(x), pz(z))
      else ctx.lineTo(px(x), pz(z))
    })
    ctx.closePath()
    ctx.stroke()
  }
  if (snapshot.camera) {
    const { x, z, headingX, headingZ } = snapshot.camera
    const angle = Math.atan2(headingZ, headingX)
    ctx.save()
    ctx.translate(px(x), pz(z))
    ctx.rotate(angle)
    ctx.fillStyle = '#f87171'
    ctx.beginPath()
    ctx.moveTo(8, 0)
    ctx.lineTo(-5, 5)
    ctx.lineTo(-5, -5)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}

export function LiveView() {
  const i18n = usePascalI18n()
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const snapshot = useRef<PreviewSnapshot | null>(null)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [stats, setStats] = useState<LiveStats | null>(null)
  const [summary, setSummary] = useState<{
    percent: number | null
    note: string | null
    tracking: string
  }>({
    percent: null,
    note: null,
    tracking: 'none',
  })

  useEffect(() => {
    const native = bridge()
    if (!native) {
      setPhase('no-app')
      return
    }
    const worker = new Worker(new URL('./live-worker.ts', import.meta.url), { type: 'module' })
    const send = (message: LiveWorkerIn, transfer: Transferable[] = []) =>
      worker.postMessage(message, transfer)
    let requestCount = 0
    let preferred: 'port' | 'ws' = 'port'

    const open = () => {
      requestCount += 1
      native.postMessage(
        JSON.stringify({
          v: 1,
          id: `open-${requestCount}`,
          method: 'live.open',
          params: { transport: preferred },
        }),
      )
    }

    worker.onmessage = (event: MessageEvent<LiveWorkerOut>) => {
      const message = event.data
      if (message.type === 'status') {
        if (message.state === 'error') setPhase('failed')
        return
      }
      snapshot.current = message.snapshot
      setStats(message.stats)
      setSummary({
        percent: message.snapshot.coverage?.percent ?? null,
        note: message.snapshot.outlineNote,
        tracking: message.snapshot.tracking,
      })
      if (canvas.current) draw(canvas.current, message.snapshot)
    }

    // The companion hands the page its end of the channel with this message.
    const onWindowMessage = (event: MessageEvent) => {
      if (event.data !== PORT_MESSAGE || event.ports.length !== 1) return
      send({ kind: 'port', port: event.ports[0]! }, [event.ports[0]!])
      setPhase('open')
    }
    window.addEventListener('message', onWindowMessage)

    const onNative = (event: { data: unknown }) => {
      if (typeof event.data !== 'string') return
      let message: {
        ok?: boolean
        error?: { code?: string }
        result?: { transport?: string; url?: string }
        event?: string
        data?: { state?: string }
      }
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.event === 'live.state') {
        if (message.data?.state === 'ready') open()
        if (message.data?.state === 'closed') {
          send({ kind: 'stop' })
          setPhase('paused')
        }
        return
      }
      if (message.ok === false) {
        // A WebView without binary messages falls back to the loopback socket, once.
        if (preferred === 'port' && message.error?.code === 'unsupported') {
          preferred = 'ws'
          open()
        } else {
          setPhase('failed')
        }
        return
      }
      if (message.ok === true && message.result?.transport === 'ws' && message.result.url) {
        send({ kind: 'ws', url: message.result.url })
        setPhase('open')
      }
    }
    native.addEventListener('message', onNative)
    open()

    return () => {
      native.removeEventListener('message', onNative)
      window.removeEventListener('message', onWindowMessage)
      native.postMessage(JSON.stringify({ v: 1, id: 'close', method: 'live.close' }))
      send({ kind: 'stop' })
      worker.terminate()
    }
  }, [])

  const label: Record<Phase, string> = {
    'no-app': i18n._({
      id: 'app.scan.live.noApp',
      message: 'The live preview is shown inside the companion app while scanning.',
    }),
    waiting: i18n._({ id: 'app.scan.live.waiting', message: 'Connecting to the scan' }),
    open: i18n._({ id: 'app.scan.live.open', message: 'Live preview' }),
    paused: i18n._({ id: 'app.scan.live.paused', message: 'Paused' }),
    failed: i18n._({ id: 'app.scan.live.failed', message: 'The preview could not connect' }),
  }

  return (
    <main className="flex h-dvh flex-col bg-black/70 p-2 text-white text-xs">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{label[phase]}</span>
        {summary.percent !== null && (
          <span>
            {i18n._({
              id: 'app.scan.live.coverage',
              message: 'Floor covered {percent}%',
              values: { percent: summary.percent },
            })}
          </span>
        )}
      </div>
      <canvas className="min-h-0 w-full flex-1" ref={canvas} />
      <p className="min-h-4 text-white/70">
        {summary.note ??
          (stats
            ? i18n._({
                id: 'app.scan.live.stats',
                message: '{frames} frames, {kb} KB',
                values: { frames: stats.frames, kb: Math.round(stats.bytes / 1024) },
              })
            : '')}
      </p>
    </main>
  )
}
