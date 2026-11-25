'use client'

import { type AnyNodeId, type ScanNode, useScene } from '@pascal-app/core'
import type { OutlineSolution } from '@pascal-app/core/capture'
import { useLocale, usePascalI18n } from '@pascal-app/core/i18n'
import { useEffect, useState } from 'react'
import { buildRoomFromOutline } from '@/lib/mapping/build-room'
import {
  clampHeight,
  type EdgeTone,
  edgeTone,
  heightInRange,
  MAX_HEIGHT,
  MIN_HEIGHT,
  parseMetres,
  type ReviewState,
  scanPlacementNow,
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

type Translate = ReturnType<typeof usePascalI18n>

/** Names the wall, corner and tape a conflict is about, numbered from 1 as the panel is. */
function conflictText(
  entry: OutlineSolution['conflicts'][number],
  number: Intl.NumberFormat,
  i18n: Translate,
): string {
  const c = entry.detail
  const amount = number.format(Math.abs(entry.error))
  switch (c.type) {
    case 'distance':
      return i18n._({
        id: 'app.review.conflictTape',
        message:
          'The tape of {tape} m between corners {a} and {b} comes out {value} m off. It disagrees with the other tapes or right angles.',
        values: { tape: number.format(c.value), a: c.a + 1, b: c.b + 1, value: amount },
      })
    case 'rightAngle':
      return i18n._({
        id: 'app.review.conflictCorner',
        message: 'The right angle at corner {corner} is {value}° off. The tapes do not allow it.',
        values: { corner: c.corner + 1, value: amount },
      })
    case 'parallel':
      return i18n._({
        id: 'app.review.conflictParallel',
        message: 'Walls {a} and {b} are {value}° from parallel.',
        values: { a: c.edgeA + 1, b: c.edgeB + 1, value: amount },
      })
    case 'equalLength':
      return i18n._({
        id: 'app.review.conflictEqual',
        message: 'Walls {a} and {b} differ by {value} m.',
        values: { a: c.edgeA + 1, b: c.edgeB + 1, value: amount },
      })
    case 'fixed':
      return i18n._({
        id: 'app.review.conflictFixed',
        message: 'Corner {corner} moved {value} m although it was fixed.',
        values: { corner: c.corner + 1, value: amount },
      })
  }
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
  const [tapeErrors, setTapeErrors] = useState<Record<number, boolean>>({})
  const [heightError, setHeightError] = useState(false)
  // A build over a conflict or a fit that did not settle asks twice: the first press warns.
  const [warned, setWarned] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: any change to the fit withdraws the warning
  useEffect(() => setWarned(false), [solution])
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

  const doubtful = solution.conflicts.length > 0 || !solution.converged
  const build = () => {
    if (!scan.levelId) return
    if (doubtful && !warned) {
      setWarned(true)
      return
    }
    const live = useScene.getState().nodes[scan.id as AnyNodeId] as ScanNode | undefined
    const placement =
      moveScan && live
        ? scanPlacementNow(state.proposal, {
            position: live.position,
            rotation: live.rotation,
            scale: live.scale,
          })
        : null
    const result = buildRoomFromOutline({
      levelId: scan.levelId,
      name: name.trim() || i18n._({ id: 'app.review.defaultName', message: 'Room' }),
      polygon: solution.polygon.map(([x, z]) => [
        Math.round(x * 1000) / 1000,
        Math.round(z * 1000) / 1000,
      ]),
      height: state.height,
      scan: placement ? { id: scan.id, transform: placement } : undefined,
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
                    if (raw.trim() === '') {
                      setTapeErrors((current) => ({ ...current, [edge.index]: false }))
                      onChange(setTape(state, edge.index, null))
                      return
                    }
                    // A typed length that is not one keeps the last good tape and says so.
                    const value = parseMetres(raw)
                    setTapeErrors((current) => ({ ...current, [edge.index]: value === null }))
                    if (value !== null) onChange(setTape(state, edge.index, value))
                  }}
                  placeholder={i18n._({
                    id: 'app.review.tapePlaceholder',
                    message: 'Tape measure, m',
                  })}
                  type="text"
                />
              </div>
              {tapeErrors[edge.index] && (
                <span className="text-red-400" role="alert">
                  {i18n._({
                    id: 'app.review.tapeInvalid',
                    message: 'Enter a length in metres, more than 0 and at most 200.',
                  })}
                </span>
              )}
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
              <li key={entry.constraint}>{conflictText(entry, number, i18n)}</li>
            ))}
          </ul>
        </div>
      )}
      {!solution.converged && (
        <p className="rounded bg-red-950/60 p-2" role="alert">
          {i18n._({
            id: 'app.review.notConverged',
            message:
              'The fit did not settle, so these lengths may be off. Remove a tape or a right angle and try again.',
          })}
        </p>
      )}
      {Math.abs(solution.scale - 1) >= 0.001 && (
        <p className="text-sidebar-foreground/60">
          {i18n._({
            id: 'app.review.scale',
            message:
              'The fit scaled the outline by {percent}%. The scan itself is not rescaled, so its picture and the walls can differ by that much.',
            values: { percent: number.format((solution.scale - 1) * 100) },
          })}
        </p>
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
              const valid = value !== null && heightInRange(value)
              setHeightError(!valid)
              if (valid) onChange({ ...state, height: clampHeight(value) })
            }}
            type="text"
          />
        </label>
        {heightError && (
          <span className="text-red-400" role="alert">
            {i18n._({
              id: 'app.review.heightInvalid',
              message: 'The ceiling height must be between {min} m and {max} m.',
              values: { min: MIN_HEIGHT, max: MAX_HEIGHT },
            })}
          </span>
        )}
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

      {warned && (
        <p className="text-amber-500" role="alert">
          {i18n._({
            id: 'app.review.buildWarning',
            message:
              'The outline still has problems shown above. Press again to build it as it is, or fix them first.',
          })}
        </p>
      )}
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
          {warned
            ? i18n._({ id: 'app.review.buildAnyway', message: 'Build anyway' })
            : i18n._({ id: 'app.review.build', message: 'Build walls' })}
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
