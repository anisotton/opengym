import { describe, expect, it } from 'vitest'
import {
  canWriteFromBilling, fmtCentsBRL, parseCentsBRL, monthlyEquivalentCents, savingsPercentVsMonthly
} from './billing.js'

describe('canWriteFromBilling', () => {
  it('writes when billing was never fetched (offline-first default, server 402 is the real gate)', () => {
    expect(canWriteFromBilling(null)).toBe(true)
    expect(canWriteFromBilling(undefined)).toBe(true)
  })

  it('writes when the instance has no billing configured', () => {
    expect(canWriteFromBilling({ enabled: false })).toBe(true)
  })

  it('writes on an active subscription, first period or not', () => {
    expect(canWriteFromBilling({ enabled: true, status: 'active', firstPeriod: true })).toBe(true)
    expect(canWriteFromBilling({ enabled: true, status: 'active', firstPeriod: false })).toBe(true)
  })

  it('writes while Stripe is still retrying a failed charge (past_due)', () => {
    expect(canWriteFromBilling({ enabled: true, status: 'past_due' })).toBe(true)
  })

  it('is read-only with no subscription at all', () => {
    expect(canWriteFromBilling({ enabled: true, status: 'none' })).toBe(false)
  })

  it('is read-only once canceled or unpaid', () => {
    expect(canWriteFromBilling({ enabled: true, status: 'canceled' })).toBe(false)
    expect(canWriteFromBilling({ enabled: true, status: 'unpaid' })).toBe(false)
  })
})

describe('fmtCentsBRL', () => {
  it('formats the three plan prices', () => {
    expect(fmtCentsBRL(8900)).toBe('R$ 89,00')
    expect(fmtCentsBRL(23700)).toBe('R$ 237,00')
    expect(fmtCentsBRL(76800)).toBe('R$ 768,00')
  })
  it('formats the once-per-account intro price', () => {
    expect(fmtCentsBRL(199)).toBe('R$ 1,99')
  })
  it('is null for anything that is not a finite number', () => {
    expect(fmtCentsBRL(null)).toBe(null)
    expect(fmtCentsBRL(undefined)).toBe(null)
    expect(fmtCentsBRL(NaN)).toBe(null)
  })
})

describe('parseCentsBRL', () => {
  it('parses the three plan prices back to cents', () => {
    expect(parseCentsBRL('R$ 89,00')).toBe(8900)
    expect(parseCentsBRL('R$ 237,00')).toBe(23700)
    expect(parseCentsBRL('R$ 768,00')).toBe(76800)
  })
  it('accepts the "." thousands separator', () => {
    expect(parseCentsBRL('R$ 1.234,56')).toBe(123456)
    expect(parseCentsBRL('R$ 10.000,00')).toBe(1000000)
  })
  it('works without the "R$ " prefix', () => {
    expect(parseCentsBRL('89,00')).toBe(8900)
  })
  it('rejects anything below R$1,00 or above R$10.000,00', () => {
    expect(parseCentsBRL('R$ 0,99')).toBe(null)
    expect(parseCentsBRL('R$ 10.000,01')).toBe(null)
  })
  it('accepts the exact boundaries', () => {
    expect(parseCentsBRL('R$ 1,00')).toBe(100)
    expect(parseCentsBRL('R$ 10.000,00')).toBe(1000000)
  })
  it('rejects garbage, empty input and non-strings', () => {
    expect(parseCentsBRL('')).toBe(null)
    expect(parseCentsBRL('not a price')).toBe(null)
    expect(parseCentsBRL('89.00')).toBe(null)
    expect(parseCentsBRL(8900)).toBe(null)
    expect(parseCentsBRL(null)).toBe(null)
  })
})

describe('monthlyEquivalentCents', () => {
  it('matches the three approved plans (R$89/237/768)', () => {
    expect(monthlyEquivalentCents(8900, 'month', 1)).toBe(8900)
    expect(monthlyEquivalentCents(23700, 'month', 3)).toBe(7900)
    expect(monthlyEquivalentCents(76800, 'year', 1)).toBe(6400)
  })
  it('is null without a usable amount or interval', () => {
    expect(monthlyEquivalentCents(null, 'month', 1)).toBe(null)
    expect(monthlyEquivalentCents(8900, 'month', 0)).toBe(null)
  })
})

describe('savingsPercentVsMonthly', () => {
  it('matches the approved badges (11% quarterly, 28% yearly)', () => {
    expect(savingsPercentVsMonthly(7900, 8900)).toBe(11)
    expect(savingsPercentVsMonthly(6400, 8900)).toBe(28)
  })
  it('is 0, not negative, when the plan is not actually cheaper per month', () => {
    expect(savingsPercentVsMonthly(8900, 8900)).toBe(0)
    expect(savingsPercentVsMonthly(9900, 8900)).toBe(0)
  })
  it('is null without a positive monthly baseline to compare against', () => {
    expect(savingsPercentVsMonthly(7900, 0)).toBe(null)
    expect(savingsPercentVsMonthly(7900, null)).toBe(null)
  })
})
