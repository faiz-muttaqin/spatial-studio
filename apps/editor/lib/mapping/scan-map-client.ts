import type { ScanTransform } from '@pascal-app/core/capture'
import type { MapProgress, ScanMapRequest, ScanMapResult } from './scan-map-loader'
import type { WorkerIn, WorkerOut } from './scan-map-worker'

const MANIFEST_SHA = /([0-9a-f]{64})(?:[?#].*)?$/

/** Results kept for the session, newest last. */
const CACHE_ENTRIES = 4
const cache = new Map<string, ScanMapResult>()

export function manifestSha(manifestUrl: string): string | null {
  return manifestUrl.match(MANIFEST_SHA)?.[1] ?? null
}

/** The cache key: the manifest hash, the scan transform and the layer decide the picture. */
export function scanMapKey(request: ScanMapRequest): string | null {
  const sha = manifestSha(request.manifestUrl)
  if (!sha) return null
  const { position, rotation, scale } = request.transform as ScanTransform
  return JSON.stringify([
    sha,
    position,
    rotation,
    scale,
    request.layer,
    request.minConfidence ?? 128,
  ])
}

export function cachedScanMap(request: ScanMapRequest): ScanMapResult | null {
  const key = scanMapKey(request)
  return key ? (cache.get(key) ?? null) : null
}

export function clearScanMapCache(): void {
  cache.clear()
}

export type ScanMapJob = {
  promise: Promise<ScanMapResult>
  /** Stops the worker, and so its fetches and fusing, at once. */
  cancel: () => void
}

export class ScanMapCancelled extends Error {}

/** Builds a map in a dedicated worker, or returns the cached one. */
export function startScanMap(
  request: ScanMapRequest,
  onProgress: (progress: MapProgress) => void,
): ScanMapJob {
  const key = scanMapKey(request)
  const cached = key ? cache.get(key) : undefined
  if (cached) return { promise: Promise.resolve(cached), cancel: () => {} }
  const worker = new Worker(new URL('./scan-map-worker.ts', import.meta.url), { type: 'module' })
  let cancel = () => {}
  const promise = new Promise<ScanMapResult>((resolve, reject) => {
    cancel = () => {
      worker.terminate()
      reject(new ScanMapCancelled())
    }
    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const message = event.data
      if (message.type === 'progress') return onProgress(message.progress)
      worker.terminate()
      if (message.type === 'done') {
        if (key) {
          cache.delete(key)
          cache.set(key, message.result)
          while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string)
        }
        resolve(message.result)
      } else reject(new Error(message.message))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'The map worker failed.'))
    }
    worker.postMessage({
      type: 'build',
      origin: location.origin,
      request,
    } satisfies WorkerIn)
  })
  return { promise, cancel }
}
