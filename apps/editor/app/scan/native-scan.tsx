'use client'

import { usePascalI18n } from '@pascal-app/core/i18n'
import { ScanLine, Upload } from 'lucide-react'
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
    .filter(([, value]) => typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ')
}

export function NativeScan({
  client,
  depth,
  projectId,
  disabled,
  onUploaded,
}: {
  client: NativeBridgeClient
  depth: boolean
  projectId?: string
  disabled: boolean
  onUploaded: (result: ScanUploadResult) => void
}) {
  const i18n = usePascalI18n()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<Partial<Record<BridgeEvent['event'], string>>>({})
  const [earlier, setEarlier] = useState<ScanListEntry[]>([])
  const [busy, setBusy] = useState<'start' | 'upload' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(
    () =>
      client.subscribe('*', (event) =>
        setEvents((current) => ({ ...current, [event.event]: describeEventData(event.data) })),
      ),
    [client],
  )

  useEffect(() => {
    let active = true
    client.listScans().then(
      (entries) => active && setEarlier(entries.filter((entry) => !entry.uploaded)),
      () => {},
    )
    return () => {
      active = false
    }
  }, [client])

  const run = async (kind: 'start' | 'upload', action: () => Promise<void>) => {
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
      const result = await client.startScan({ projectId, options: { depth } })
      setSessionId(result.sessionId)
    })

  const upload = (id: string) =>
    run('upload', async () => {
      onUploaded(await client.uploadScan(id))
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
      <button
        className={cn(PRIMARY_PILL, 'h-11 w-full')}
        disabled={disabled || busy !== null}
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
          <button
            className={cn(SECONDARY_PILL, 'h-11 w-full')}
            disabled={disabled || busy !== null}
            onClick={() => upload(sessionId)}
            type="button"
          >
            <Upload className="h-4 w-4" />
            {busy === 'upload'
              ? i18n._({ id: 'app.scan.native.uploading', message: 'Uploading…' })
              : i18n._({ id: 'app.scan.native.upload', message: 'Upload this scan' })}
          </button>
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
                  disabled={disabled || busy !== null}
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
