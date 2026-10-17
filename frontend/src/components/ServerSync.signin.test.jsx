// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A passkey sign-in after a session ended (ISO-1390): the sign-in answer is bare, so the user
// handed to the store is built from GET /api/me — it is the only place `needsTerms` comes from —
// through setUserFromMe, which also marks this visit's terms check (termsChecked); a failed
// refetch keeps the bare answer through plain setUser and marks nothing.
const mocks = vi.hoisted(() => ({ setUser: null, setUserFromMe: null, api: null, passkeyLogin: null }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ setUser: mocks.setUser, setUserFromMe: mocks.setUserFromMe, adoptProfile: vi.fn(async () => ({})) })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/mobile.js', () => ({ MOBILE: false }))
vi.mock('../lib/media-sync.js', () => ({ syncMedia: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  api: (...a) => mocks.api(...a), passkeyLogin: (...a) => mocks.passkeyLogin(...a), webauthnOK: () => true,
}))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn() }))
vi.mock('../views/MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))

const { passkeySignIn } = await import('./ServerSync.jsx')

const u = { id: 'u1', name: 'Ana', admin: false }
beforeEach(() => {
  mocks.setUser = vi.fn()
  mocks.setUserFromMe = vi.fn()
  mocks.passkeyLogin = vi.fn(async () => u)
})

describe('passkeySignIn → /api/me', () => {
  it('hands setUserFromMe the /api/me answer, needsTerms included', async () => {
    const me = { user: u, needsTerms: true, termsVersion: '2026-10-17', termsAcceptedAt: null }
    mocks.api = vi.fn(async () => me)
    await passkeySignIn()
    expect(mocks.api).toHaveBeenCalledWith('/api/me')
    expect(mocks.setUserFromMe).toHaveBeenCalledWith(me, u, { adopt: true })
    expect(mocks.setUser).not.toHaveBeenCalled()
  })

  it('falls back to the bare sign-in answer when /api/me fails', async () => {
    mocks.api = vi.fn(() => Promise.reject(new Error('offline')))
    await passkeySignIn()
    expect(mocks.setUser).toHaveBeenCalledWith(u, { adopt: true })
    expect(mocks.setUserFromMe).not.toHaveBeenCalled()
  })
})
