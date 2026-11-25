import { parseLiveFrame } from '@pascal-app/core/capture'
import { LivePreviewState, type PreviewSnapshot } from '@/lib/scan/live-preview'

/**
 * Runs the live scan preview off the main thread: it owns the stream (the message port the companion
 * handed over, or a loopback WebSocket), decodes frames, folds them into [LivePreviewState] and posts a
 * snapshot about five times a second. The capture library's carving re-runs about once a second.
 */

export type LiveWorkerIn =
  | { kind: 'port'; port: MessagePort }
  | { kind: 'ws'; url: string }
  | { kind: 'stop' }

export type LiveStats = {
  frames: number
  bad: number
  bytes: number
  carveMs: number | null
}

export type LiveWorkerOut =
  | { type: 'snapshot'; snapshot: PreviewSnapshot; stats: LiveStats }
  | { type: 'status'; state: 'open' | 'closed' | 'error' }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LiveWorkerIn>) => void) | null
  postMessage(message: LiveWorkerOut): void
}

const SNAPSHOT_INTERVAL_MS = 200
const CARVE_INTERVAL_MS = 1000

const state = new LivePreviewState()
const stats: LiveStats = { frames: 0, bad: 0, bytes: 0, carveMs: null }
let source: { close(): void } | null = null
let snapshotTimer: ReturnType<typeof setInterval> | null = null
let carveTimer: ReturnType<typeof setTimeout> | null = null
let changed = false

function onData(data: unknown) {
  const frame = parseLiveFrame(data)
  if (!frame) {
    stats.bad += 1
    return
  }
  stats.frames += 1
  stats.bytes += (data as ArrayBuffer).byteLength
  state.ingest(frame)
  changed = true
}

function stop() {
  source?.close()
  source = null
  if (snapshotTimer) clearInterval(snapshotTimer)
  if (carveTimer) clearTimeout(carveTimer)
  snapshotTimer = null
  carveTimer = null
}

function startTimers() {
  snapshotTimer = setInterval(() => {
    if (!changed) return
    changed = false
    scope.postMessage({ type: 'snapshot', snapshot: state.snapshot(), stats: { ...stats } })
  }, SNAPSHOT_INTERVAL_MS)
  // A pass costs tens to hundreds of milliseconds; wait at least three times that before the next one, so a
  // slow phone spends most of the worker's time reading frames.
  const carveNext = () => {
    let wait = CARVE_INTERVAL_MS
    if (state.needsCarve) {
      const start = performance.now()
      state.carve()
      stats.carveMs = Math.round(performance.now() - start)
      wait = Math.max(CARVE_INTERVAL_MS, stats.carveMs * 3)
      changed = true
    }
    carveTimer = setTimeout(carveNext, wait)
  }
  carveTimer = setTimeout(carveNext, CARVE_INTERVAL_MS)
}

scope.onmessage = (event) => {
  const message = event.data
  stop()
  if (message.kind === 'stop') {
    scope.postMessage({ type: 'status', state: 'closed' })
    return
  }
  // A new stream is a new scan segment: the old ring and path no longer describe it.
  state.reset()
  stats.frames = 0
  stats.bad = 0
  stats.bytes = 0
  stats.carveMs = null
  startTimers()
  if (message.kind === 'port') {
    const port = message.port
    port.onmessage = (frame) => onData(frame.data)
    source = { close: () => port.close() }
    scope.postMessage({ type: 'status', state: 'open' })
    return
  }
  try {
    const socket = new WebSocket(message.url)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => scope.postMessage({ type: 'status', state: 'open' })
    socket.onerror = () => scope.postMessage({ type: 'status', state: 'error' })
    socket.onclose = () => scope.postMessage({ type: 'status', state: 'closed' })
    socket.onmessage = (frame) => onData(frame.data)
    source = { close: () => socket.close() }
  } catch {
    scope.postMessage({ type: 'status', state: 'error' })
  }
}
