// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The sign-in screen with e-mail + password in front (ISO-1596/ISO-1595 §1), passkey kept as a
   secondary option. Only an instance that advertises `password_login` shows any of it — there, a
   browser without passkey support finally has a way in instead of being told to stay local, and
   creating a profile can use a password. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [] }
  state.toast = vi.fn()
  state.setUser = vi.fn()
  state.setUserFromMe = vi.fn()
  state.passwordLogin = vi.fn()
  state.api = vi.fn(async () => null)
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
  api: (...a) => mocks.api(...a), passkeyAssertion: vi.fn(), passwordLogin: (...a) => mocks.passwordLogin(...a),
  passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(), beginGoogleAuth: vi.fn(),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }))

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
const alertText = host => host.querySelector('[role="alert"]')?.textContent || null
const settle = () => act(async () => { await Promise.resolve() })
function type(el, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = async host => { act(() => { host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle() }

beforeEach(() => {
  mocks.webauthn = true; mocks.config = null; mocks.sheets.length = 0
  mocks.toast.mockClear(); mocks.setUser.mockClear(); mocks.setUserFromMe.mockClear(); mocks.passwordLogin.mockReset(); mocks.api.mockReset().mockResolvedValue(null)
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login with password sign-in', () => {
  it('an instance without it looks exactly as before', () => {
    const page = mount(<Login />)
    expect(buttons(page)).not.toContain('Sign in')
    expect(byPlaceholder(page, 'E-mail')).toBeNull()
    // Brilhart Fitness: the footer is a brand line, not the passkey explanation.
    expect(page.textContent).toContain('Today’s strength is tomorrow’s lightness.')
    mocks.webauthn = false
    const noPasskeys = mount(<Login />)
    expect(noPasskeys.textContent).toContain("This browser doesn't support passkeys — you can still use Brilhart Fitness locally on this device.")
  })

  it('e-mail and password sit right on the screen, not behind a second button', async () => {
    mocks.config = { password_login: true, allow_guest: true }
    mocks.passwordLogin.mockResolvedValue({ id: 'u1', name: 'Ana' })
    const page = mount(<Login />)
    const email = byPlaceholder(page, 'E-mail')
    const pw = byPlaceholder(page, 'Password')
    expect(email).toBeTruthy()
    expect(email.getAttribute('autocomplete')).toBe('username')
    expect(pw.type).toBe('password')
    expect(pw.getAttribute('autocomplete')).toBe('current-password')
    expect(button(page, 'Forgot your password?')).toBeTruthy()
    expect(buttons(page)).toContain('Sign in with passkey')   // still offered, secondary
    type(email, ' ana@example.com '); type(pw, 'correct horse battery')
    await submit(page)
    expect(mocks.passwordLogin).toHaveBeenCalledWith('ana@example.com', 'correct horse battery')
    expect(mocks.setUser).toHaveBeenCalledWith({ id: 'u1', name: 'Ana' }, { adopt: true })
    expect(mocks.toast).toHaveBeenCalledWith('Welcome back, Ana')
  })

  it('a wrong e-mail or password stays on the screen and says so', async () => {
    mocks.config = { password_login: true }
    mocks.passwordLogin.mockRejectedValue(Object.assign(new Error('x'), { status: 401, data: { code: 'bad-credentials' } }))
    const page = mount(<Login />)
    type(byPlaceholder(page, 'E-mail'), 'ana@example.com'); type(byPlaceholder(page, 'Password'), 'nope')
    await submit(page)
    expect(alertText(page)).toBe('Wrong e-mail or password.')
    expect(mocks.setUser).not.toHaveBeenCalled()
  })

  it('an empty field is caught here, before any request', async () => {
    mocks.config = { password_login: true }
    const page = mount(<Login />)
    await submit(page)
    expect(alertText(page)).toBe('Enter your name or e-mail.')
    type(byPlaceholder(page, 'E-mail'), 'ana@example.com')
    await submit(page)
    expect(alertText(page)).toBe('Enter your password.')
    expect(mocks.passwordLogin).not.toHaveBeenCalled()
  })

  it('a browser without passkeys still gets the e-mail/password form, with no passkey button', () => {
    mocks.webauthn = false
    mocks.config = { password_login: true, allow_guest: false }
    const page = mount(<Login />)
    expect(byPlaceholder(page, 'E-mail')).toBeTruthy()
    expect(buttons(page)).not.toContain('Sign in with passkey')
    expect(buttons(page)).toContain('Create new profile')
  })

  it('where both work, creating a profile starts on the passkey and switches to a password', () => {
    mocks.config = { password_login: true, invite_only: true }
    const page = mount(<Login />)
    act(() => button(page, 'Create new profile').click())
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(buttons(sheet)).toContain('Create passkey')
    act(() => button(sheet, 'Password').click())
    expect(buttons(sheet)).toContain('Create profile')
    expect(sheet.querySelector('input[placeholder="Invite code"]')).toBeTruthy()
    expect(sheet.querySelector('input[autocomplete="new-password"]')).toBeTruthy()
  })
})
