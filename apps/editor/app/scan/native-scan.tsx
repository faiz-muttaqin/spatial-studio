'use client'

import { usePascalI18n } from '@pascal-app/core/i18n'
import { ScanLine, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PRIMARY_PILL, SECONDARY_PILL } from '@/components/app-shell'
import {
  BridgeError,
  type BridgeEvent,
  type NativeBridgeClient,
  type ScanListEntry,
  type ScanUploadResult,
} from '@/lib/scan/native-bridge'
import { cn } from '@/lib/utils'

/** Event payloads are the companion's to define; show them as plain key/value text. */
function describeEventData(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data !== 'object') return String(data)
  return Object.entries(data as Record<string, unknown>)
    .filter(([key, value]) => key !== 'sessionId' && typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ')
}

/** The list shows only the latest few; the companion does not say which were attached. */
const MAX_UPLOADED_SHOWN = 3

function eventSession(event: BridgeEvent): string | null {
  const sessionId = (event.data as { sessionId?: unknown } | null)?.sessionId
  return typeof sessionId === 'string' ? sessionId : null
}

export function NativeScan({
  client,
  depth,
  disabled,
  onBeforeStart,
  onStarted,
  onStartFailed,
  onBeforeUpload,
  onUploadFailed,
  onDiscarded,
  onUploaded,
}: {
  client: NativeBridgeClient
  depth: boolean
  disabled: boolean
  /** Fixes the destination for the scan about to start and returns its project id. */
  onBeforeStart: () => string
  onStarted: (sessionId: string) => void
  onStartFailed: () => void
  /** Fixes the destination before a scan's upload starts (earlier scans included). */
  onBeforeUpload: (sessionId: string) => void
  onUploadFailed: (sessionId: string) => void
  onDiscarded: (sessionId: string) => void
  /** Attaches an uploaded scan; resolves once attached or failed (failure is shown by the caller). */
  onUploaded: (result: ScanUploadResult & { projectId?: string | null }) => Promise<void>
}) {
  const i18n = usePascalI18n()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<Partial<Record<BridgeEvent['event'], string>>>({})
  const [earlier, setEarlier] = useState<ScanListEntry[]>([])
  /** Uploaded on the phone but possibly never attached (for example the page reloaded mid-upload). */
  const [uploaded, setUploaded] = useState<ScanListEntry[]>([])
  const [busy, setBusy] = useState<'start' | 'upload' | 'discard' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [location, setLocation] = useState(false)

  useEffect(
    () =>
      client.subscribe('*', (event) => {
        const owner = eventSession(event)
        // Events of another session (an earlier scan uploading) do not overwrite this one's.
        if (owner && sessionId && owner !== sessionId) return
        setEvents((current) => ({ ...current, [event.event]: describeEventData(event.data) }))
      }),
    [client, sessionId],
  )

  const [listVersion, setListVersion] = useState(0)
  /** Scans this visit uploaded or attached: never offered again, whatever a late list says. */
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set())
  const markHandled = (id: string) => setHandled((current) => new Set(current).add(id))

  // A finished upload whose reply this page never got: list again so it can be attached.
  useEffect(
    () => client.subscribe('upload.done', () => setListVersion((version) => version + 1)),
    [client],
  )

  useEffect(() => {
    let active = true
    client.listScans().then(
      (entries) => {
        if (!active) return
        setEarlier(entries.filter((entry) => !entry.uploaded))
        setUploaded(entries.filter((entry) => entry.uploaded && entry.manifestUrl))
      },
      () => {},
    )
    return () => {
      active = false
    }
  }, [client, listVersion])

  const run = async (kind: 'start' | 'upload' | 'discard', action: () => Promise<void>) => {
    setBusy(kind)
    setFailure(null)
    try {
      await action()
    } catch (error) {
      setFailure(error instanceof BridgeError ? error.code : 'internal')
    } finally {
      setBusy(null)
    }
  }

  const start = () =>
    run('start', async () => {
      setEvents({})
      const projectId = onBeforeStart()
      try {
        const result = await client.startScan({ projectId, options: { depth, location } })
        setSessionId(result.sessionId)
        onStarted(result.sessionId)
      } catch (error) {
        onStartFailed()
        throw error
      }
    })

  const upload = (id: string) =>
    run('upload', async () => {
      onBeforeUpload(id)
      let result: ScanUploadResult
      try {
        result = await client.uploadScan(id)
      } catch (error) {
        onUploadFailed(id)
        throw error
      }
      // Uploaded scans leave the list whatever happens next; a failed attach keeps its result.
      markHandled(id)
      setEarlier((entries) => entries.filter((entry) => entry.sessionId !== id))
      if (id === sessionId) setSessionId(null)
      await onUploaded(result)
    })

  /** The scan is already stored on the site: attach it from the list, with no second upload. */
  const attachUploaded = (entry: ScanListEntry) =>
    run('upload', async () => {
      const manifestUrl = entry.manifestUrl
      if (!manifestUrl) return
      onBeforeUpload(entry.sessionId)
      markHandled(entry.sessionId)
      if (entry.sessionId === sessionId) setSessionId(null)
      await onUploaded({
        sessionId: entry.sessionId,
        manifestUrl,
        manifestSha256: manifestUrl.slice(-64),
        projectId: entry.projectId,
      })
    })

  // Scans the companion says are attached, or this visit handled, are not offered; the latest few remain.
  const offered = uploaded
    .filter((entry) => !entry.attached && !handled.has(entry.sessionId))
    .slice(0, MAX_UPLOADED_SHOWN)

  const discard = (id: string) =>
    run('discard', async () => {
      await client.discardScan(id)
      setSessionId(null)
      setEvents({})
      onDiscarded(id)
    })

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        {i18n._({
          id: 'app.scan.native.hint',
          message:
            'The companion app records pose, planes, depth and keyframes with ARCore, then uploads them to this site.',
        })}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          checked={location}
          className="mt-1"
          disabled={disabled || busy !== null || sessionId !== null}
          onChange={(event) => setLocation(event.target.checked)}
          type="checkbox"
        />
        <span>
          {i18n._({
            id: 'app.scan.native.location',
            message: 'Record approximate location',
          })}
          <span className="block text-muted-foreground text-xs">
            {i18n._({
              id: 'app.scan.native.locationHint',
              message:
                'Off by default. The location is saved with the scan and used to correct the compass to true north when the scan is processed. The phone asks for permission first.',
            })}
          </span>
        </span>
      </label>
      <button
        className={cn(PRIMARY_PILL, 'h-11 w-full')}
        disabled={disabled || busy !== null || sessionId !== null}
        onClick={start}
        type="button"
      >
        <ScanLine className="h-4 w-4" />
        {busy === 'start'
          ? i18n._({ id: 'app.scan.native.starting', message: 'Opening the scanner…' })
          : i18n._({ id: 'app.scan.native.start', message: 'Start companion scan' })}
      </button>

      {sessionId ? (
        <div className="space-y-2 rounded-lg border border-border/60 p-3 text-sm">
          <p className="break-all font-mono text-muted-foreground text-xs">{sessionId}</p>
          {events['scan.state'] ? <p>{events['scan.state']}</p> : null}
          {events['scan.progress'] ? (
            <p className="text-muted-foreground">{events['scan.progress']}</p>
          ) : null}
          {events['upload.progress'] ? (
            <p className="text-muted-foreground">{events['upload.progress']}</p>
          ) : null}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button
              className={cn(SECONDARY_PILL, 'h-11')}
              disabled={disabled || busy !== null}
              onClick={() => upload(sessionId)}
              type="button"
            >
              <Upload className="h-4 w-4" />
              {busy === 'upload'
                ? i18n._({ id: 'app.scan.native.uploading', message: 'Uploading…' })
                : i18n._({ id: 'app.scan.native.upload', message: 'Upload this scan' })}
            </button>
            <button
              aria-label={i18n._({ id: 'app.scan.native.discard', message: 'Discard scan' })}
              className={cn(SECONDARY_PILL, 'h-11')}
              disabled={disabled || busy !== null}
              onClick={() => discard(sessionId)}
              title={i18n._({ id: 'app.scan.native.discard', message: 'Discard scan' })}
              type="button"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {earlier.length > 0 ? (
        <div className="space-y-2">
          <p className="font-medium text-sm">
            {i18n._({ id: 'app.scan.native.earlier', message: 'Scans not uploaded yet' })}
          </p>
          <ul className="space-y-2">
            {earlier.map((entry) => (
              <li
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2 text-sm"
                key={entry.sessionId}
              >
                <span className="text-muted-foreground">
                  {i18n._({
                    id: 'app.scan.native.entry',
                    message: '{keyframes, plural, one {# keyframe} other {# keyframes}}, {state}',
                    values: { keyframes: entry.keyframes, state: entry.state },
                  })}
                </span>
                <button
                  className={SECONDARY_PILL}
                  disabled={disabled || busy !== null || sessionId !== null}
                  onClick={() => upload(entry.sessionId)}
                  type="button"
                >
                  {i18n._({ id: 'app.scan.native.uploadShort', message: 'Upload' })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {offered.length > 0 ? (
        <div className="space-y-2">
          <p className="font-medium text-sm">
            {i18n._({ id: 'app.scan.native.uploadedList', message: 'Uploaded, not attached yet' })}
          </p>
          <ul className="space-y-2">
            {offered.map((entry) => (
              <li
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2 text-sm"
                key={entry.sessionId}
              >
                <span className="text-muted-foreground">
                  {i18n._({
                    id: 'app.scan.native.entry',
                    message: '{keyframes, plural, one {# keyframe} other {# keyframes}}, {state}',
                    values: { keyframes: entry.keyframes, state: entry.state },
                  })}
                </span>
                <button
                  className={SECONDARY_PILL}
                  disabled={disabled || busy !== null}
                  onClick={() => attachUploaded(entry)}
                  type="button"
                >
                  {i18n._({ id: 'app.scan.native.attach', message: 'Attach' })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {failure ? (
        <p className="text-red-400 text-sm" role="alert">
          {i18n._({
            id: 'app.scan.native.failed',
            message: 'The companion app reported an error: {code}',
            values: { code: failure },
          })}
        </p>
      ) : null}
    </div>
  )
}
