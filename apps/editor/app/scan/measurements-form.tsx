'use client'

import { usePascalI18n } from '@pascal-app/core/i18n'
import { Plus, Trash2 } from 'lucide-react'
import { SECONDARY_PILL } from '@/components/app-shell'
import { emptyOpening, type MeasurementsDraft, type OpeningDraft } from '@/lib/scan/measurements'
import { cn } from '@/lib/utils'

const INPUT =
  'h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary aria-invalid:border-red-400'

function MetresInput({
  label,
  value,
  invalid,
  disabled,
  onChange,
}: {
  label: string
  value: string
  invalid: boolean
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="block space-y-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <input
        aria-invalid={invalid || undefined}
        className={INPUT}
        disabled={disabled}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  )
}

export function MeasurementsForm({
  draft,
  invalidFields,
  disabled,
  onChange,
}: {
  draft: MeasurementsDraft
  invalidFields: ReadonlySet<string>
  disabled: boolean
  onChange: (draft: MeasurementsDraft) => void
}) {
  const i18n = usePascalI18n()
  const set = (patch: Partial<MeasurementsDraft>) => onChange({ ...draft, ...patch })
  const setOpening = (index: number, patch: Partial<OpeningDraft>) =>
    set({
      openings: draft.openings.map((opening, i) =>
        i === index ? { ...opening, ...patch } : opening,
      ),
    })

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {i18n._({
          id: 'app.scan.measure.hint',
          message:
            'Enter what you measured, in metres. Leave a field empty when you do not know it; nothing is estimated.',
        })}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <MetresInput
          disabled={disabled}
          invalid={invalidFields.has('width')}
          label={i18n._({ id: 'app.scan.measure.width', message: 'Width (m)' })}
          onChange={(width) => set({ width })}
          value={draft.width}
        />
        <MetresInput
          disabled={disabled}
          invalid={invalidFields.has('length')}
          label={i18n._({ id: 'app.scan.measure.length', message: 'Length (m)' })}
          onChange={(length) => set({ length })}
          value={draft.length}
        />
        <MetresInput
          disabled={disabled}
          invalid={invalidFields.has('height')}
          label={i18n._({ id: 'app.scan.measure.height', message: 'Height (m)' })}
          onChange={(height) => set({ height })}
          value={draft.height}
        />
      </div>

      {draft.openings.map((opening, index) => (
        <div className="space-y-2 rounded-lg border border-border/60 p-3" key={index} role="group">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-sm">
              {opening.kind === 'door'
                ? i18n._({
                    id: 'app.scan.measure.doorTitle',
                    message: 'Door {number}',
                    values: { number: index + 1 },
                  })
                : i18n._({
                    id: 'app.scan.measure.windowTitle',
                    message: 'Window {number}',
                    values: { number: index + 1 },
                  })}
            </p>
            <button
              aria-label={i18n._({
                id: 'app.scan.measure.removeOpening',
                message: 'Remove opening',
              })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
              disabled={disabled}
              onClick={() => set({ openings: draft.openings.filter((_, i) => i !== index) })}
              type="button"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <label className="block space-y-1">
            <span className="text-muted-foreground text-xs">
              {i18n._({ id: 'app.scan.measure.wall', message: 'Wall (e.g. north)' })}
            </span>
            <input
              className={INPUT}
              disabled={disabled}
              maxLength={64}
              onChange={(event) => setOpening(index, { wall: event.target.value })}
              value={opening.wall}
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <MetresInput
              disabled={disabled}
              invalid={invalidFields.has(`openings.${index}.width`)}
              label={i18n._({ id: 'app.scan.measure.width', message: 'Width (m)' })}
              onChange={(width) => setOpening(index, { width })}
              value={opening.width}
            />
            <MetresInput
              disabled={disabled}
              invalid={invalidFields.has(`openings.${index}.height`)}
              label={i18n._({ id: 'app.scan.measure.height', message: 'Height (m)' })}
              onChange={(height) => setOpening(index, { height })}
              value={opening.height}
            />
            <MetresInput
              disabled={disabled}
              invalid={invalidFields.has(`openings.${index}.sill`)}
              label={i18n._({ id: 'app.scan.measure.sill', message: 'Sill (m)' })}
              onChange={(sill) => setOpening(index, { sill })}
              value={opening.sill}
            />
          </div>
        </div>
      ))}

      <div className="grid grid-cols-2 gap-2">
        <button
          className={cn(SECONDARY_PILL, 'h-11')}
          disabled={disabled || draft.openings.length >= 64}
          onClick={() => set({ openings: [...draft.openings, emptyOpening('door')] })}
          type="button"
        >
          <Plus className="h-4 w-4" />
          {i18n._({ id: 'app.scan.measure.addDoor', message: 'Add door' })}
        </button>
        <button
          className={cn(SECONDARY_PILL, 'h-11')}
          disabled={disabled || draft.openings.length >= 64}
          onClick={() => set({ openings: [...draft.openings, emptyOpening('window')] })}
          type="button"
        >
          <Plus className="h-4 w-4" />
          {i18n._({ id: 'app.scan.measure.addWindow', message: 'Add window' })}
        </button>
      </div>

      <label className="block space-y-1">
        <span className="text-muted-foreground text-xs">
          {i18n._({ id: 'app.scan.measure.notes', message: 'Notes' })}
        </span>
        <textarea
          className={cn(INPUT, 'h-20 py-2')}
          disabled={disabled}
          maxLength={2000}
          onChange={(event) => set({ notes: event.target.value })}
          value={draft.notes}
        />
      </label>
    </div>
  )
}
