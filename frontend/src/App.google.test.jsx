// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { savePendingReauth } from './lib/google-reauth.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Google's own redirect back, the signed-in half (ISO-1595 §4.5, ISO-1597/ISO-1598): always a
   full-page navigation landing on #/configuracoes?google=<code> (api/billing.js's own fixed
   route for this case too). `reauth-ok` resumes whatever ProveOwner's "Confirm with Google" was
   for (lib/google-reauth.js's sessionStorage descriptor); every other result is already final
   and only needs a word about it, then the person lands on Settings either way. */
const mocks = vi.hoisted(() => {
  const state = { toast: vi.fn(), openSheet: vi.fn(), deleteAccount: vi.fn(async () => {}), resumeGoogleReauth: vi.fn(async () => ({})) }
  state.snapshot = () => ({
    S: {}, config: {}, boot: vi.fn(), linkCode: null, needsMobileOnboarding: false,
    isGuest: () => false, user: { id: 'u1', admin: false }, ready: true, termsChecked: true,
    deleteAccount: (...a) => state.deleteAccount(...a),
  })
  return state
})
vi.mock('./store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => false }
})
vi.mock('./store/useUI.js', () => {
  const snap = () => ({ sheets: [], toast: (...a) => mocks.toast(...a), openSheet: (...a) => mocks.openSheet(...a), closeSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('./lib/api.js', () => ({ resumeGoogleReauth: (...a) => mocks.resumeGoogleReauth(...a) }))
vi.mock('./components/AccountEmail.jsx', () => ({ needsEmailPromptDue: () => false, openNeedsEmailPrompt: vi.fn() }))
vi.mock('./components/Passkeys.jsx', () => ({ openDeviceLinkRedeem: vi.fn(), AddPasskeySheet: () => null }))
vi.mock('./components/TermsSheet.jsx', () => ({ openTermsSheet: vi.fn() }))
vi.mock('./components/ServerSync.jsx', () => ({ useOnline: () => true, isOnline: () => true }))
vi.mock('./lib/push.js', () => ({ syncPushSubscription: vi.fn(async () => {}) }))
vi.mock('./sheets.jsx', () => ({ exitWorkoutEdit: vi.fn(), startFlow: vi.fn() }))

const stubView = label => ({ default: () => <div>{label}</div> })
vi.mock('./views/Login.jsx', () => stubView('Login'))
vi.mock('./views/EmailVerify.jsx', () => stubView('EmailVerify'))
vi.mock('./views/RecoverAccess.jsx', () => stubView('RecoverAccess'))
vi.mock('./views/MobileOnboarding.jsx', () => stubView('MobileOnboarding'))
vi.mock('./views/Home.jsx', () => stubView('Home'))
vi.mock('./views/CheckIn.jsx', () => stubView('CheckIn'))
vi.mock('./views/Plan.jsx', () => stubView('Plan'))
vi.mock('./views/RoutineEdit.jsx', () => stubView('RoutineEdit'))
vi.mock('./views/Workout.jsx', () => stubView('Workout'))
vi.mock('./views/Stats.jsx', () => stubView('Stats'))
vi.mock('./views/History.jsx', () => stubView('History'))
vi.mock('./views/Library.jsx', () => stubView('Library'))
vi.mock('./views/Muscles.jsx', () => stubView('Muscles'))
vi.mock('./views/StructuralBalance.jsx', () => stubView('StructuralBalance'))
vi.mock('./views/Settings.jsx', () => stubView('Settings'))
vi.mock('./views/SettingsPlan.jsx', () => stubView('SettingsPlan'))
vi.mock('./views/Admin.jsx', () => stubView('Admin'))
vi.mock('./views/CoachChat.jsx', () => stubView('CoachChat'))
vi.mock('./views/CoachIntake.jsx', () => stubView('CoachIntake'))
vi.mock('./views/CoachSetup.jsx', () => stubView('CoachSetup'))
vi.mock('./components/TabBar.jsx', () => ({ default: () => null }))
vi.mock('./components/ErrorBoundary.jsx', () => ({ default: ({ children }) => <>{children}</> }))
vi.mock('./components/Modals.jsx', () => ({ default: () => null }))
vi.mock('./components/Toast.jsx', () => ({ default: () => null }))
vi.mock('./components/SyncBanner.jsx', () => ({ default: () => null }))
vi.mock('./components/RestTimer.jsx', () => ({ default: () => null }))
vi.mock('./components/TimerFlash.jsx', () => ({ default: () => null }))

const { default: App } = await import('./App.jsx')

const mounted = []
function mount(hash) {
  window.location.hash = hash
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(<App />))
  return host
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  mocks.toast.mockClear(); mocks.openSheet.mockClear(); mocks.deleteAccount.mockClear()
  mocks.resumeGoogleReauth.mockReset().mockResolvedValue({})
  sessionStorage.clear()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('App: Google callback resume (ISO-1595 §4.5, ISO-1597/ISO-1598)', () => {
  it('linked: a toast, then lands on Settings with the query stripped', async () => {
    const host = mount('#/configuracoes?google=linked')
    await settle()
    expect(mocks.toast).toHaveBeenCalledWith('Google linked.')
    expect(host.textContent).toContain('Settings')
    expect(window.location.hash).toBe('#/settings')
  })

  it('already-linked: a toast naming the conflict, not a page saying "go to sign-in"', async () => {
    mount('#/configuracoes?google=already-linked')
    await settle()
    expect(mocks.toast).toHaveBeenCalledWith('This Google account is already linked to a different profile.')
  })

  it('cancelled: no toast at all', async () => {
    mount('#/configuracoes?google=cancelled')
    await settle()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('reauth-ok with no pending action: a generic fallback, nothing resumed', async () => {
    mount('#/configuracoes?google=reauth-ok&proof=abc')
    await settle()
    expect(mocks.resumeGoogleReauth).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith("We couldn't link your Google account. Try again.")
  })

  it('reauth-ok resumes "remove-password" with the proof, and toasts the usual message', async () => {
    savePendingReauth({ kind: 'remove-password' })
    mount('#/configuracoes?google=reauth-ok&proof=abc123')
    await settle()
    expect(mocks.resumeGoogleReauth).toHaveBeenCalledWith({ kind: 'remove-password' }, 'abc123')
    expect(mocks.toast).toHaveBeenCalledWith('Password removed')
  })

  it('reauth-ok resumes "set-password", carrying the password typed before the redirect', async () => {
    savePendingReauth({ kind: 'set-password', next: 'correct horse battery' })
    mount('#/configuracoes?google=reauth-ok&proof=abc123')
    await settle()
    expect(mocks.resumeGoogleReauth).toHaveBeenCalledWith({ kind: 'set-password', next: 'correct horse battery' }, 'abc123')
    expect(mocks.toast).toHaveBeenCalledWith('Password saved — you are signed out everywhere else.')
  })

  it('reauth-ok "delete-account" calls the store action directly (it also clears local state) and goes home', async () => {
    savePendingReauth({ kind: 'delete-account' })
    mount('#/configuracoes?google=reauth-ok&proof=abc123')
    await settle()
    expect(mocks.deleteAccount).toHaveBeenCalledWith({ googleProof: 'abc123' })
    expect(mocks.resumeGoogleReauth).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('Account deleted')
    expect(window.location.hash).toBe('#/home')
  })

  it('reauth-ok "add-passkey" fetches the creation options and opens the sheet with them, never navigator.credentials on its own', async () => {
    mocks.resumeGoogleReauth.mockResolvedValue({ cid: 'c1', options: { x: 1 } })
    savePendingReauth({ kind: 'add-passkey' })
    mount('#/configuracoes?google=reauth-ok&proof=abc123')
    await settle()
    expect(mocks.resumeGoogleReauth).toHaveBeenCalledWith({ kind: 'add-passkey' }, 'abc123')
    expect(mocks.openSheet).toHaveBeenCalled()
  })

  it('a resume that fails shows the server\'s own message and still lands on Settings', async () => {
    mocks.resumeGoogleReauth.mockRejectedValue(Object.assign(new Error('x'), { status: 409, data: { code: 'last-way-in' } }))
    savePendingReauth({ kind: 'remove-password' })
    mount('#/configuracoes?google=reauth-ok&proof=abc123')
    await settle()
    expect(mocks.toast).toHaveBeenCalledWith('This password is the only way into your profile, so it cannot be removed.')
    expect(window.location.hash).toBe('#/settings')
  })

  it('no google param at all: nothing of this runs', async () => {
    mount('#/home')
    await settle()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.resumeGoogleReauth).not.toHaveBeenCalled()
  })
})
