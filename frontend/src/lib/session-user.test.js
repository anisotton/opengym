import { describe, expect, it } from 'vitest'
import { userFromMe } from './session-user.js'

// GET /api/me → the store's `user` (ISO-1390): one mapping for every sign-in path, so the terms
// fields (and ISO-1397's e-mail ones) can't land on one path and be forgotten on another.
describe('userFromMe', () => {
  it('carries the e-mail and terms fields alongside the user', () => {
    const me = { user: { id: 'u' }, email: 'a@x', emailVerified: true, needsEmail: false, termsVersion: '2026-10-17', termsAcceptedAt: '2026-10-17T00:00:00.000Z', needsTerms: false }
    expect(userFromMe(me)).toEqual({
      id: 'u', email: 'a@x', emailVerified: true, needsEmail: false,
      termsVersion: '2026-10-17', termsAcceptedAt: '2026-10-17T00:00:00.000Z', needsTerms: false,
    })
  })

  it('an older server (no terms or e-mail fields) never asks for terms and adds no e-mail fields', () => {
    const u = userFromMe({ user: { id: 'u' } })
    expect(u).toEqual({ id: 'u', termsVersion: null, termsAcceptedAt: null, needsTerms: false })
    expect('needsEmail' in u).toBe(false)
    expect('email' in u).toBe(false)
  })

  it('a given base replaces me.user', () => {
    const u = userFromMe({ user: { id: 'stale' }, needsTerms: true, termsVersion: null }, { id: 'u1', name: 'Ana' })
    expect(u).toEqual({ id: 'u1', name: 'Ana', termsVersion: null, termsAcceptedAt: null, needsTerms: true })
  })
})
