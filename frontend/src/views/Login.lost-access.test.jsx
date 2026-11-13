// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* "Lost access?" on the sign-in screen (#584): what to try when no device signs you in, in order,
   and "I have a code", which redeems a recovery code like a device link. The phone app cannot
   make a passkey for the server, so there it says to use a browser and pair again. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [], MOBILE: false, redeem: null }
  state.snapshot = () => ({
    config: state.config, S: {}, user: null, linkCode: null,
    setUser: vi.fn(), adoptProfile: vi.fn(), setGuest: vi.fn(), loadConfig: vi.fn(async () => state.config),
    pushState: vi.fn(), pullState: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), BIO: 'your fingerprint', bio: () => 'your fingerprint',
  api: vi.fn(), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
  createPasskey: vi.fn(),
}))
vi.mock('../lib/mobile.js', () => ({ get MOBILE() { return mocks.MOBILE }, nativePlatform: async () => null, isAndroid: async () => false }))
vi.mock('../components/Passkeys.jsx', () => ({ openDeviceLinkRedeem: vi.fn(() => { mocks.redeem = true }) }))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))

const { default: Login } = await import('./Login.jsx')
const { LostAccessSheet } = await import('../components/LostAccess.jsx')

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)

beforeEach(() => { mocks.webauthn = true; mocks.config = null; mocks.sheets.length = 0; mocks.MOBILE = false; mocks.redeem = null })
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

// Brilhart Fitness: upstream's "Lost access?" (#584) sits beside the fork's own e-mail recovery
// ("Lost access to your device?" / "Forgot your password?"), and there is no "Use a code from your
// other device" button on this screen, so upstream's ordering check becomes "right after the
// e-mail recovery". The fork's Login reads the URL (Google sign-in), hence the router.
const routed = el => <MemoryRouter>{el}</MemoryRouter>
describe('Login: Lost access?', () => {
  it('sits right after the e-mail recovery where passkeys work, and opens the steps', () => {
    const page = mount(routed(<Login />))
    const all = [...page.querySelectorAll('button')].map(b => b.textContent.trim())
    expect(all.indexOf('Lost access?')).toBe(all.indexOf('Lost access to your device?') + 1)
    act(() => button(page, 'Lost access?').click())
    expect(mocks.sheets).toHaveLength(1)
  })
  it('is there on a password-only browser too', () => {
    mocks.webauthn = false
    mocks.config = { password_login: true }
    const page = mount(routed(<Login />))
    expect(button(page, 'Lost access?')).toBeTruthy()
  })
})

describe('LostAccessSheet', () => {
  // Brilhart Fitness: the self-hoster's step (the server command) is not shown; users can't run
  // the server, and the admin's recovery code is the way back in.
  it('lists the ways back in, in order, without the server command, and no em dash', () => {
    const close = vi.fn()
    const host = mount(<LostAccessSheet close={close} />)
    const text = host.textContent
    const order = ['Your passkey may be synced', 'Another device still signed in?', 'Ask your admin'].map(s => text.indexOf(s))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).not.toContain('Running the server yourself?')
    expect(text).not.toContain('docker compose exec api node recover.js')
    expect(text).not.toMatch(/—/)
  })
  it('"I have a code" opens the redemption a device link has', () => {
    const close = vi.fn()
    const host = mount(<LostAccessSheet close={close} />)
    act(() => button(host, 'I have a code').click())
    expect(close).toHaveBeenCalled()
    expect(mocks.redeem).toBe(true)
  })
  it('in the phone app: a browser first, then pair again; no code field here', () => {
    mocks.MOBILE = true
    const host = mount(<LostAccessSheet close={vi.fn()} />)
    expect(host.textContent).toContain('pair the app again')
    expect(button(host, 'I have a code')).toBeUndefined()
  })
})
