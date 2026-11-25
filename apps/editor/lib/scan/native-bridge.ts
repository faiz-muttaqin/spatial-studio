import { NativeCapabilitiesSchema, Sha256HexSchema } from '@pascal-app/core/capture'
import { z } from 'zod'

/**
 * Page side of the Android bridge, protocol v1 (`CAPTURE_CONTRACT.md`).
 * The companion injects `window.SpatialStudioNative` through
 * `WebViewCompat.addWebMessageListener`; when it is absent the scanner offers
 * the browser providers instead.
 */

export const BRIDGE_PROTOCOL_VERSION = 1
export const BRIDGE_MAX_MESSAGE_BYTES = 64 * 1024

export const BRIDGE_ERROR_CODES = [
  'forbidden',
  'invalid_request',
  'unknown_method',
  'unsupported',
  'permission_denied',
  'busy',
  'not_found',
  'upload_failed',
  'internal',
] as const

/** Contract codes plus the ones this client raises itself. */
export type BridgeErrorCode =
  | (typeof BRIDGE_ERROR_CODES)[number]
  | 'timeout'
  | 'cancelled'
  | 'disposed'
  | 'invalid_reply'
  | 'too_large'

export class BridgeError extends Error {
  readonly code: BridgeErrorCode

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

export const BRIDGE_EVENTS = [
  'scan.state',
  'scan.progress',
  'upload.progress',
  'upload.done',
] as const
export type BridgeEventName = (typeof BRIDGE_EVENTS)[number]
export type BridgeEvent = { v: 1; event: BridgeEventName; data: unknown }

/** The object the companion injects; the subset of `WebMessageListener`'s JS object we use. */
export type NativeBridgeTransport = {
  postMessage(message: string): void
  onmessage?: ((event: { data: unknown }) => void) | null
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void
}

const BridgeHelloSchema = z
  .object({
    bridgeVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    appVersion: z.string().min(1),
    platform: z.literal('android'),
    methods: z.array(z.string()),
  })
  .loose()

const ScanStartResultSchema = z.object({ sessionId: z.string().min(1) }).loose()

const ScanListResultSchema = z.array(
  z
    .object({
      sessionId: z.string().min(1),
      createdAt: z.union([z.string(), z.number()]),
      state: z.string(),
      keyframes: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      uploaded: z.boolean(),
      /** The page confirmed the scan was attached to a project (`scan.markAttached`). */
      attached: z.boolean().optional(),
      /** The project id the scan was started for; the attach target after a reload. */
      projectId: z.string().nullable().optional(),
      /** Present once the scan is uploaded; the page can attach it without uploading again. */
      manifestUrl: z
        .string()
        .regex(/^\/api\/artifacts\/[0-9a-f]{64}$/)
        .optional(),
    })
    .loose(),
)

const ScanUploadResultSchema = z
  .object({
    sessionId: z.string().min(1),
    manifestUrl: z.string().regex(/^\/api\/artifacts\/[0-9a-f]{64}$/),
    manifestSha256: Sha256HexSchema,
  })
  .loose()
  .refine((result) => result.manifestUrl.endsWith(result.manifestSha256), {
    message: 'manifestUrl must name manifestSha256.',
  })

const ScanDiscardResultSchema = z.object({ sessionId: z.string().min(1) }).loose()

export type BridgeHello = z.infer<typeof BridgeHelloSchema>
export type ScanListEntry = z.infer<typeof ScanListResultSchema>[number]
export type ScanUploadResult = z.infer<typeof ScanUploadResultSchema>
export type ScanStartOptions = {
  depth?: boolean
  keyframeSpacingM?: number
  maxKeyframes?: number
  /** Contract v1.1: compass, orientation, light and pressure streams. The app's default is on. */
  sensors?: boolean
  /** Contract v1.1: approximate location for geolocation and compass declination. Off unless set. */
  location?: boolean
}

const ReplySchema = z.union([
  z.object({ v: z.literal(1), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
])

const EventSchema = z.object({
  v: z.literal(1),
  event: z.enum(BRIDGE_EVENTS),
  data: z.unknown(),
})

const DEFAULT_TIMEOUT_MS = 10_000
/** Upload replies only after every artifact is stored; its own progress events keep it alive. */
const UPLOAD_IDLE_TIMEOUT_MS = 120_000
/** `scan.start` may wait for a camera permission or ARCore install prompt. */
const START_TIMEOUT_MS = 120_000

type RequestOptions = {
  timeoutMs?: number
  /** Restart the timeout whenever an event this accepts arrives. */
  keepAlive?: (event: BridgeEvent) => boolean
  signal?: AbortSignal
}

type Pending = {
  resolve(value: unknown): void
  reject(error: BridgeError): void
  keepAlive?: (event: BridgeEvent) => boolean
  restartTimer(): void
  clear(): void
}

/** `upload.progress` of one session; another session's progress must not keep this upload alive. */
export function isUploadProgressFor(sessionId: string): (event: BridgeEvent) => boolean {
  return (event) =>
    event.event === 'upload.progress' &&
    (event.data as { sessionId?: unknown } | null)?.sessionId === sessionId
}

export type NativeBridgeClient = {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<unknown>
  hello(): Promise<BridgeHello>
  capabilities(): Promise<z.infer<typeof NativeCapabilitiesSchema>>
  startScan(input?: {
    projectId?: string
    options?: ScanStartOptions
  }): Promise<{ sessionId: string }>
  listScans(): Promise<ScanListEntry[]>
  uploadScan(sessionId: string): Promise<ScanUploadResult>
  discardScan(sessionId: string): Promise<{ sessionId: string }>
  /** Tells the companion the scan is attached, so `scan.list` stops offering it. */
  markAttached(sessionId: string): Promise<{ sessionId: string }>
  subscribe(event: BridgeEventName | '*', listener: (event: BridgeEvent) => void): () => void
  dispose(): void
}

export function createNativeBridgeClient(
  transport: NativeBridgeTransport,
  options: { timeoutMs?: number; newId?: () => string } = {},
): NativeBridgeClient {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const newId = options.newId ?? (() => crypto.randomUUID())
  const pending = new Map<string, Pending>()
  const listeners = new Set<{ event: BridgeEventName | '*'; listener: (e: BridgeEvent) => void }>()
  let disposed = false

  const onMessage = (message: { data: unknown }) => {
    const parsed = parseIncoming(message.data)
    if (!parsed) return
    if ('event' in parsed) {
      for (const entry of pending.values()) {
        if (entry.keepAlive?.(parsed)) entry.restartTimer()
      }
      for (const { event, listener } of [...listeners]) {
        if (event === '*' || event === parsed.event) listener(parsed)
      }
      return
    }
    const entry = pending.get(parsed.id)
    if (!entry) return
    entry.clear()
    if (parsed.ok) entry.resolve(parsed.result)
    else entry.reject(new BridgeError(toErrorCode(parsed.error.code), parsed.error.message))
  }

  const previousOnMessage = transport.onmessage
  if (transport.addEventListener) transport.addEventListener('message', onMessage)
  else transport.onmessage = onMessage

  const request = (
    method: string,
    params?: Record<string, unknown>,
    requestOptions: RequestOptions = {},
  ): Promise<unknown> => {
    if (disposed) return Promise.reject(new BridgeError('disposed', 'The bridge client is closed.'))
    const id = newId()
    const body = JSON.stringify(
      params === undefined
        ? { v: BRIDGE_PROTOCOL_VERSION, id, method }
        : { v: BRIDGE_PROTOCOL_VERSION, id, method, params },
    )
    if (utf8Length(body) > BRIDGE_MAX_MESSAGE_BYTES) {
      return Promise.reject(new BridgeError('too_large', 'Bridge messages are limited to 64 KiB.'))
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = requestOptions.timeoutMs ?? defaultTimeout
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => {
        entry.clear()
        reject(new BridgeError('cancelled', `${method} was cancelled.`))
      }
      const entry: Pending = {
        resolve,
        reject,
        keepAlive: requestOptions.keepAlive,
        restartTimer() {
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            entry.clear()
            reject(new BridgeError('timeout', `${method} did not answer within ${timeoutMs} ms.`))
          }, timeoutMs)
        },
        clear() {
          if (timer !== undefined) clearTimeout(timer)
          pending.delete(id)
          requestOptions.signal?.removeEventListener('abort', onAbort)
        },
      }
      if (requestOptions.signal?.aborted) {
        reject(new BridgeError('cancelled', `${method} was cancelled.`))
        return
      }
      requestOptions.signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, entry)
      entry.restartTimer()
      try {
        transport.postMessage(body)
      } catch (cause) {
        entry.clear()
        reject(
          new BridgeError(
            'internal',
            cause instanceof Error ? cause.message : 'postMessage failed.',
          ),
        )
      }
    })
  }

  const typed = async <T>(schema: z.ZodType<T>, method: string, value: Promise<unknown>) => {
    const result = schema.safeParse(await value)
    if (!result.success) {
      throw new BridgeError('invalid_reply', `${method} returned an unexpected result.`)
    }
    return result.data
  }

  return {
    request,
    hello: () => typed(BridgeHelloSchema, 'bridge.hello', request('bridge.hello')),
    capabilities: () =>
      typed(NativeCapabilitiesSchema, 'capabilities.get', request('capabilities.get')),
    startScan: (input = {}) =>
      typed(
        ScanStartResultSchema,
        'scan.start',
        request('scan.start', stripUndefined(input), { timeoutMs: START_TIMEOUT_MS }),
      ),
    listScans: () => typed(ScanListResultSchema, 'scan.list', request('scan.list')),
    uploadScan: (sessionId) =>
      typed(
        ScanUploadResultSchema,
        'scan.upload',
        request(
          'scan.upload',
          { sessionId },
          { timeoutMs: UPLOAD_IDLE_TIMEOUT_MS, keepAlive: isUploadProgressFor(sessionId) },
        ),
      ),
    markAttached: (sessionId) =>
      typed(
        ScanDiscardResultSchema,
        'scan.markAttached',
        request('scan.markAttached', { sessionId }),
      ),
    discardScan: (sessionId) =>
      typed(ScanDiscardResultSchema, 'scan.discard', request('scan.discard', { sessionId })),
    subscribe(event, listener) {
      const entry = { event, listener }
      listeners.add(entry)
      return () => listeners.delete(entry)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (transport.removeEventListener) transport.removeEventListener('message', onMessage)
      else if (transport.onmessage === onMessage) transport.onmessage = previousOnMessage ?? null
      for (const entry of [...pending.values()]) {
        entry.clear()
        entry.reject(new BridgeError('disposed', 'The bridge client is closed.'))
      }
      listeners.clear()
    },
  }
}

/** The injected bridge, when this page runs inside the Android companion. */
export function findNativeBridge(scope: unknown = globalThis): NativeBridgeTransport | null {
  const candidate = (scope as { SpatialStudioNative?: unknown }).SpatialStudioNative
  if (!candidate || typeof (candidate as NativeBridgeTransport).postMessage !== 'function') {
    return null
  }
  return candidate as NativeBridgeTransport
}

function parseIncoming(
  data: unknown,
): z.infer<typeof ReplySchema> | z.infer<typeof EventSchema> | null {
  if (typeof data !== 'string' || utf8Length(data) > BRIDGE_MAX_MESSAGE_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  const event = EventSchema.safeParse(value)
  if (event.success) return event.data
  const reply = ReplySchema.safeParse(value)
  return reply.success ? reply.data : null
}

function toErrorCode(code: string): BridgeErrorCode {
  return (BRIDGE_ERROR_CODES as readonly string[]).includes(code)
    ? (code as BridgeErrorCode)
    : 'internal'
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
