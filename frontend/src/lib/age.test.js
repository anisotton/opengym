import { describe, it, expect } from 'vitest'
import { ageFromBirthDate, isMinor } from './age.js'

const NOW = new Date('2026-06-15T12:00:00Z')

describe('ageFromBirthDate', () => {
  it('counts whole years, birthday already passed this year', () => {
    expect(ageFromBirthDate('2000-01-01', NOW)).toBe(26)
  })
  it('counts whole years, birthday not yet reached this year', () => {
    expect(ageFromBirthDate('2000-12-31', NOW)).toBe(25)
  })
  it('turns a year older exactly on the birthday', () => {
    expect(ageFromBirthDate('2008-06-15', NOW)).toBe(18)
  })
  it('is still the old age the day before the birthday', () => {
    expect(ageFromBirthDate('2008-06-16', NOW)).toBe(17)
  })
  it('handles a leap-day birth date', () => {
    expect(ageFromBirthDate('2012-02-29', NOW)).toBe(14)
  })
  it('rejects an out-of-range day instead of rolling it over', () => {
    expect(ageFromBirthDate('2024-02-30', NOW)).toBe(null)
  })
  it('rejects malformed input', () => {
    expect(ageFromBirthDate('not a date', NOW)).toBe(null)
    expect(ageFromBirthDate('', NOW)).toBe(null)
    expect(ageFromBirthDate(null, NOW)).toBe(null)
    expect(ageFromBirthDate(undefined, NOW)).toBe(null)
  })
  it('does not blow up on a future date', () => {
    expect(ageFromBirthDate('2030-01-01', NOW)).toBeLessThan(0)
  })
})

describe('isMinor', () => {
  it('is true the day before turning 18', () => {
    expect(isMinor('2008-06-16', NOW)).toBe(true)
  })
  it('is false on the 18th birthday itself', () => {
    expect(isMinor('2008-06-15', NOW)).toBe(false)
  })
  it('is false for a clearly adult date', () => {
    expect(isMinor('1990-01-01', NOW)).toBe(false)
  })
  it('is false (never blocks) for input that does not parse', () => {
    expect(isMinor('not a date', NOW)).toBe(false)
    expect(isMinor(null, NOW)).toBe(false)
  })
  it('is false for a future date (never negative-age "minor")', () => {
    expect(isMinor('2030-01-01', NOW)).toBe(false)
  })
})
