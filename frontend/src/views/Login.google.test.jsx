// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* "Entrar com Google" on the sign-in screen (ISO-1595 §1.1/§4, ISO-1597/ISO-1598) — the button
   itself (shown only when `google_login` is configured, hidden on the Capacitor build —
   Login.google.mobile.test.jsx covers that half, since MOBILE is a module-level constant) and
   every result the callback can land back with in the `google` query param, read straight off
   the URL (no popup, no new tab — a full-page redirect, api/server.js's own contract). */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [], params: new URLSearchParams() }
  state.toast = vi.fn()
  state.setUser = vi.fn()
  state.setUserFromMe = vi.fn()
  state.beginGoogleAuth = vi.fn()
  state.registerGoogle = vi.fn()
  state.api = vi.fn(async () => null)
  state.setParams = vi.fn(p => { state.params = new URLSearchParams(p) })
  state.snapshot = () => ({
    config: state.config, S: {},
    setUser: state.setUser, setUserFromMe: state.setUserFromMe, adoptProfile: vi.fn(async () => ({})), setGuest: vi.fn(), loadConfig: vi.fn(async () => state.config),
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
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), BIO: 'your fingerprint', bio: () => 'your fingerprint',
  api: (...a) => mocks.api(...a), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
  beginGoogleAuth: (...a) => mocks.beginGoogleAuth(...a), registerGoogle: (...a) => mocks.registerGoogle(...a),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false }))
vi.mock('react-router-dom', () => ({ useSearchParams: () => [mocks.params, mocks.setParams] }))

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const buttons = host => [...host.querySelectorAll('button')].map(b => b.textContent)
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const byPlaceholder = (host, p) => host.querySelector(`input[placeholder="${p}"]`)
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
function type(el, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  mocks.webauthn = true; mocks.config = { password_login: true, google_login: true }; mocks.sheets.length = 0; mocks.params = new URLSearchParams()
  mocks.toast.mockClear(); mocks.setUser.mockClear(); mocks.setUserFromMe.mockClear(); mocks.beginGoogleAuth.mockClear()
  mocks.registerGoogle.mockReset(); mocks.api.mockReset().mockResolvedValue(null); mocks.setParams.mockClear()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login: the Google button', () => {
  it('appears below "Sign in with passkey" only when the instance configured it', () => {
    const page = mount(<Login />)
    expect(buttons(page)).toContain('Sign in with Google')
    act(() => button(page, 'Sign in with Google').click())
    expect(mocks.beginGoogleAuth).toHaveBeenCalledWith('login')
  })

  it('absent entirely without google_login', () => {
    mocks.config = { password_login: true }
    const page = mount(<Login />)
    expect(buttons(page)).not.toContain('Sign in with Google')
  })

  it('offered next to the passkey flow too, when password_login is off', () => {
    mocks.config = { google_login: true }
    const page = mount(<Login />)
    expect(buttons(page)).toContain('Sign in with Google')
    expect(buttons(page)).toContain('Sign in with passkey')
  })
})

describe('Login: the Google callback (api/server.js\'s own `#/entrar?google=<code>`)', () => {
  it('ok: merges /api/me and signs in like any other path, with the usual welcome toast', async () => {
    mocks.params = new URLSearchParams({ google: 'ok' })
    mocks.api.mockResolvedValue({ user: { id: 'u1', name: 'Ada' } })
    mount(<Login />)
    await settle()
    expect(mocks.setUserFromMe).toHaveBeenCalledWith({ user: { id: 'u1', name: 'Ada' } }, { id: 'u1', name: 'Ada' }, { adopt: true })
    expect(mocks.toast).toHaveBeenCalledWith('Welcome back, Ada')
    expect(mocks.setParams).toHaveBeenCalledWith({}, { replace: true })
  })

  it('linked: the vinculo toast, not the welcome-back one (never both at once)', async () => {
    mocks.params = new URLSearchParams({ google: 'linked' })
    mocks.api.mockResolvedValue({ user: { id: 'u1', name: 'Ada' } })
    mount(<Login />)
    await settle()
    expect(mocks.toast).toHaveBeenCalledWith('Signed in — your profile is now linked with Google.')
    expect(mocks.toast).not.toHaveBeenCalledWith('Welcome back, Ada')
  })

  it('signup: "Completar cadastro", name pre-filled and editable, e-mail fixed', async () => {
    mocks.params = new URLSearchParams({ google: 'signup', name: 'Ada Lovelace', email: 'ada@gmail.com' })
    const page = mount(<Login />)
    expect(page.querySelector('h3').textContent).toBe('Almost there')
    expect(byPlaceholder(page, 'Your name').value).toBe('Ada Lovelace')
    // Fixed text, not an editable field — just the e-mail Google already confirmed.
    expect(page.textContent).toContain('ada@gmail.com')
    expect(page.querySelector('input[name="username"]')).not.toBeNull()
  })

  it('signup: birth date is required, and under 18 blocks it exactly like the other sign-ups', async () => {
    mocks.params = new URLSearchParams({ google: 'signup', name: 'Ada', email: 'ada@gmail.com' })
    const page = mount(<Login />)
    type(page.querySelector('input[type="date"]'), '2015-06-01')
    expect(page.textContent).toContain('Brilhart Fitness is for people 18 and older.')
    expect(button(page, 'Finish creating your profile').disabled).toBe(true)
  })

  it('signup: finishing calls registerGoogle and signs in', async () => {
    mocks.params = new URLSearchParams({ google: 'signup', name: 'Ada', email: 'ada@gmail.com' })
    mocks.registerGoogle.mockResolvedValue({ id: 'u9', name: 'Ada' })
    const page = mount(<Login />)
    type(page.querySelector('input[type="date"]'), '1990-01-01')
    act(() => page.querySelector('input[name="terms"]').click())
    await act(async () => { button(page, 'Finish creating your profile').click(); await Promise.resolve(); await Promise.resolve() })
    expect(mocks.registerGoogle).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ada', birthDate: '1990-01-01' }))
    expect(mocks.setUser).toHaveBeenCalled()
  })

  it('email-unverified: a blocking screen, never a toast, that routes back to plain sign-in', async () => {
    mocks.params = new URLSearchParams({ google: 'email-unverified' })
    const page = mount(<Login />)
    expect(page.textContent).toContain('Confirm your e-mail first')
    expect(mocks.toast).not.toHaveBeenCalled()
    act(() => button(page, 'Go to sign-in').click())
    expect(mocks.setParams).toHaveBeenCalledWith({}, { replace: true })
  })

  it('disabled: the same persistent alert text as a disabled password/passkey account', async () => {
    mocks.params = new URLSearchParams({ google: 'disabled' })
    const page = mount(<Login />)
    await settle()
    expect(page.querySelector('[role="alert"]').textContent).toBe('This account has been disabled.')
  })

  it('cancelled: no error anywhere, the screen is just the normal one', async () => {
    mocks.params = new URLSearchParams({ google: 'cancelled' })
    const page = mount(<Login />)
    await settle()
    expect(page.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.setParams).toHaveBeenCalledWith({}, { replace: true })
  })

  it('an unmapped/error code: the generic message, worded for whether this instance has passwords', async () => {
    mocks.params = new URLSearchParams({ google: 'error' })
    const page = mount(<Login />)
    await settle()
    expect(page.querySelector('[role="alert"]').textContent).toBe("We couldn't complete sign-in with Google. Try again, or use your e-mail and password.")
    mocks.config = { google_login: true }   // password_login off
    mocks.params = new URLSearchParams({ google: 'error' })
    const page2 = mount(<Login />)
    await settle()
    expect(page2.querySelector('[role="alert"]').textContent).toBe("We couldn't complete sign-in with Google. Try again, or use a passkey.")
  })
})
