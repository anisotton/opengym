import { describe, it, expect } from 'vitest'
import {
  normalizeTitle, formatMinutes, canPurge, coverAltError, fieldError, cropRectFor16x9,
  COVER_WIDTH_MIN, COVER_HEIGHT_MIN
} from './programs.js'

describe('normalizeTitle', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeTitle('  Hips   & T-spine ')).toBe('Hips & T-spine')
    expect(normalizeTitle(null)).toBe('')
  })
})

describe('formatMinutes', () => {
  it('formats minutes-only, hours-only and mixed durations', () => {
    expect(formatMinutes(45)).toBe('45 min')
    expect(formatMinutes(60)).toBe('1 h')
    expect(formatMinutes(90)).toBe('1 h 30 min')
    expect(formatMinutes(0)).toBe('–')
    expect(formatMinutes(undefined)).toBe('–')
  })
})

describe('canPurge', () => {
  it('matches only the normalized title, exactly, case included', () => {
    expect(canPurge('  Leg   Day ', 'Leg Day')).toBe(true)
    expect(canPurge('leg day', 'Leg Day')).toBe(false)
    expect(canPurge('', 'Leg Day')).toBe(false)
  })
})

describe('coverAltError', () => {
  it('rejects empty, filename-like and title-echoing alt text', () => {
    expect(coverAltError('', 'My Program')).toBeTruthy()
    expect(coverAltError('img_2034.jpg', 'My Program')).toBeTruthy()
    expect(coverAltError('cover', 'My Program')).toBeTruthy()
    expect(coverAltError('My Program', 'My Program')).toBeTruthy()
  })
  it('accepts a real description', () => {
    expect(coverAltError('Woman doing a goblet squat in a garage gym', 'My Program')).toBeNull()
  })
})

describe('fieldError', () => {
  it('title: 3-120 characters after normalizing', () => {
    expect(fieldError('title', 'ab')).toBeTruthy()
    expect(fieldError('title', 'x'.repeat(121))).toBeTruthy()
    expect(fieldError('title', 'Valid Title')).toBeNull()
  })
  it('sessionMinutes: an integer 1-600', () => {
    expect(fieldError('sessionMinutes', 0)).toBeTruthy()
    expect(fieldError('sessionMinutes', 45.5)).toBeTruthy()
    expect(fieldError('sessionMinutes', 601)).toBeTruthy()
    expect(fieldError('sessionMinutes', 45)).toBeNull()
  })
  it('an unknown field is never blocked here', () => {
    expect(fieldError('category', 'anything')).toBeNull()
  })
})

describe('cropRectFor16x9', () => {
  it('refuses a source smaller than the minimum in either dimension', () => {
    expect(cropRectFor16x9(COVER_WIDTH_MIN - 1, 1000)).toBeNull()
    expect(cropRectFor16x9(1000, COVER_HEIGHT_MIN - 1)).toBeNull()
  })
  it('crops a wide source on its width, a tall source on its height', () => {
    const wide = cropRectFor16x9(3000, 1000)
    expect(wide.sh).toBe(1000)
    expect(Math.round(wide.sw / wide.sh * 100)).toBe(Math.round(16 / 9 * 100))

    const tall = cropRectFor16x9(1000, 3000)
    expect(tall.sw).toBe(1000)
    expect(Math.round(tall.sw / tall.sh * 100)).toBe(Math.round(16 / 9 * 100))
  })
  it('caps the output width at maxW while keeping the 16:9 ratio', () => {
    const r = cropRectFor16x9(4000, 3000, 1600)
    expect(r.outW).toBe(1600)
    expect(r.outH).toBe(900)
  })
  it('centers the crop', () => {
    const r = cropRectFor16x9(2000, 1000)
    expect(r.sx).toBe(Math.round((2000 - r.sw) / 2))
    expect(r.sy).toBe(Math.round((1000 - r.sh) / 2))
  })
})
