'use client'

import { type PascalI18n, type ScanNode, useLocale, usePascalI18n, useScene } from '@pascal-app/core'
import {
  type CaptureSource,
  type RgbKeyframe,
  captureLayerKey,
  captureStreamLabel,
} from '@pascal-app/core/capture'
import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCaptureSourceResolver } from '../../../lib/capture-source-context'
import { loadScanEvidence, type ScanEvidence } from '../../../lib/scan-evidence/load'
import { selectKeyframePage } from '../../../lib/scan-evidence/shape'
import { PanelSection } from '../controls/panel-section'

type CaptureScan = ScanNode & { captureSession: NonNullable<ScanNode['captureSession']> }

type EvidenceState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; evidence: ScanEvidence; source: CaptureSource }

// Streams that carry evidence for review, not a drawable layer.
const EVIDENCE_KINDS = new Set([
  'rgb-keyframes',
  'depth-keyframes',
  'plane-set',
  'manual-measurements',
  'device-capabilities',
])

const LAYER_LABELS: Record<string, { id: string; message: string }> = {
  deviceMotion: { id: 'editor.panels.scanEvidence.layer.deviceMotion', message: 'Camera path' },
  model: { id: 'editor.panels.scanEvidence.layer.model', message: '3D model' },
  pointCloud: { id: 'editor.panels.scanEvidence.layer.pointCloud', message: 'Point cloud' },
  surfaceMesh: { id: 'editor.panels.scanEvidence.layer.surfaceMesh', message: 'Surface mesh' },
}

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
        if (!abort.signal.aborted) setState({ status: 'error' })
      }
    })()
    return () => abort.abort()
    // The locator is read through `sessionKey`; a new object with the same fields must not refetch.
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on sessionKey
  }, [resolver, sessionKey])

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
          {state.status === 'loading'
            ? i18n._({ id: 'editor.panels.scanEvidence.loading', message: 'Loading capture data…' })
            : i18n._({
                id: 'editor.panels.scanEvidence.unavailable',
                message: 'The capture data could not be loaded.',
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
            const known = LAYER_LABELS[key]
            const label = known ? i18n._(known) : captureStreamLabel(stream)
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
        value={session.provider ?? unknown}
      />
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
            {session.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
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
      {open && <Lightbox frame={open} i18n={i18n} onClose={() => setOpen(null)} source={source} />}
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // The panel animates with transforms, which would pin a fixed overlay inside it.
  return createPortal(
    <div
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
