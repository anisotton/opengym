// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ISO-1598 review fix: on the Capacitor build, "Ways to sign in" used to be gated on a single
   `!MOBILE`, so the whole section — including the read-only Google row GoogleAccount.jsx already
   draws for a profile that linked Google from the browser (GoogleRow's own MOBILE branch,
   docs/MOBILE.md) — vanished too. This proves the Settings screen itself, not just the isolated
   GoogleRow component, actually gets there on MOBILE when a link exists, and still shows nothing
   when it does not. A separate file because MOBILE is read once at module load. */
const mocks = vi.hoisted(() => {
  const state = { S: null, user: null, sync: null, config: null, webauthn: true, sheets: [], kept: [] }
  state.api = vi.fn(async () => ({}))
  state.snapshot = () => ({
    S: state.S, user: state.user, sync: state.sync, config: state.config, coachLocal: null,
    update: vi.fn(), replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(), resetDemo: vi.fn(),
    syncNow: vi.fn(), unsyncedChanges: () => ({ owed: false, count: 0 }), keptChanges: async () => state.kept,
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
  const snap = () => ({ toast: vi.fn(), openSheet: (render, opts) => { mocks.sheets.push({ render, opts }); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {}, Link: ({ children }) => <a>{children}</a> }))
vi.mock('../lib/api.js', () => ({
  api: (...a) => mocks.api(...a), webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: true,
  passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(), createPasskey: vi.fn(), googleLinkStart: vi.fn(), unlinkGoogle: vi.fn(),
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn(), syncPushSubscription: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: true, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), shareExportBlob: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(), askAddDeviceData: vi.fn(), plateInventorySheet: vi.fn(),
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
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const section = (page, title) => [...page.querySelectorAll('.sect')].find(s => s.querySelector('.sect-t')?.textContent === title)
const titles = el => [...el.querySelectorAll('.lrow-t')].map(t => t.textContent)

beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none', gifSize: 'full', workouts: [], routines: [], exWeights: {} }
  mocks.user = { id: 'u1', name: 'andi' }
  mocks.sync = { status: 'ok', offline: false, pending: false, auth: false, lastError: null, lastSynced: Date.now(), server: null }
  mocks.config = { password_login: true, google_login: true }
  mocks.webauthn = true
  mocks.sheets.length = 0
  mocks.api.mockClear()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Settings on the Capacitor build (MOBILE): "Ways to sign in" with Google', () => {
  it('a profile that already linked Google from the browser still sees it, read-only', async () => {
    mocks.user = { id: 'u1', name: 'andi', google: { email: 'ana@gmail.com', linkedAt: '2026-10-18T00:00:00.000Z' } }
    const page = mount(<Settings page="account" />)
    await settle()
    const ways = section(page, 'Ways to sign in')
    expect(ways).toBeTruthy()
    expect(titles(ways)).toEqual(['Google'])
    const google = [...ways.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === 'Google')
    expect(google.textContent).toContain('ana@gmail.com')
    expect(google.querySelector('button')).toBeNull()
  })

  it('a profile that never linked Google has nothing to show there, and the section is gone', async () => {
    mocks.user = { id: 'u1', name: 'andi', google: null }
    const page = mount(<Settings page="account" />)
    await settle()
    expect(section(page, 'Ways to sign in')).toBeUndefined()
  })

  it('a link that exists but whose instance turned google_login back off shows nothing either', async () => {
    mocks.user = { id: 'u1', name: 'andi', google: { email: 'ana@gmail.com', linkedAt: '2026-10-18T00:00:00.000Z' } }
    mocks.config = { password_login: true, google_login: false }
    const page = mount(<Settings page="account" />)
    await settle()
    expect(section(page, 'Ways to sign in')).toBeUndefined()
  })
})
