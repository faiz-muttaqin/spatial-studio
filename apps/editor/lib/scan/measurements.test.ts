import { describe, expect, test } from 'bun:test'
import { ManualMeasurementsSchema } from '@pascal-app/core/capture'
import { EMPTY_MEASUREMENTS, emptyOpening, measurementsFromDraft } from './measurements'

describe('measurementsFromDraft', () => {
  test('keeps blanks as unknown and accepts comma decimals', () => {
    const result = measurementsFromDraft({
      ...EMPTY_MEASUREMENTS,
      width: '3,6',
      height: ' 2.7 ',
      openings: [{ ...emptyOpening('door'), wall: ' north ', width: '0.9', height: '2.1' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.room).toEqual({ width: 3.6, length: null, height: 2.7 })
    expect(result.value.openings[0]).toEqual({
      kind: 'door',
      wall: 'north',
      width: 0.9,
      height: 2.1,
      sill: 0,
    })
    expect(ManualMeasurementsSchema.safeParse(result.value).success).toBe(true)
  })

  test('marks invalid fields instead of guessing', () => {
    const result = measurementsFromDraft({
      ...EMPTY_MEASUREMENTS,
      width: '3m',
      length: '0',
      openings: [{ ...emptyOpening('window'), sill: '-1' }],
    })
    expect(result).toEqual({ ok: false, invalidFields: ['width', 'length', 'openings.0.sill'] })
  })

  test('an empty form is valid and entirely unknown', () => {
    const result = measurementsFromDraft(EMPTY_MEASUREMENTS)
    expect(result.ok && result.value.room).toEqual({ width: null, length: null, height: null })
  })
})
