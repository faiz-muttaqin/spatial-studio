'use client'

import type { OutlineSolution } from '@pascal-app/core/capture'
import { useLocale, usePascalI18n } from '@pascal-app/core/i18n'
import { useState } from 'react'
import { buildRoomFromOutline } from '@/lib/mapping/build-room'
import {
  clampHeight,
  type EdgeTone,
  edgeTone,
  MAX_HEIGHT,
  MIN_HEIGHT,
  parseMetres,
  type ReviewState,
  setRightAngle,
  setTape,
  TONE_COLOURS,
} from '@/lib/mapping/scan-review'
import type { CaptureScan } from '@/lib/mapping/scene-overlays'

type Props = {
  scan: CaptureScan
  state: ReviewState
  solution: OutlineSolution
  selectedEdge: number | null
  onSelectEdge: (edge: number | null) => void
  onChange: (next: ReviewState) => void
  onReset: () => void
  onClose: () => void
  onBuilt: () => void
}

const TONE_LABELS: Record<EdgeTone, { id: string; message: string }> = {
  high: /* i18n */ { id: 'app.review.tone.high', message: 'High confidence' },
  medium: /* i18n */ { id: 'app.review.tone.medium', message: 'Medium confidence' },
  low: /* i18n */ { id: 'app.review.tone.low', message: 'Low confidence' },
  assumed: /* i18n */ { id: 'app.review.tone.assumed', message: 'Assumed' },
  glass: /* i18n */ { id: 'app.review.tone.glass', message: 'Likely glass' },
}

/** The angle at a corner of the outline, in degrees. */
function cornerAngle(polygon: ReadonlyArray<readonly [number, number]>, corner: number): number {
  const n = polygon.length
  const p = polygon[(corner + n - 1) % n]!
  const q = polygon[corner]!
  const s = polygon[(corner + 1) % n]!
  const ux = p[0] - q[0]
  const uz = p[1] - q[1]
  const wx = s[0] - q[0]
  const wz = s[1] - q[1]
  return (Math.atan2(Math.abs(ux * wz - uz * wx), ux * wx + uz * wz) * 180) / Math.PI
}

export function ScanReviewPanel({
  scan,
  state,
  solution,
  selectedEdge,
  onSelectEdge,
  onChange,
  onReset,
  onClose,
  onBuilt,
}: Props) {
  const i18n = usePascalI18n()
  const locale = useLocale()
  const [name, setName] = useState('')
  const [moveScan, setMoveScan] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [resets, setResets] = useState(0)
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })
  const metres = (value: number) =>
    i18n._({
      id: 'app.review.metres',
      message: '{value} m',
      values: { value: number.format(value) },
    })
  const suggested = state.proposal.suggestedScanTransform
  const unresolved = solution.selfIntersecting || !scan.levelId

  const build = () => {
    if (!scan.levelId) return
    const result = buildRoomFromOutline({
      levelId: scan.levelId,
      name: name.trim() || i18n._({ id: 'app.review.defaultName', message: 'Room' }),
      polygon: solution.polygon.map(([x, z]) => [
        Math.round(x * 1000) / 1000,
        Math.round(z * 1000) / 1000,
      ]),
      height: state.height,
      scan:
        moveScan && suggested
          ? {
              id: scan.id,
              transform: {
                position: suggested.position,
                rotation: suggested.rotation,
                scale: suggested.scale,
              },
            }
          : undefined,
    })
    if (!result.ok) {
      setMessage({
        tone: 'error',
        text: i18n._({
          id: 'app.review.buildFailed',
          message: 'The walls were not built: {reason}',
          values: { reason: result.message },
        }),
      })
      return
    }
    setMessage(null)
    onBuilt()
  }

  return (
    <aside
      aria-label={i18n._({ id: 'app.review.title', message: 'Review scan outline' })}
      className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-sidebar-border border-l p-3 text-xs"
      data-testid="scan-review-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium text-sm">
          {i18n._({ id: 'app.review.title', message: 'Review scan outline' })}
        </h2>
        <button className="rounded bg-sidebar-accent px-2 py-1" onClick={onClose} type="button">
          {i18n._({ id: 'app.review.close', message: 'Close' })}
        </button>
      </div>
      <p className="text-sidebar-foreground/70">
        {i18n._({
          id: 'app.review.intro',
          message:
            'This outline is a guess from the scan, not a measurement. Drag corners, type tape lengths and tick right angles, then build the walls.',
        })}
      </p>

      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {(Object.keys(TONE_COLOURS) as EdgeTone[]).map((tone) => (
          <li className="flex items-center gap-1" key={tone}>
            <span
              aria-hidden
              className="inline-block h-2 w-4 rounded-sm"
              style={{ background: TONE_COLOURS[tone] }}
            />
            {i18n._(TONE_LABELS[tone])}
          </li>
        ))}
      </ul>

      {state.proposal.unknowns.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {i18n._({ id: 'app.review.unknowns', message: 'What the scan did not show' })}
          </summary>
          <ul className="mt-1 list-disc pl-4 text-sidebar-foreground/70" lang="en">
            {state.proposal.unknowns.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      <section className="flex flex-col gap-1">
        <h3 className="font-medium text-[11px] text-sidebar-foreground/60 uppercase tracking-wide">
          {i18n._({ id: 'app.review.walls', message: 'Wall lengths' })}
        </h3>
        {solution.edges.map((edge) => {
          const tone = edgeTone(state, edge.index)
          const tape = state.tapes[edge.index]
          const next = solution.measureNext?.edge === edge.index
          return (
            <div
              className={`flex flex-col gap-1 rounded px-1.5 py-1 ${selectedEdge === edge.index ? 'bg-sidebar-accent' : ''}`}
              key={edge.index}
              onFocus={() => onSelectEdge(edge.index)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-3 rounded-sm"
                    style={{ background: TONE_COLOURS[tone] }}
                  />
                  {i18n._({
                    id: 'app.review.wall',
                    message: 'Wall {number}',
                    values: { number: edge.index + 1 },
                  })}
                </span>
                <span className="tabular-nums">
                  {metres(edge.length)}
                  {!edge.measured && Number.isFinite(edge.sigma) && (
                    <span className="text-sidebar-foreground/60">
                      {' '}
                      {i18n._({
                        id: 'app.review.sigma',
                        message: '± {value} m',
                        values: { value: number.format(edge.sigma) },
                      })}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  aria-label={i18n._({
                    id: 'app.review.tapeLabel',
                    message: 'Tape length of wall {number}, in metres',
                    values: { number: edge.index + 1 },
                  })}
                  className="w-full rounded bg-sidebar-accent px-2 py-1 tabular-nums"
                  defaultValue={tape === undefined ? '' : String(tape)}
                  inputMode="decimal"
                  key={`${edge.index}:${resets}`}
                  onChange={(event) => {
                    const raw = event.target.value
                    onChange(
                      setTape(state, edge.index, raw.trim() === '' ? null : parseMetres(raw)),
                    )
                  }}
                  placeholder={i18n._({
                    id: 'app.review.tapePlaceholder',
                    message: 'Tape measure, m',
                  })}
                  type="text"
                />
              </div>
              {next && (
                <span className="text-amber-500">
                  {i18n._({
                    id: 'app.review.measureNext',
                    message: 'Measure this wall next: it is the least certain.',
                  })}
                </span>
              )}
            </div>
          )
        })}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium text-[11px] text-sidebar-foreground/60 uppercase tracking-wide">
          {i18n._({ id: 'app.review.corners', message: 'Right angles' })}
        </h3>
        {solution.polygon.map((_, corner) => (
          <label className="flex items-center justify-between gap-2" key={corner}>
            <span className="flex items-center gap-2">
              <input
                checked={state.rightAngles[corner] ?? false}
                onChange={(event) => onChange(setRightAngle(state, corner, event.target.checked))}
                type="checkbox"
              />
              {i18n._({
                id: 'app.review.corner',
                message: 'Corner {number}',
                values: { number: corner + 1 },
              })}
            </span>
            <span className="text-sidebar-foreground/60 tabular-nums">
              {i18n._({
                id: 'app.review.degrees',
                message: '{value}°',
                values: { value: Math.round(cornerAngle(solution.polygon, corner)) },
              })}
            </span>
          </label>
        ))}
      </section>

      {solution.conflicts.length > 0 && (
        <div className="rounded bg-red-950/60 p-2" role="alert">
          <p className="font-medium">
            {i18n._({ id: 'app.review.conflicts', message: 'These do not fit together:' })}
          </p>
          <ul className="mt-1 list-disc pl-4">
            {solution.conflicts.map((entry) => (
              <li key={entry.constraint}>
                {entry.type === 'distance'
                  ? i18n._({
                      id: 'app.review.conflictDistance',
                      message:
                        'A tape length is off by {value} m. Check the tapes against each other.',
                      values: { value: number.format(Math.abs(entry.error)) },
                    })
                  : i18n._({
                      id: 'app.review.conflictAngle',
                      message: 'A right angle is off by {value}°. The tapes do not allow it.',
                      values: { value: number.format(Math.abs(entry.error)) },
                    })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {solution.selfIntersecting && (
        <p className="rounded bg-red-950/60 p-2" role="alert">
          {i18n._({
            id: 'app.review.crosses',
            message: 'The outline crosses itself. Move a corner before building.',
          })}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <label className="flex items-center justify-between gap-2">
          <span>{i18n._({ id: 'app.review.height', message: 'Ceiling height, m' })}</span>
          <input
            className="w-20 rounded bg-sidebar-accent px-2 py-1 tabular-nums"
            defaultValue={String(state.height)}
            inputMode="decimal"
            key={`h:${resets}`}
            onChange={(event) => {
              const value = parseMetres(event.target.value)
              if (value !== null && value >= MIN_HEIGHT && value <= MAX_HEIGHT)
                onChange({ ...state, height: clampHeight(value) })
            }}
            type="text"
          />
        </label>
        {state.proposal.height && (
          <span className="text-sidebar-foreground/60">
            {i18n._({
              id: 'app.review.heightFrom',
              message: 'From the scan: {value} m (an estimate).',
              values: { value: number.format(state.proposal.height.value) },
            })}
          </span>
        )}
        <label className="flex items-center justify-between gap-2">
          <span>{i18n._({ id: 'app.review.name', message: 'Room name' })}</span>
          <input
            className="w-32 rounded bg-sidebar-accent px-2 py-1"
            onChange={(event) => setName(event.target.value)}
            placeholder={i18n._({ id: 'app.review.defaultName', message: 'Room' })}
            type="text"
            value={name}
          />
        </label>
        {suggested && (
          <label className="flex items-start gap-2">
            <input
              checked={moveScan}
              className="mt-0.5"
              onChange={(event) => setMoveScan(event.target.checked)}
              type="checkbox"
            />
            <span>
              {i18n._({
                id: 'app.review.moveScan',
                message: 'Also lower the scan so its detected floor sits at the level floor.',
              })}
              {suggested.confidence === 'low' && (
                <span className="text-amber-500">
                  {' '}
                  {i18n._({
                    id: 'app.review.moveScanLow',
                    message: 'The floor height was estimated from depth and may be off.',
                  })}
                </span>
              )}
            </span>
          </label>
        )}
      </section>

      {message && (
        <p className={message.tone === 'error' ? 'text-red-400' : 'text-green-400'} role="status">
          {message.text}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="flex-1 rounded bg-sidebar-accent px-2 py-1.5"
          onClick={() => {
            setResets((count) => count + 1)
            setMessage(null)
            onReset()
          }}
          type="button"
        >
          {i18n._({ id: 'app.review.reset', message: 'Start over' })}
        </button>
        <button
          className="flex-1 rounded bg-primary px-2 py-1.5 font-medium text-primary-foreground disabled:opacity-40"
          data-testid="scan-review-build"
          disabled={unresolved}
          onClick={build}
          type="button"
        >
          {i18n._({ id: 'app.review.build', message: 'Build walls' })}
        </button>
      </div>
      <p className="text-sidebar-foreground/60">
        {i18n._({
          id: 'app.review.undoHint',
          message: 'Building is one step in the undo history.',
        })}
      </p>
    </aside>
  )
}
