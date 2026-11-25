'use client'

import {
  type BrowserCapabilities,
  CAPTURE_MAX_KEYFRAMES,
  type DeviceCapabilities,
} from '@pascal-app/core/capture'
import { usePascalI18n } from '@pascal-app/core/i18n'
import { CheckCircle2, ExternalLink, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { ZodError } from 'zod'
import { AppHeader, AppShell, PRIMARY_PILL, SECONDARY_PILL } from '@/components/app-shell'
import { type PreparedArtifact, prepareArtifact, uploadArtifacts } from '@/lib/scan/artifacts'
import {
  attachScanToProject,
  createProjectWithScan,
  listProjects,
  newSceneId,
  type ScanAttachment,
} from '@/lib/scan/attach'
import { buildBrowserPhotoBundle, type PreparedBundle } from '@/lib/scan/browser-photo-bundle'
import { describeBrowserDevice, probeBrowserCapabilities } from '@/lib/scan/capabilities'
import { EMPTY_MEASUREMENTS, measurementsFromDraft } from '@/lib/scan/measurements'
import {
  createNativeBridgeClient,
  findNativeBridge,
  type NativeBridgeClient,
  type ScanUploadResult,
} from '@/lib/scan/native-bridge'
import { captureTimestamp, downscaleToJpeg } from '@/lib/scan/photo'
import { captureName, newCaptureSessionId } from '@/lib/scan/session'
import { cn } from '@/lib/utils'
import { CapabilityPanel, type NativeProbe } from './capability-panel'
import { type Destination, DestinationPicker, type ProjectsState } from './destination-picker'
import { MeasurementsForm } from './measurements-form'
import { NativeScan } from './native-scan'
import { type CapturedPhoto, PhotoCapture } from './photo-capture'

type PhotoItem = CapturedPhoto & { timestamp: number; artifact: PreparedArtifact }

/**
 * Where a scan goes, fixed once: an existing project, or a new one whose id is
 * picked now so the manifest's `projectId` and the attach agree, and a retried
 * create can find the first attempt.
 */
type Target = { sceneId: string; create: { name: string } | null }

/** A stored capture still waiting to be attached; kept until attaching succeeds. */
type PendingAttachment = { attachment: ScanAttachment; target: Target }

/** The bundle built for the current photos, reused when a submit is retried. */
type PreparedCapture = {
  key: string
  sessionId: string
  createdAt: Date
  target: Target
  bundle: PreparedBundle | null
  stored: Set<string>
}

/** A companion scan in progress and the destination it was started for. */
type NativeSession = { sessionId: string | null; target: Target; origin: 'start' | 'upload' }

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; done: number; total: number }
  | { kind: 'attaching' }
  | { kind: 'done'; sceneId: string; manifestUrl: string }
  | {
      kind: 'failed'
      reason: 'noPhotos' | 'measurements' | 'invalidBundle' | 'upload' | 'attach'
      detail?: string
    }

function resolveTarget(destination: Destination): Target {
  return destination.kind === 'existing'
    ? { sceneId: destination.sceneId, create: null }
    : { sceneId: newSceneId(), create: { name: destination.name.trim() } }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-border/60 bg-background p-4">
      <h2 className="font-semibold text-base">{title}</h2>
      {children}
    </section>
  )
}

export function ScanApp({ appVersion }: { appVersion: string }) {
  const i18n = usePascalI18n()
  const [browser, setBrowser] = useState<BrowserCapabilities | null>(null)
  const [native, setNative] = useState<NativeProbe>({ state: 'absent' })
  const [client, setClient] = useState<NativeBridgeClient | null>(null)
  const [provider, setProvider] = useState<'photos' | 'native'>('photos')
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [processing, setProcessing] = useState(0)
  const [unreadablePhotos, setUnreadablePhotos] = useState(0)
  const [overLimitPhotos, setOverLimitPhotos] = useState(0)
  const [draft, setDraft] = useState(EMPTY_MEASUREMENTS)
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set())
  const [projects, setProjects] = useState<ProjectsState>({ status: 'loading' })
  const [destination, setDestination] = useState<Destination>({ kind: 'new', name: '' })
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [pending, setPending] = useState<PendingAttachment | null>(null)
  const [nativeSession, setNativeSession] = useState<NativeSession | null>(null)
  const photosRef = useRef(photos)
  photosRef.current = photos
  const nativeSessionRef = useRef(nativeSession)
  nativeSessionRef.current = nativeSession
  /** Photos being decoded and hashed; they count against the cap before they land. */
  const inFlightRef = useRef(0)
  const preparedRef = useRef<PreparedCapture | null>(null)

  const listRequestRef = useRef(0)
  const loadProjects = useCallback(() => {
    // Only the latest request may set the list; an older answer arriving late is dropped.
    const request = ++listRequestRef.current
    setProjects({ status: 'loading' })
    listProjects().then(
      (result) => request === listRequestRef.current && setProjects({ status: 'ready', ...result }),
      () => request === listRequestRef.current && setProjects({ status: 'error' }),
    )
  }, [])

  useEffect(() => {
    let active = true
    probeBrowserCapabilities().then((result) => active && setBrowser(result))
    loadProjects()
    return () => {
      active = false
    }
  }, [loadProjects])

  useEffect(() => {
    const bridge = findNativeBridge(window)
    if (!bridge) return
    const nativeClient = createNativeBridgeClient(bridge)
    let active = true
    setClient(nativeClient)
    setNative({ state: 'probing' })
    setProvider('native')
    ;(async () => {
      try {
        const hello = await nativeClient.hello()
        const capabilities = hello.methods.includes('capabilities.get')
          ? await nativeClient.capabilities()
          : null
        if (active) setNative({ state: 'ready', hello, capabilities })
      } catch (error) {
        if (!active) return
        const code = (error as { code?: string }).code ?? 'internal'
        setNative({ state: 'failed', code, message: (error as Error).message })
        setProvider('photos')
      }
    })()
    return () => {
      active = false
      nativeClient.dispose()
      setClient(null)
    }
  }, [])

  useEffect(
    () => () => {
      for (const photo of photosRef.current) URL.revokeObjectURL(photo.previewUrl)
    },
    [],
  )

  const busy = phase.kind === 'uploading' || phase.kind === 'attaching'
  const destinationLocked = busy || pending !== null || nativeSession !== null

  const addFiles = useCallback(async (files: File[]) => {
    const room = CAPTURE_MAX_KEYFRAMES - photosRef.current.length - inFlightRef.current
    const accepted = files.slice(0, Math.max(0, room))
    if (accepted.length < files.length) {
      setOverLimitPhotos((count) => count + files.length - accepted.length)
    }
    inFlightRef.current += accepted.length
    setProcessing((count) => count + accepted.length)
    for (const file of accepted) {
      try {
        const { blob, width, height } = await downscaleToJpeg(file)
        const artifact = await prepareArtifact(blob, 'image/jpeg')
        const item: PhotoItem = {
          id: crypto.randomUUID(),
          previewUrl: URL.createObjectURL(blob),
          width,
          height,
          byteLength: artifact.byteLength,
          timestamp: captureTimestamp(file.lastModified, Date.now()),
          artifact,
        }
        // The in-flight count already keeps this under the cap; the setter holds it regardless.
        setPhotos((current) =>
          current.length >= CAPTURE_MAX_KEYFRAMES ? current : [...current, item],
        )
      } catch {
        setUnreadablePhotos((count) => count + 1)
      } finally {
        inFlightRef.current -= 1
        setProcessing((count) => count - 1)
      }
    }
  }, [])

  const removePhoto = useCallback((id: string) => {
    setPhotos((current) => {
      const removed = current.find((photo) => photo.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((photo) => photo.id !== id)
    })
  }, [])

  /** Resolves true once the scan is attached to its project. */
  const attach = async (next: PendingAttachment): Promise<boolean> => {
    setPending(next)
    setPhase({ kind: 'attaching' })
    try {
      const { target, attachment } = next
      const result = target.create
        ? await createProjectWithScan(target.create.name || attachment.name, attachment, {
            sceneId: target.sceneId,
          })
        : await attachScanToProject(target.sceneId, attachment)
      setPending(null)
      setNativeSession(null)
      preparedRef.current = null
      setPhase({ kind: 'done', sceneId: result.sceneId, manifestUrl: attachment.manifestUrl })
      return true
    } catch (error) {
      // The capture is stored; keep it so attaching can be retried without uploading again.
      setPhase({ kind: 'failed', reason: 'attach', detail: (error as Error).message })
      return false
    }
  }

  const submitPhotos = async () => {
    if (photos.length === 0) {
      setPhase({ kind: 'failed', reason: 'noPhotos' })
      return
    }
    const measurements = measurementsFromDraft(draft)
    if (!measurements.ok) {
      setInvalidFields(new Set(measurements.invalidFields))
      setPhase({ kind: 'failed', reason: 'measurements' })
      return
    }
    setInvalidFields(new Set())

    // A retry with unchanged photos, measurements and destination reuses the
    // same session and bundle and skips artifacts already stored.
    const key = JSON.stringify({
      photos: photos.map((photo) => photo.artifact.sha256),
      draft,
      destination,
    })
    if (preparedRef.current?.key !== key) {
      preparedRef.current = {
        key,
        sessionId: newCaptureSessionId(),
        createdAt: new Date(),
        target: resolveTarget(destination),
        bundle: null,
        stored: new Set(),
      }
    }
    const prepared = preparedRef.current
    let manifestUrl: string

    try {
      if (!prepared.bundle) {
        const capabilities: DeviceCapabilities = {
          probedAt: Date.now(),
          browser: browser ?? (await probeBrowserCapabilities()),
          native: native.state === 'ready' ? native.capabilities : null,
        }
        prepared.bundle = await buildBrowserPhotoBundle({
          sessionId: prepared.sessionId,
          projectId: prepared.target.sceneId,
          appVersion,
          createdAt: prepared.createdAt,
          device: describeBrowserDevice(),
          photos: photos.map((photo, index) => ({
            id: `frame-${String(index + 1).padStart(3, '0')}`,
            timestamp: photo.timestamp,
            width: photo.width,
            height: photo.height,
            image: photo.artifact,
          })),
          measurements: measurements.value,
          capabilities,
        })
      }
      const bundle = prepared.bundle
      const total = new Set(bundle.artifacts.map((artifact) => artifact.sha256)).size + 1
      const remaining = bundle.artifacts.filter((artifact) => !prepared.stored.has(artifact.sha256))
      const alreadyStored = total - 1 - new Set(remaining.map((a) => a.sha256)).size
      setPhase({ kind: 'uploading', done: alreadyStored, total })
      const onStored = (sha256: string) => prepared.stored.add(sha256)
      await uploadArtifacts(remaining, {
        onStored,
        onProgress: (progress) =>
          setPhase({ kind: 'uploading', done: alreadyStored + progress.done, total }),
      })
      // The manifest goes last, so a stored manifest never points at a missing artifact.
      await uploadArtifacts([bundle.manifestArtifact], { onStored })
      setPhase({ kind: 'uploading', done: total, total })
      manifestUrl = bundle.manifestUrl
    } catch (error) {
      if (error instanceof ZodError) {
        preparedRef.current = null
        setPhase({ kind: 'failed', reason: 'invalidBundle' })
      } else {
        setPhase({ kind: 'failed', reason: 'upload', detail: (error as Error).message })
      }
      return
    }
    await attach({
      attachment: {
        name: captureName(prepared.createdAt),
        sessionId: prepared.sessionId,
        manifestUrl,
      },
      target: prepared.target,
    })
  }

  const beginNativeScan = () => {
    const target = resolveTarget(destination)
    setNativeSession({ sessionId: null, target, origin: 'start' })
    return target.sceneId
  }

  const lockForUpload = (sessionId: string) => {
    if (nativeSessionRef.current?.sessionId === sessionId) return
    // An earlier scan (started in another visit) gets the destination chosen now.
    setNativeSession({ sessionId, target: resolveTarget(destination), origin: 'upload' })
  }

  const releaseIfUploadOnly = (sessionId: string) =>
    setNativeSession((current) =>
      current?.sessionId === sessionId && current.origin === 'upload' ? null : current,
    )

  const onNativeUploaded = async (result: ScanUploadResult & { projectId?: string | null }) => {
    const session = nativeSessionRef.current
    let target: Target
    if (session?.sessionId === result.sessionId) {
      target = session.target
    } else if (result.projectId) {
      // The scan was started for this project id (a visit before a reload): attach there, so the manifest's
      // projectId and the scene agree. Attaching is idempotent per capture session.
      const existing = await fetch(`/api/scenes/${encodeURIComponent(result.projectId)}`).catch(
        () => null,
      )
      target = {
        sceneId: result.projectId,
        create: existing?.ok ? null : { name: '' },
      }
    } else {
      target = resolveTarget(destination)
    }
    const attached = await attach({
      attachment: {
        name: captureName(new Date()),
        sessionId: result.sessionId,
        manifestUrl: result.manifestUrl,
      },
      target,
    })
    // Best effort: the list stops offering a scan that is attached.
    if (attached) await client?.markAttached(result.sessionId).catch(() => {})
  }

  const startOver = () => {
    for (const photo of photos) URL.revokeObjectURL(photo.previewUrl)
    setPhotos([])
    setDraft(EMPTY_MEASUREMENTS)
    setUnreadablePhotos(0)
    setOverLimitPhotos(0)
    setPending(null)
    setNativeSession(null)
    preparedRef.current = null
    setPhase({ kind: 'idle' })
  }

  const destinationLabel =
    destination.kind === 'existing'
      ? i18n._({ id: 'app.scan.submit.attach', message: 'Upload and attach to project' })
      : i18n._({ id: 'app.scan.submit.create', message: 'Upload and create project' })

  return (
    <AppShell>
      <AppHeader />
      <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
        <div className="space-y-1">
          <h1 className="font-semibold text-xl">
            {i18n._({ id: 'app.scan.title', message: 'Scan a room' })}
          </h1>
          <p className="text-muted-foreground text-sm">
            {i18n._({
              id: 'app.scan.intro',
              message:
                'Capture photos and measurements on this phone. They are stored with the project as a reference layer for rebuilding the room.',
            })}
          </p>
        </div>

        <Section title={i18n._({ id: 'app.scan.section.device', message: 'This device' })}>
          <CapabilityPanel browser={browser} native={native} />
        </Section>

        {phase.kind === 'done' ? (
          <Section title={i18n._({ id: 'app.scan.section.done', message: 'Scan attached' })}>
            <p className="flex items-start gap-2 text-sm" data-testid="scan-done">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              {i18n._({
                id: 'app.scan.done.body',
                message:
                  'The capture is stored and the project now has a scan reference layer on its ground level.',
              })}
            </p>
            <p className="break-all font-mono text-muted-foreground text-xs">{phase.manifestUrl}</p>
            <div className="grid grid-cols-2 gap-2">
              <Link className={cn(PRIMARY_PILL, 'h-11')} href={`/project/${phase.sceneId}`}>
                <ExternalLink className="h-4 w-4" />
                {i18n._({ id: 'app.scan.done.open', message: 'Open project' })}
              </Link>
              <button className={cn(SECONDARY_PILL, 'h-11')} onClick={startOver} type="button">
                {i18n._({ id: 'app.scan.done.again', message: 'Scan again' })}
              </button>
            </div>
          </Section>
        ) : (
          <>
            {client && native.state === 'ready' ? (
              <div className="grid grid-cols-2 gap-2" role="tablist">
                {(['native', 'photos'] as const).map((value) => (
                  <button
                    aria-selected={provider === value}
                    className={cn(
                      'h-11 rounded-lg border text-sm',
                      provider === value
                        ? 'border-primary bg-primary/10 font-medium'
                        : 'border-border text-muted-foreground',
                    )}
                    disabled={busy || pending !== null}
                    key={value}
                    onClick={() => setProvider(value)}
                    role="tab"
                    type="button"
                  >
                    {value === 'native'
                      ? i18n._({ id: 'app.scan.provider.native', message: 'Companion scan' })
                      : i18n._({ id: 'app.scan.provider.photos', message: 'Photos' })}
                  </button>
                ))}
              </div>
            ) : null}

            <Section title={i18n._({ id: 'app.scan.section.destination', message: 'Save to' })}>
              <DestinationPicker
                destination={destination}
                disabled={destinationLocked}
                lockedByScan={nativeSession !== null || pending !== null}
                onChange={setDestination}
                onRetryProjects={loadProjects}
                projects={projects}
              />
            </Section>

            {provider === 'native' && client && native.state === 'ready' ? (
              <Section title={i18n._({ id: 'app.scan.section.native', message: 'Companion scan' })}>
                <NativeScan
                  client={client}
                  depth={native.capabilities?.arcore.depth ?? false}
                  disabled={busy || pending !== null}
                  onBeforeStart={beginNativeScan}
                  onBeforeUpload={lockForUpload}
                  onDiscarded={() => setNativeSession(null)}
                  onStarted={(sessionId) =>
                    setNativeSession((current) => current && { ...current, sessionId })
                  }
                  onStartFailed={() => setNativeSession(null)}
                  onUploaded={onNativeUploaded}
                  onUploadFailed={releaseIfUploadOnly}
                />
              </Section>
            ) : (
              <>
                <Section title={i18n._({ id: 'app.scan.section.photos', message: 'Photos' })}>
                  <PhotoCapture
                    disabled={busy || pending !== null}
                    onFiles={addFiles}
                    onRemove={removePhoto}
                    photos={photos}
                    processing={processing}
                  />
                  {unreadablePhotos > 0 ? (
                    <p className="text-red-400 text-sm" role="alert">
                      {i18n._({
                        id: 'app.scan.photos.unreadable',
                        message:
                          '{count, plural, one {# file could not be read as a photo.} other {# files could not be read as photos.}}',
                        values: { count: unreadablePhotos },
                      })}
                    </p>
                  ) : null}
                  {overLimitPhotos > 0 ? (
                    <p className="text-red-400 text-sm" role="alert">
                      {i18n._({
                        id: 'app.scan.photos.overLimit',
                        message:
                          '{count, plural, one {# photo was not added} other {# photos were not added}}: a scan holds at most {max}.',
                        values: { count: overLimitPhotos, max: CAPTURE_MAX_KEYFRAMES },
                      })}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground text-xs">
                    {i18n._({
                      id: 'app.scan.photos.webxrNote',
                      message:
                        'Live AR capture in the browser is not part of this version. Photos with measured dimensions work on any phone.',
                    })}
                  </p>
                </Section>

                <Section
                  title={i18n._({ id: 'app.scan.section.measurements', message: 'Measurements' })}
                >
                  <MeasurementsForm
                    disabled={busy || pending !== null}
                    draft={draft}
                    invalidFields={invalidFields}
                    onChange={setDraft}
                  />
                </Section>

                {pending === null ? (
                  <button
                    className={cn(PRIMARY_PILL, 'h-12 w-full text-base')}
                    data-testid="scan-submit"
                    disabled={busy || processing > 0}
                    onClick={submitPhotos}
                    type="button"
                  >
                    {destinationLabel}
                  </button>
                ) : null}
              </>
            )}

            <PhaseMessage
              onRetryAttach={pending && !busy ? () => attach(pending) : null}
              onStartOver={startOver}
              pending={pending}
              phase={phase}
            />
          </>
        )}
      </main>
    </AppShell>
  )
}

function PhaseMessage({
  phase,
  pending,
  onRetryAttach,
  onStartOver,
}: {
  phase: Phase
  pending: PendingAttachment | null
  onRetryAttach: (() => void) | null
  onStartOver: () => void
}) {
  const i18n = usePascalI18n()
  if (phase.kind === 'uploading') {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {i18n._({
          id: 'app.scan.phase.uploading',
          message: 'Uploading {done} of {total} files…',
          values: { done: phase.done, total: phase.total },
        })}
      </p>
    )
  }
  if (phase.kind === 'attaching') {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {i18n._({ id: 'app.scan.phase.attaching', message: 'Adding the scan to the project…' })}
      </p>
    )
  }
  if (phase.kind !== 'failed') return null

  let message: string
  if (phase.reason === 'noPhotos') {
    message = i18n._({ id: 'app.scan.error.noPhotos', message: 'Add at least one photo first.' })
  } else if (phase.reason === 'measurements') {
    message = i18n._({
      id: 'app.scan.error.measurements',
      message: 'Some measurements are not valid numbers. Use metres, for example 2.75.',
    })
  } else if (phase.reason === 'invalidBundle') {
    message = i18n._({
      id: 'app.scan.error.invalidBundle',
      message:
        'This capture is outside the scan limits (at most {max} photos). Remove some photos and try again.',
      values: { max: CAPTURE_MAX_KEYFRAMES },
    })
  } else if (phase.reason === 'upload') {
    message = i18n._({
      id: 'app.scan.error.upload',
      message: 'Upload failed. Nothing was attached; you can try again.',
    })
  } else {
    message = i18n._({
      id: 'app.scan.error.attach',
      message: 'The files are stored, but the scan could not be added to the project.',
    })
  }
  return (
    <div className="space-y-2 text-sm" role="alert">
      <p className="text-red-400">{message}</p>
      {phase.detail ? <p className="text-muted-foreground text-xs">{phase.detail}</p> : null}
      {phase.reason === 'attach' && pending ? (
        <>
          <p
            className="break-all font-mono text-muted-foreground text-xs"
            data-testid="scan-pending-manifest"
          >
            {pending.attachment.manifestUrl}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              className={cn(PRIMARY_PILL, 'h-11')}
              data-testid="scan-retry-attach"
              disabled={!onRetryAttach}
              onClick={() => onRetryAttach?.()}
              type="button"
            >
              <RotateCcw className="h-4 w-4" />
              {i18n._({ id: 'app.scan.attach.retry', message: 'Retry attaching' })}
            </button>
            <button className={cn(SECONDARY_PILL, 'h-11')} onClick={onStartOver} type="button">
              {i18n._({ id: 'app.scan.attach.startOver', message: 'Start over' })}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
