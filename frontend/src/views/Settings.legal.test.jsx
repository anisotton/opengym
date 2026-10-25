// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Settings footer (ISO-1390): links to the two legal pages, and the acceptance date when there is one.
const mocks = vi.hoisted(() => {
  const state = { S: null, user: null, MOBILE: false }
  state.toast = vi.fn()
  state.snapshot = () => ({
    S: state.S, user: state.user, coachLocal: null,
    sync: { status: 'ok', offline: false, pending: false, auth: false, lastError: null, lastSynced: Date.now(), server: 'https://gym.example.com' },
    update: vi.fn(), replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(), resetDemo: vi.fn(),
    syncNow: vi.fn(), unsyncedChanges: () => ({ owed: false, count: 0 }), keptChanges: async () => [],
    disconnectServer: vi.fn(), signOut: vi.fn(), signOutAll: vi.fn(), adoptProfile: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {}, Link: ({ to, children }) => <a href={'#' + to}>{children}</a> }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.resolve({})), webauthnOK: () => true, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mocks.MOBILE },
  isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn(),
}))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(), askAddDeviceData: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })
beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none', gifSize: 'full', workouts: [], routines: [], exWeights: {} }
  mocks.MOBILE = false
})

const hrefs = page => [...page.querySelectorAll('a')].map(a => a.getAttribute('href'))

describe('Settings footer → legal', () => {
  it('links to both pages and shows the version and date accepted', () => {
    mocks.user = { id: 'u', name: 'A', termsVersion: '2026-10-17', termsAcceptedAt: '2026-10-17T12:00:00.000Z' }
    const page = mount(<Settings page="about" />)
    expect(hrefs(page).some(h => h.endsWith('#/termos'))).toBe(true)
    expect(hrefs(page).some(h => h.endsWith('#/privacidade'))).toBe(true)
    expect(page.textContent).toContain('You accepted version 2026-10-17')
  })

  it('without an acceptance the links stay and the sentence goes', () => {
    mocks.user = { id: 'u', name: 'A', termsVersion: null, termsAcceptedAt: null }
    const page = mount(<Settings page="about" />)
    expect(hrefs(page).some(h => h.endsWith('#/termos'))).toBe(true)
    expect(hrefs(page).some(h => h.endsWith('#/privacidade'))).toBe(true)
    expect(page.textContent).not.toContain('You accepted version')
  })
})
