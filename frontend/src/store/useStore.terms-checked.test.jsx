// @vitest-environment happy-dom
// ISO-1390: the terms lock (App.jsx) opens only on this visit's own /api/me answer. `termsChecked`
// is what tells that answer apart from the user kept in storage, whose `needsTerms` belongs to an
// earlier visit — so setUserFromMe sets it, a plain setUser (a failed refetch keeping what it had)
// does not, a sign-out clears it, and it is never written anywhere a later boot could read it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(async () => ({})), setRemoteAuth: vi.fn(), fetchBillingStatus: vi.fn() }))

import { useStore } from './useStore.js'

beforeEach(() => {
  useStore.getState().setUser(null)
  localStorage.clear()
})

describe('termsChecked', () => {
  it('starts false, so a stored needsTerms cannot lock the app before /api/me answers', () => {
    expect(useStore.getState().termsChecked).toBe(false)
  })

  it('setUserFromMe maps the answer and sets the flag; setUser(null) clears it', () => {
    useStore.getState().setUserFromMe({ user: { id: 'u1', name: 'Ana' }, needsTerms: true, termsVersion: null, termsAcceptedAt: null })
    const st = useStore.getState()
    expect(st.termsChecked).toBe(true)
    expect(st.user).toEqual({ id: 'u1', name: 'Ana', termsVersion: null, termsAcceptedAt: null, needsTerms: true })
    useStore.getState().setUser(null)
    expect(useStore.getState().termsChecked).toBe(false)
  })

  it('keeps the base the caller holds and passes its options through', () => {
    useStore.getState().setUserFromMe({ user: { id: 'stale' }, needsTerms: false }, { id: 'u1', name: 'Ana', admin: true }, { adopt: true })
    expect(useStore.getState().user).toMatchObject({ id: 'u1', admin: true, needsTerms: false })
    expect(useStore.getState().sync.held).toBe(true)   // { adopt } reached setUser
  })

  it('a plain setUser does not count as a check', () => {
    useStore.getState().setUser({ id: 'u1', name: 'Ana', needsTerms: true })
    expect(useStore.getState().termsChecked).toBe(false)
  })

  it('is never written to storage', () => {
    useStore.getState().setUserFromMe({ user: { id: 'u1' }, needsTerms: true })
    const all = Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)).join('\n')
    expect(all).not.toMatch(/termsChecked/)
  })

  // The terms sheet's Accept refused with a 401 (TermsSheet.jsx): the web's revoked-session path,
  // the same one boot takes — signed out, and the banner says the server refused the session.
  it('sessionRefused signs out the way a refused boot does, and clears the flag', () => {
    useStore.getState().setUserFromMe({ user: { id: 'u1' }, needsTerms: true })
    useStore.getState().sessionRefused(Object.assign(new Error('HTTP 401'), { status: 401 }))
    const st = useStore.getState()
    expect(st.user).toBe(null)
    expect(st.termsChecked).toBe(false)
    expect(st.sync.auth).toBe(true)
    expect(st.sync.lastError).toMatchObject({ status: 401, code: 'auth' })
  })
})
