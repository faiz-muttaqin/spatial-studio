'use client'

import {
  type BrowserCapabilities,
  CAPTURE_MAX_KEYFRAMES,
  type DeviceCapabilities,
} from '@pascal-app/core/capture'
import { usePascalI18n } from '@pascal-app/core/i18n'
import { CheckCircle2, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader, AppShell, PRIMARY_PILL, SECONDARY_PILL } from '@/components/app-shell'
import { type PreparedArtifact, prepareArtifact, uploadArtifacts } from '@/lib/scan/artifacts'
import {
  attachScanToProject,
  createProjectWithScan,
  listProjects,
  type ProjectSummary,
  type ScanAttachment,
} from '@/lib/scan/attach'
import { buildBrowserPhotoBundle } from '@/lib/scan/browser-photo-bundle'
import { describeBrowserDevice, probeBrowserCapabilities } from '@/lib/scan/capabilities'
import { EMPTY_MEASUREMENTS, measurementsFromDraft } from '@/lib/scan/measurements'
import {
  createNativeBridgeClient,
  findNativeBridge,
  type NativeBridgeClient,
  type ScanUploadResult,
} from '@/lib/scan/native-bridge'
import { downscaleToJpeg } from '@/lib/scan/photo'
import { captureName, newCaptureSessionId } from '@/lib/scan/session'
import { cn } from '@/lib/utils'
import { CapabilityPanel, type NativeProbe } from './capability-panel'
import { type Destination, DestinationPicker } from './destination-picker'
import { MeasurementsForm } from './measurements-form'
import { NativeScan } from './native-scan'
import { type CapturedPhoto, PhotoCapture } from './photo-capture'

type PhotoItem = CapturedPhoto & { timestamp: number; artifact: PreparedArtifact }

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; done: number; total: number }
  | { kind: 'attaching' }
  | { kind: 'done'; sceneId: string; manifestUrl: string }
  | {
      kind: 'failed'
      reason: 'noPhotos' | 'measurements' | 'upload' | 'attach'
      detail?: string
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
  const [draft, setDraft] = useState(EMPTY_MEASUREMENTS)
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set())
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [destination, setDestination] = useState<Destination>({ kind: 'new', name: '' })
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const photosRef = useRef(photos)
  photosRef.current = photos

  useEffect(() => {
    let active = true
    probeBrowserCapabilities().then((result) => active && setBrowser(result))
    listProjects().then(
      (result) => active && setProjects(result),
      () => active && setProjects([]),
    )
    return () => {
      active = false
    }
  }, [])

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

  const addFiles = useCallback(async (files: File[]) => {
    const room = CAPTURE_MAX_KEYFRAMES - photosRef.current.length
    const accepted = files.slice(0, Math.max(0, room))
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
          timestamp: file.lastModified || Date.now(),
          artifact,
        }
        setPhotos((current) => [...current, item])
      } catch {
        setUnreadablePhotos((count) => count + 1)
      } finally {
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

  const attach = async (attachment: ScanAttachment) => {
    setPhase({ kind: 'attaching' })
    try {
      const result =
        destination.kind === 'existing'
          ? await attachScanToProject(destination.sceneId, attachment)
          : await createProjectWithScan(destination.name.trim() || attachment.name, attachment)
      setPhase({ kind: 'done', sceneId: result.sceneId, manifestUrl: attachment.manifestUrl })
    } catch (error) {
      setPhase({ kind: 'failed', reason: 'attach', detail: (error as Error).message })
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

    const createdAt = new Date()
    const sessionId = newCaptureSessionId()
    let manifestUrl: string
    try {
      const capabilities: DeviceCapabilities = {
        probedAt: Date.now(),
        browser: browser ?? (await probeBrowserCapabilities()),
        native: native.state === 'ready' ? native.capabilities : null,
      }
      const bundle = await buildBrowserPhotoBundle({
        sessionId,
        projectId: destination.kind === 'existing' ? destination.sceneId : undefined,
        appVersion,
        createdAt,
        device: await describeBrowserDevice(),
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
      const total = new Set(bundle.artifacts.map((artifact) => artifact.sha256)).size + 1
      setPhase({ kind: 'uploading', done: 0, total })
      await uploadArtifacts(bundle.artifacts, {
        onProgress: (progress) => setPhase({ kind: 'uploading', done: progress.done, total }),
      })
      // The manifest goes last, so a stored manifest never points at a missing artifact.
      await uploadArtifacts([bundle.manifestArtifact])
      setPhase({ kind: 'uploading', done: total, total })
      manifestUrl = bundle.manifestUrl
    } catch (error) {
      setPhase({ kind: 'failed', reason: 'upload', detail: (error as Error).message })
      return
    }
    await attach({ name: captureName(createdAt), sessionId, manifestUrl })
  }

  const onNativeUploaded = (result: ScanUploadResult) =>
    attach({
      name: captureName(new Date()),
      sessionId: result.sessionId,
      manifestUrl: result.manifestUrl,
    })

  const startOver = () => {
    for (const photo of photos) URL.revokeObjectURL(photo.previewUrl)
    setPhotos([])
    setDraft(EMPTY_MEASUREMENTS)
    setUnreadablePhotos(0)
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
                    disabled={busy}
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
                disabled={busy}
                onChange={setDestination}
                projects={projects}
              />
            </Section>

            {provider === 'native' && client && native.state === 'ready' ? (
              <Section title={i18n._({ id: 'app.scan.section.native', message: 'Companion scan' })}>
                <NativeScan
                  client={client}
                  depth={native.capabilities?.arcore.depth ?? false}
                  disabled={busy}
                  onUploaded={onNativeUploaded}
                  projectId={destination.kind === 'existing' ? destination.sceneId : undefined}
                />
              </Section>
            ) : (
              <>
                <Section title={i18n._({ id: 'app.scan.section.photos', message: 'Photos' })}>
                  <PhotoCapture
                    disabled={busy}
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
                    disabled={busy}
                    draft={draft}
                    invalidFields={invalidFields}
                    onChange={setDraft}
                  />
                </Section>

                <button
                  className={cn(PRIMARY_PILL, 'h-12 w-full text-base')}
                  data-testid="scan-submit"
                  disabled={busy || processing > 0}
                  onClick={submitPhotos}
                  type="button"
                >
                  {destinationLabel}
                </button>
              </>
            )}

            <PhaseMessage phase={phase} />
          </>
        )}
      </main>
    </AppShell>
  )
}

function PhaseMessage({ phase }: { phase: Phase }) {
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
    <div className="space-y-1 text-sm" role="alert">
      <p className="text-red-400">{message}</p>
      {phase.detail ? <p className="text-muted-foreground text-xs">{phase.detail}</p> : null}
    </div>
  )
}
