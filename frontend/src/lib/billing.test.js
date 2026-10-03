import { describe, expect, it } from 'vitest'
import { canWriteFromBilling, fmtCentsBRL } from './billing.js'

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
