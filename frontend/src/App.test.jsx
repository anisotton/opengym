// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ISO-1415: a signed-in profile with a pending needsEmail prompt that opens #/recuperar?token=
   (or #/verificar-email) used to see that sheet stack on top of the page — App.jsx's
   needsEmailOffered effect ran independently of the route. Same thing with a pending device-link
   redeem (linkCode): both sheets could pop over each other. The fix holds the e-mail sheet off
   while either guard is live, without spending its once-per-sign-in offer. */
const mocks = vi.hoisted(() => {
  const state = {
    ready: true, linkCode: null, needsEmail: true, promptDue: true,
    config: {}, S: {}, isGuest: false, needsMobileOnboarding: false,
  }
  state.snapshot = () => ({
    S: state.S, config: state.config, boot: vi.fn(), linkCode: state.linkCode,
    needsMobileOnboarding: state.needsMobileOnboarding,
    isGuest: () => state.isGuest,
    user: state.ready ? { id: 'u1', needsEmail: state.needsEmail, admin: false } : null,
    ready: state.ready,
  })
  return state
})
vi.mock('./store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => false }
})
vi.mock('./store/useUI.js', () => {
  const snap = () => ({ sheets: [], toast: vi.fn(), openSheet: vi.fn(), closeSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('./components/AccountEmail.jsx', () => ({
  needsEmailPromptDue: () => mocks.promptDue,
  openNeedsEmailPrompt: vi.fn(),
}))
vi.mock('./components/Passkeys.jsx', () => ({ openDeviceLinkRedeem: vi.fn() }))
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
const { openNeedsEmailPrompt } = await import('./components/AccountEmail.jsx')
const { openDeviceLinkRedeem } = await import('./components/Passkeys.jsx')

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

beforeEach(() => {
  mocks.ready = true
  mocks.linkCode = null
  mocks.needsEmail = true
  mocks.promptDue = true
  openNeedsEmailPrompt.mockClear()
  openDeviceLinkRedeem.mockClear()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('App: stacked sheets (ISO-1415)', () => {
  it('offers the needsEmail sheet on an ordinary route', () => {
    mount('#/home')
    expect(openNeedsEmailPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not offer the needsEmail sheet while the route is /recuperar', () => {
    mount('#/recuperar?token=abc')
    expect(openNeedsEmailPrompt).not.toHaveBeenCalled()
  })

  it('does not offer the needsEmail sheet while the route is /verificar-email', () => {
    mount('#/verificar-email?token=abc')
    expect(openNeedsEmailPrompt).not.toHaveBeenCalled()
  })

  it('does not offer the needsEmail sheet while a device-link code is pending, and offers the device-link sheet instead', () => {
    mocks.linkCode = 'ABC123'
    mount('#/home')
    expect(openDeviceLinkRedeem).toHaveBeenCalledTimes(1)
    expect(openNeedsEmailPrompt).not.toHaveBeenCalled()
  })
})
