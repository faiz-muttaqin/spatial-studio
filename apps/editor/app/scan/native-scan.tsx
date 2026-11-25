'use client'

import { useLocale, usePascalI18n } from '@pascal-app/core/i18n'
import { ScanLine, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { PRIMARY_PILL, SECONDARY_PILL } from '@/components/app-shell'
import {
  BridgeError,
  type BridgeEvent,
  type NativeBridgeClient,
  type ScanListEntry,
  type ScanUploadResult,
} from '@/lib/scan/native-bridge'
import { classifyUploadedScans, type UploadedScanReport } from '@/lib/scan/uploaded-scans'
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
const MAX_CHECKED = 8
const HIDDEN_KEY = 'spatial-studio.scan.hidden'

/** Scans the user hid on this device; the companion's copy is untouched. */
function readHidden(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeHidden(ids: Set<string>) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]))
  } catch {}
}

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
  const locale = useLocale()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<Partial<Record<BridgeEvent['event'], string>>>({})
  const [earlier, setEarlier] = useState<ScanListEntry[]>([])
  /** Uploaded on the phone but possibly never attached (for example the page reloaded mid-upload). */
  const [uploaded, setUploaded] = useState<ScanListEntry[]>([])
  const [busy, setBusy] = useState<'start' | 'upload' | 'discard' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [location, setLocation] = useState(false)
  const [livePreview, setLivePreview] = useState(false)
  const [torch, setTorch] = useState(false)
  /** Where each uploaded scan stands on this site; null while it is being checked. */
  const [report, setReport] = useState<UploadedScanReport | null>(null)

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
        const found = entries.filter((entry) => entry.uploaded && entry.manifestUrl)
        setUploaded(found)
        // Only the entries that can be shown are checked; the previous answers stay on screen meanwhile.
        const shown = found
          .filter((entry) => !entry.attached && !readHidden().has(entry.sessionId))
          .slice(0, MAX_CHECKED)
        classifyUploadedScans(shown, {}).then(
          (result) => active && setReport(result),
          () => active && setReport({ statuses: new Map(), projectNames: new Map() }),
        )
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
        const result = await client.startScan({
          projectId,
          options: { depth, location, torch, livePreview, locale },
        })
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

  // Scans the companion says are attached, or this visit handled, are not offered.
  const [hiddenVersion, setHiddenVersion] = useState(0)
  const hidden = useMemo(() => readHidden(), [hiddenVersion])
  const unhandled = uploaded.filter(
    (entry) => !entry.attached && !handled.has(entry.sessionId) && !hidden.has(entry.sessionId),
  )
  const statusOf = (entry: ScanListEntry) => report?.statuses.get(entry.sessionId) ?? null
  const attachable = unhandled
    .filter((entry) => {
      const status = statusOf(entry)
      return status === null || status.kind === 'attachable'
    })
    .slice(0, MAX_UPLOADED_SHOWN)
  const others = unhandled.filter((entry) => {
    const status = statusOf(entry)
    return status !== null && status.kind !== 'attachable'
  })
  const offered = [...attachable, ...others]

  const hideScan = (id: string) => {
    const ids = readHidden().add(id)
    writeHidden(ids)
    setHiddenVersion((version) => version + 1)
  }

  /** Deletes the phone's only copy: asks first. */
  const removeScan = (id: string) => {
    const sure = window.confirm(
      i18n._({
        id: 'app.scan.native.removeConfirm',
        message:
          'Delete this scan from the phone? It is not on this site, so this cannot be undone.',
      }),
    )
    if (!sure) return
    run('discard', async () => {
      await client.discardScan(id)
      setUploaded((entries) => entries.filter((entry) => entry.sessionId !== id))
    })
  }

  const markAttachedOnPhone = (id: string) =>
    run('upload', async () => {
      await client.markAttached(id)
      markHandled(id)
    })

  const describeEntry = (entry: ScanListEntry) => {
    const created = new Date(entry.createdAt)
    const when = Number.isNaN(created.getTime())
      ? String(entry.createdAt)
      : created.toLocaleString()
    const size = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
      entry.bytes / 1_000_000,
    )
    // Omitted when the project is not known (not created yet, or the list could not be read).
    const project = entry.projectId ? (report?.projectNames.get(entry.projectId) ?? null) : null
    return { when, size, project }
  }

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
      <label className="flex items-start gap-2 text-sm">
        <input
          checked={torch}
          className="mt-1"
          disabled={disabled || busy !== null || sessionId !== null}
          onChange={(event) => setTorch(event.target.checked)}
          type="checkbox"
        />
        <span>
          {i18n._({ id: 'app.scan.native.torch', message: 'Use the torch (experiment)' })}
          <span className="block text-muted-foreground text-xs">
            {i18n._({
              id: 'app.scan.native.torchHint',
              message:
                'Set before the scan and kept on throughout. Tracking may be less reliable with the torch on.',
            })}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          checked={livePreview}
          className="mt-1"
          disabled={disabled || busy !== null || sessionId !== null}
          onChange={(event) => setLivePreview(event.target.checked)}
          type="checkbox"
        />
        <span>
          {i18n._({
            id: 'app.scan.native.livePreview',
            message: 'Show a live map while scanning',
          })}
          <span className="block text-muted-foreground text-xs">
            {i18n._({
              id: 'app.scan.native.livePreviewHint',
              message:
                'Off by default. A small preview of coverage and the room outline appears on the scan screen. It is only a preview; the saved scan is the same either way.',
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
            {i18n._({
              id: 'app.scan.native.uploadedHeading',
              message: 'Scans uploaded from the phone',
            })}
          </p>
          <ul className="space-y-2">
            {offered.map((entry) => {
              const status = statusOf(entry)
              const info = describeEntry(entry)
              return (
                <li
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2 text-sm"
                  key={entry.sessionId}
                >
                  <span className="space-y-0.5">
                    <span className="block">
                      {i18n._({
                        id: 'app.scan.native.uploadedMeta',
                        message:
                          '{when} · {keyframes, plural, one {# photo} other {# photos}} · {size} MB',
                        values: { when: info.when, keyframes: entry.keyframes, size: info.size },
                      })}
                    </span>
                    <span className="block text-muted-foreground text-xs">
                      {status?.kind === 'elsewhere'
                        ? i18n._({
                            id: 'app.scan.native.elsewhere',
                            message: 'Uploaded to another server. It is not on this site.',
                          })
                        : status?.kind === 'in-project'
                          ? i18n._({
                              id: 'app.scan.native.inProject',
                              message: 'Already in {project}',
                              values: { project: status.name },
                            })
                          : status?.kind === 'unknown'
                            ? i18n._({
                                id: 'app.scan.native.unknown',
                                message: 'Could not check this scan. Try again.',
                              })
                            : info.project
                              ? i18n._({
                                  id: 'app.scan.native.projectLabel',
                                  message: 'Project: {project}',
                                  values: { project: info.project },
                                })
                              : null}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-2">
                    {status === null ? (
                      <span className="text-muted-foreground text-xs">
                        {i18n._({ id: 'app.scan.native.checking', message: 'Checking…' })}
                      </span>
                    ) : status.kind === 'attachable' ? (
                      <button
                        className={SECONDARY_PILL}
                        disabled={disabled || busy !== null}
                        onClick={() => attachUploaded(entry)}
                        type="button"
                      >
                        {i18n._({ id: 'app.scan.native.attach', message: 'Attach' })}
                      </button>
                    ) : status.kind === 'in-project' ? (
                      <button
                        className={SECONDARY_PILL}
                        disabled={disabled || busy !== null}
                        onClick={() => markAttachedOnPhone(entry.sessionId)}
                        type="button"
                      >
                        {i18n._({ id: 'app.scan.native.markAttached', message: 'Mark attached' })}
                      </button>
                    ) : status.kind === 'unknown' ? (
                      <button
                        className={SECONDARY_PILL}
                        disabled={disabled || busy !== null}
                        onClick={() => setListVersion((version) => version + 1)}
                        type="button"
                      >
                        {i18n._({ id: 'app.scan.native.checkAgain', message: 'Check again' })}
                      </button>
                    ) : (
                      <>
                        <button
                          className={SECONDARY_PILL}
                          onClick={() => hideScan(entry.sessionId)}
                          type="button"
                        >
                          {i18n._({ id: 'app.scan.native.hide', message: 'Hide' })}
                        </button>
                        <button
                          className={SECONDARY_PILL}
                          disabled={disabled || busy !== null}
                          onClick={() => removeScan(entry.sessionId)}
                          type="button"
                        >
                          {i18n._({
                            id: 'app.scan.native.deleteFromPhone',
                            message: 'Delete from phone',
                          })}
                        </button>
                      </>
                    )}
                  </span>
                </li>
              )
            })}
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
