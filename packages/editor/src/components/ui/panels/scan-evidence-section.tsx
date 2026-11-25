'use client'

import { type PascalI18n, type ScanNode, useLocale, usePascalI18n, useScene } from '@pascal-app/core'
import {
  type CaptureSource,
  type RgbKeyframe,
  captureLayerKey,
  captureStreamLabel,
} from '@pascal-app/core/capture'
import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCaptureSourceResolver } from '../../../lib/capture-source-context'
import { openEditorView } from '../../../lib/editor-views'
import { loadScanEvidence, type ScanEvidence } from '../../../lib/scan-evidence/load'
import { selectKeyframePage } from '../../../lib/scan-evidence/shape'
import { useScanReview } from '../../../store/use-scan-review'
import { PanelSection } from '../controls/panel-section'

type CaptureScan = ScanNode & { captureSession: NonNullable<ScanNode['captureSession']> }

type EvidenceState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-manifest' }
  | { status: 'ready'; evidence: ScanEvidence; source: CaptureSource }

// Streams that carry evidence for review, not a drawable layer.
const EVIDENCE_KINDS = new Set([
  'rgb-keyframes',
  'depth-keyframes',
  'plane-set',
  'manual-measurements',
  'device-capabilities',
])

export function ScanEvidenceSection({ node }: { node: ScanNode }) {
  if (!node.captureSession) return null
  return <ScanEvidenceContent node={node as CaptureScan} />
}

function ScanEvidenceContent({ node }: { node: CaptureScan }) {
  const i18n = usePascalI18n()
  const locale = useLocale()
  const resolver = useCaptureSourceResolver()
  const updateNode = useScene((state) => state.updateNode)
  const [state, setState] = useState<EvidenceState>({ status: 'loading' })
  const session = node.captureSession
  const sessionKey = [session.sessionId, session.manifestUrl ?? '', session.revisionId ?? ''].join('|')

  useEffect(() => {
    if (!resolver) return
    const abort = new AbortController()
    setState({ status: 'loading' })
    void (async () => {
      try {
        const source = await resolver(session)
        const evidence = await loadScanEvidence(source, { signal: abort.signal })
        if (!abort.signal.aborted) setState({ evidence, source, status: 'ready' })
      } catch {
        if (abort.signal.aborted) return
        setState({ status: session.manifestUrl ? 'error' : 'no-manifest' })
      }
    })()
    return () => abort.abort()
    // The locator is read through `sessionKey`; a new object with the same fields must not refetch.
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on sessionKey
  }, [resolver, sessionKey])

  const reviewViewId = useScanReview((review) => review.viewId)
  const requestReview = useScanReview((review) => review.request)
  const setLayer = useCallback(
    (key: string, visible: boolean) =>
      updateNode(node.id, { layers: { ...node.layers, [key]: visible } }),
    [node.id, node.layers, updateNode],
  )

  if (!resolver) return null
  const title = i18n._({ id: 'editor.panels.scanEvidence.title', message: 'Scan evidence' })

  if (state.status !== 'ready') {
    return (
      <PanelSection title={title}>
        <p className="text-muted-foreground text-xs" role="status">
          {state.status === 'loading' &&
            i18n._({ id: 'editor.panels.scanEvidence.loading', message: 'Loading capture data…' })}
          {state.status === 'error' &&
            i18n._({
              id: 'editor.panels.scanEvidence.unavailable',
              message: 'The capture data could not be loaded.',
            })}
          {state.status === 'no-manifest' &&
            i18n._({
              id: 'editor.panels.scanEvidence.noManifest',
              message: 'This scan has no capture manifest, so there is no evidence to show.',
            })}
        </p>
      </PanelSection>
    )
  }

  const { evidence, source } = state
  const layers = evidence.descriptor.streams
    .filter((stream) => !EVIDENCE_KINDS.has(stream.kind) && stream.availability !== 'failed')
    .map((stream) => ({ key: captureLayerKey(stream), stream }))
    .filter(({ key }, index, all) => all.findIndex((other) => other.key === key) === index)

  return (
    <PanelSection title={title}>
      <SessionFacts evidence={evidence} i18n={i18n} locale={locale} />
      {Object.entries(evidence.notReady).map(([part, availability]) => (
        <p className="text-amber-600 text-xs" key={part} role="status">
          {notReadyMessage(part, availability, i18n)}
        </p>
      ))}
      {evidence.problems.length > 0 && (
        <p className="text-amber-600 text-xs" role="alert">
          {i18n._({
            id: 'editor.panels.scanEvidence.partial',
            message: 'Some evidence in this capture could not be read.',
          })}
        </p>
      )}
      {layers.length > 0 && (
        <Group label={i18n._({ id: 'editor.panels.scanEvidence.layers', message: 'Layers' })}>
          {layers.map(({ key, stream }) => {
            const label = layerLabel(key, i18n) ?? captureStreamLabel(stream)
            return (
              <label className="flex items-center gap-2 text-xs" key={key}>
                <input
                  checked={node.layers[key] ?? true}
                  onChange={(event) => setLayer(key, event.target.checked)}
                  type="checkbox"
                />
                {label}
              </label>
            )
          })}
        </Group>
      )}
      {reviewViewId && (
        <button
          className="mt-1 w-full rounded-md border border-border/50 px-2.5 py-1.5 font-medium text-xs transition-colors hover:bg-accent"
          onClick={() => {
            requestReview(node.id)
            openEditorView(reviewViewId)
          }}
          type="button"
        >
          {i18n._({ id: 'editor.panels.scanEvidence.review', message: 'Review scan' })}
        </button>
      )}
      {evidence.measurements && (
        <MeasurementFacts i18n={i18n} measurements={evidence.measurements} />
      )}
      {evidence.planes && <PlaneFacts i18n={i18n} planes={evidence.planes} />}
      {evidence.keyframes && evidence.keyframes.frames.length > 0 && (
        <KeyframeStrip i18n={i18n} index={evidence.keyframes} source={source} />
      )}
    </PanelSection>
  )
}

function partLabel(part: string, i18n: PascalI18n): string {
  if (part === 'planes') {
    return i18n._({ id: 'editor.panels.scanEvidence.planes', message: 'Detected planes' })
  }
  if (part === 'measurements') {
    return i18n._({ id: 'editor.panels.scanEvidence.measurements', message: 'Manual measurements' })
  }
  return i18n._({ id: 'editor.panels.scanEvidence.photosName', message: 'Photos' })
}

function layerLabel(key: string, i18n: PascalI18n): string | null {
  switch (key) {
    case 'deviceMotion':
      return i18n._({ id: 'editor.panels.scanEvidence.layer.deviceMotion', message: 'Camera path' })
    case 'model':
      return i18n._({ id: 'editor.panels.scanEvidence.layer.model', message: '3D model' })
    case 'pointCloud':
      return i18n._({ id: 'editor.panels.scanEvidence.layer.pointCloud', message: 'Point cloud' })
    case 'surfaceMesh':
      return i18n._({ id: 'editor.panels.scanEvidence.layer.surfaceMesh', message: 'Surface mesh' })
    default:
      return null
  }
}

function providerLabel(provider: string, i18n: PascalI18n): string {
  switch (provider) {
    case 'android-arcore':
      return i18n._({ id: 'editor.panels.scanEvidence.provider.androidArcore', message: 'Android (ARCore)' })
    case 'browser-photo':
      return i18n._({ id: 'editor.panels.scanEvidence.provider.browserPhoto', message: 'Browser photos' })
    case 'webxr':
      return i18n._({ id: 'editor.panels.scanEvidence.provider.webxr', message: 'WebXR' })
    default:
      return provider
  }
}

function stateLabel(state: string, i18n: PascalI18n): string | null {
  switch (state) {
    case 'failed':
      return i18n._({ id: 'editor.panels.scanEvidence.state.failed', message: 'Failed' })
    case 'finalizing':
      return i18n._({ id: 'editor.panels.scanEvidence.state.finalizing', message: 'Finalising' })
    case 'live':
      return i18n._({ id: 'editor.panels.scanEvidence.state.live', message: 'Live' })
    default:
      return null
  }
}

function notReadyMessage(part: string, availability: 'failed' | 'pending', i18n: PascalI18n): string {
  const values = { part: partLabel(part, i18n) }
  return availability === 'failed'
    ? i18n._({
        id: 'editor.panels.scanEvidence.partFailed',
        message: '{part}: the capture could not produce this.',
        values,
      })
    : i18n._({
        id: 'editor.panels.scanEvidence.partPending',
        message: '{part}: not ready yet.',
        values,
      })
}

function Group({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right">{value}</span>
    </div>
  )
}

function metres(value: number | null, locale: string): string {
  return value === null
    ? '–'
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value)} m`
}

function SessionFacts({
  evidence,
  i18n,
  locale,
}: {
  evidence: ScanEvidence
  i18n: PascalI18n
  locale: string
}) {
  const { session } = evidence
  const time = session.capturedAt ? new Date(session.capturedAt) : null
  const capturedAt =
    time && !Number.isNaN(time.getTime())
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
      : null
  const unknown = '–'
  return (
    <div className="flex flex-col gap-1">
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.provider', message: 'Provider' })}
        value={session.provider ? providerLabel(session.provider, i18n) : unknown}
      />
      {stateLabel(session.state, i18n) && (
        <Fact
          label={i18n._({ id: 'editor.panels.scanEvidence.status', message: 'Status' })}
          value={stateLabel(session.state, i18n)}
        />
      )}
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.device', message: 'Device' })}
        value={session.device ?? unknown}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.capturedAt', message: 'Captured' })}
        value={capturedAt ?? unknown}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.cameraConvention', message: 'Camera axes' })}
        value={session.cameraConvention ?? unknown}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.trackingLoss', message: 'Tracking losses' })}
        value={session.trackingLossCount ?? unknown}
      />
      {session.warnings.length > 0 && (
        <Group label={i18n._({ id: 'editor.panels.scanEvidence.warnings', message: 'Warnings' })}>
          <ul className="list-disc pl-4 text-xs">
            {session.warnings.map((warning, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: warnings may repeat
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
          </ul>
        </Group>
      )}
    </div>
  )
}

function MeasurementFacts({
  i18n,
  measurements,
}: {
  i18n: PascalI18n
  measurements: NonNullable<ScanEvidence['measurements']>
}) {
  const locale = useLocale()
  return (
    <Group
      label={i18n._({ id: 'editor.panels.scanEvidence.measurements', message: 'Manual measurements' })}
    >
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.roomWidth', message: 'Width' })}
        value={metres(measurements.width, locale)}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.roomLength', message: 'Length' })}
        value={metres(measurements.length, locale)}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.roomHeight', message: 'Height' })}
        value={metres(measurements.height, locale)}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.openings', message: 'Doors, windows' })}
        value={`${measurements.doors}, ${measurements.windows}`}
      />
      {measurements.notes && <p className="whitespace-pre-wrap text-xs">{measurements.notes}</p>}
    </Group>
  )
}

function PlaneFacts({
  i18n,
  planes,
}: {
  i18n: PascalI18n
  planes: NonNullable<ScanEvidence['planes']>
}) {
  const locale = useLocale()
  return (
    <Group label={i18n._({ id: 'editor.panels.scanEvidence.planes', message: 'Detected planes' })}>
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.planesFloors', message: 'Floor-facing' })}
        value={planes.horizontalUp}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.planesCeilings', message: 'Ceiling-facing' })}
        value={planes.horizontalDown}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.planesWalls', message: 'Vertical' })}
        value={planes.vertical}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.floorHeight', message: 'Floor height' })}
        value={metres(planes.floorHeight, locale)}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.ceilingHeight', message: 'Ceiling height' })}
        value={metres(planes.ceilingHeight, locale)}
      />
      <Fact
        label={i18n._({ id: 'editor.panels.scanEvidence.clearHeight', message: 'Floor to ceiling' })}
        value={metres(planes.clearHeight, locale)}
      />
      <p className="text-[11px] text-muted-foreground">
        {i18n._({
          id: 'editor.panels.scanEvidence.planesNote',
          message: 'Heights are in the capture’s own frame. Merged planes are counted once.',
        })}
      </p>
    </Group>
  )
}

function KeyframeStrip({
  i18n,
  index,
  source,
}: {
  i18n: PascalI18n
  index: NonNullable<ScanEvidence['keyframes']>
  source: CaptureSource
}) {
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<RgbKeyframe | null>(null)
  const closeLightbox = useCallback(() => setOpen(null), [])
  const current = useMemo(() => selectKeyframePage(index, page), [index, page])

  return (
    <Group
      label={i18n._({
        id: 'editor.panels.scanEvidence.photos',
        message: 'Photos ({count})',
        values: { count: current.total },
      })}
    >
      <div className="grid grid-cols-4 gap-1">
        {current.frames.map((frame) => (
          <KeyframeThumb frame={frame} i18n={i18n} key={frame.id} onOpen={setOpen} source={source} />
        ))}
      </div>
      {current.pageCount > 1 && (
        <div className="flex items-center justify-between pt-1 text-xs">
          <button
            className="rounded px-2 py-0.5 hover:bg-accent disabled:opacity-40"
            disabled={current.page === 0}
            onClick={() => setPage(current.page - 1)}
            type="button"
          >
            {i18n._({ id: 'editor.panels.scanEvidence.previousPage', message: 'Previous' })}
          </button>
          <span className="text-muted-foreground">
            {i18n._({
              id: 'editor.panels.scanEvidence.pageOf',
              message: '{page} of {pages}',
              values: { page: current.page + 1, pages: current.pageCount },
            })}
          </span>
          <button
            className="rounded px-2 py-0.5 hover:bg-accent disabled:opacity-40"
            disabled={current.page >= current.pageCount - 1}
            onClick={() => setPage(current.page + 1)}
            type="button"
          >
            {i18n._({ id: 'editor.panels.scanEvidence.nextPage', message: 'Next' })}
          </button>
        </div>
      )}
      {open && <Lightbox frame={open} i18n={i18n} onClose={closeLightbox} source={source} />}
    </Group>
  )
}

function useFrameImageUrl(source: CaptureSource, frame: RgbKeyframe): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!source.resolveArtifact) return
    const abort = new AbortController()
    let dispose: (() => void) | undefined
    setUrl(null)
    source
      .resolveArtifact(
        {
          id: frame.id,
          mediaType: 'image/jpeg',
          sha256: frame.image.sha256,
          uri: frame.image.uri,
        },
        abort.signal,
      )
      .then((result) => {
        if (abort.signal.aborted) {
          result.dispose?.()
          return
        }
        dispose = result.dispose
        setUrl(result.url)
      })
      .catch(() => {})
    return () => {
      abort.abort()
      dispose?.()
    }
  }, [source, frame])
  return url
}

function KeyframeThumb({
  frame,
  i18n,
  onOpen,
  source,
}: {
  frame: RgbKeyframe
  i18n: PascalI18n
  onOpen: (frame: RgbKeyframe) => void
  source: CaptureSource
}) {
  const url = useFrameImageUrl(source, frame)
  return (
    <button
      aria-label={i18n._({ id: 'editor.panels.scanEvidence.enlarge', message: 'Enlarge photo' })}
      className="aspect-square overflow-hidden rounded bg-muted"
      onClick={() => onOpen(frame)}
      type="button"
    >
      {url && (
        // biome-ignore lint/performance/noImgElement: capture artifacts are same-origin, not optimised assets
        <img
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          height={frame.height}
          loading="lazy"
          src={url}
          width={frame.width}
        />
      )}
    </button>
  )
}

function Lightbox({
  frame,
  i18n,
  onClose,
  source,
}: {
  frame: RgbKeyframe
  i18n: PascalI18n
  onClose: () => void
  source: CaptureSource
}) {
  const url = useFrameImageUrl(source, frame)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    // Capture phase on window: Escape closes the photo and never reaches editor shortcuts.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      opener?.focus()
    }
  }, [onClose])
  // The panel animates with transforms, which would pin a fixed overlay inside it.
  return createPortal(
    <div
      aria-label={i18n._({ id: 'editor.panels.scanEvidence.photoDialog', message: 'Capture photo' })}
      aria-modal="true"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      onKeyDown={undefined}
      role="dialog"
    >
      <button
        aria-label={i18n._({ id: 'editor.panels.scanEvidence.close', message: 'Close photo' })}
        className="absolute top-4 right-4 rounded-full bg-black/60 p-2 text-white"
        onClick={onClose}
        ref={closeRef}
        type="button"
      >
        <X className="h-4 w-4" />
      </button>
      {url && (
        // biome-ignore lint/performance/noImgElement: capture artifacts are same-origin, not optimised assets
        <img alt="" className="max-h-full max-w-full object-contain" src={url} />
      )}
    </div>,
    document.body,
  )
}
