/// <reference lib="webworker" />
import { sameOriginUrl } from '../capture/source-resolver'
import {
  type BoundedFetch,
  loadScanMap,
  MapCancelled,
  type MapProgress,
  MapRefusal,
  type MapRefusalCode,
  type PhotoDecoder,
  type ScanMapRequest,
  type ScanMapResult,
} from './scan-map-loader'

export type WorkerIn = { type: 'build'; origin: string; request: ScanMapRequest }
export type WorkerOut =
  | { type: 'progress'; progress: MapProgress }
  | { type: 'done'; result: ScanMapResult }
  | { type: 'error'; code: MapRefusalCode | 'failed'; cancelled?: boolean }

const scope = self as unknown as DedicatedWorkerGlobalScope

/**
 * Reads a response body in chunks and gives up as soon as it would pass the cap or the timeout.
 * Redirects are refused: an artifact URL that redirects would leave the checked origin and path.
 */
function boundedFetch(): BoundedFetch {
  return async (url, limit) => {
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(limit.timeoutMs),
      })
      if (!response.ok) return null
      const ok = (size: number) =>
        (limit.exact === undefined || size === limit.exact) &&
        (limit.max === undefined || size <= limit.max)
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > 0 && !ok(declared)) {
        await response.body?.cancel()
        return null
      }
      const cap = limit.exact ?? limit.max ?? Number.POSITIVE_INFINITY
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > cap) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
      if (!ok(total)) return null
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    } catch {
      // A timeout, a refused redirect or a network error: the artifact counts as unreadable.
      return null
    }
  }
}

/** Browser JPEG decode at a reduced size; EXIF rotation is off so pixels match the keyframe size. */
const decodePhoto: PhotoDecoder = async (bytes, longEdge) => {
  try {
    const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' })
    const full = await createImageBitmap(blob, { imageOrientation: 'none' })
    const sourceWidth = full.width
    const sourceHeight = full.height
    const scale = Math.min(1, longEdge / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      full.close()
      return null
    }
    context.drawImage(full, 0, 0, width, height)
    full.close()
    const data = context.getImageData(0, 0, width, height).data
    return { width, height, sourceWidth, sourceHeight, data, channels: 4 }
  } catch {
    return null
  }
}

scope.onmessage = async (event: MessageEvent<WorkerIn>) => {
  if (event.data.type !== 'build') return
  const { origin, request } = event.data
  const post = (message: WorkerOut, transfer: Transferable[] = []) =>
    scope.postMessage(message, transfer)
  try {
    const result = await loadScanMap(request, {
      fetchBytes: boundedFetch(),
      decodePhoto,
      artifactUrl: (value) => sameOriginUrl(value, origin, origin),
      onProgress: (progress) => post({ type: 'progress', progress }),
    })
    post({ type: 'done', result }, [result.map.rgba.buffer])
  } catch (error) {
    post({
      type: 'error',
      code: error instanceof MapRefusal ? error.code : 'failed',
      cancelled: error instanceof MapCancelled,
    })
  }
}
