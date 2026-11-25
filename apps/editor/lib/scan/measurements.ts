import type { ManualMeasurements } from '@pascal-app/core/capture'

export type OpeningDraft = {
  kind: 'door' | 'window'
  wall: string
  width: string
  height: string
  sill: string
}

/** What the measurements form holds: raw text, so a half-typed value is not lost. */
export type MeasurementsDraft = {
  width: string
  length: string
  height: string
  openings: OpeningDraft[]
  notes: string
}

export const EMPTY_MEASUREMENTS: MeasurementsDraft = {
  width: '',
  length: '',
  height: '',
  openings: [],
  notes: '',
}

export function emptyOpening(kind: OpeningDraft['kind']): OpeningDraft {
  return { kind, wall: '', width: '', height: '', sill: kind === 'door' ? '0' : '' }
}

/** Blank is unknown (null); a comma decimal separator is accepted. */
function parseNumber(value: string, allowZero: boolean): number | null | undefined {
  const trimmed = value.trim().replace(',', '.')
  if (trimmed === '') return null
  if (!/^\d*\.?\d+$/.test(trimmed)) return undefined
  const number = Number(trimmed)
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) return undefined
  return number
}

export type MeasurementsResult =
  | { ok: true; value: ManualMeasurements }
  | { ok: false; invalidFields: string[] }

/**
 * Converts the form to the `manual-measurements` payload. Field keys of
 * invalid entries come back so the form can mark them; nothing is guessed.
 */
export function measurementsFromDraft(draft: MeasurementsDraft): MeasurementsResult {
  const invalidFields: string[] = []
  const read = (key: string, value: string, allowZero = false) => {
    const parsed = parseNumber(value, allowZero)
    if (parsed === undefined) invalidFields.push(key)
    return parsed ?? null
  }

  const room = {
    width: read('width', draft.width),
    length: read('length', draft.length),
    height: read('height', draft.height),
  }
  const openings = draft.openings.map((opening, index) => ({
    kind: opening.kind,
    wall: opening.wall.trim() === '' ? null : opening.wall.trim().slice(0, 64),
    width: read(`openings.${index}.width`, opening.width),
    height: read(`openings.${index}.height`, opening.height),
    sill: read(`openings.${index}.sill`, opening.sill, true),
  }))

  if (invalidFields.length > 0) return { ok: false, invalidFields }
  return {
    ok: true,
    value: {
      units: 'm',
      room,
      openings,
      notes: draft.notes.slice(0, 2000),
      source: 'manual',
    },
  }
}
