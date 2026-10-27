// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'
import { passkeyLogin } from '../lib/api.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ISO-1480 (Sentinel/Atena review): Login.jsx's own "Sign in with passkey" button — the one
   Anderson actually tapped — had its own, separate NotAllowedError/AbortError swallow, not the
   one in ServerSync.jsx's passkeySignIn (only reachable after a session ends). Covers both a real
   classification staying on screen (not a toast, which Atena found auto-dismissed a ~230-char
   message after 2.2s with no way to read it in time) and a genuine dismissal staying silent. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [], toast: vi.fn() }
  state.snapshot = () => ({
    config: state.config, S: {},
    setUser: vi.fn(), adoptProfile: vi.fn(async () => {}), setGuest: vi.fn(), loadConfig: vi.fn(async () => state.config),
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
  const snap = () => ({ toast: mocks.toast, openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), BIO: 'your fingerprint', bio: () => 'your fingerprint',
  api: vi.fn(async () => null), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
  reportWebauthnFailure: vi.fn(),
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
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)

beforeEach(() => { mocks.webauthn = true; mocks.config = null; mocks.sheets.length = 0; mocks.toast.mockClear() })
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login\'s own "Sign in with passkey" and a refused, not dismissed, WebAuthn ceremony', () => {
  it('a certificate the device does not trust stays on screen as a persistent, role="alert" line — never a toast', async () => {
    const err = Object.assign(new Error('x'), {
      name: 'NotAllowedError',
      message: 'WebAuthn is not supported on sites with TLS certificate errors.',
      isSecureContext: true, elapsedMs: 6,
    })
    passkeyLogin.mockRejectedValueOnce(err)
    const page = mount(<Login />)
    await act(async () => { button(page, 'Sign in with passkey').click(); await Promise.resolve(); await Promise.resolve() })
    const alert = page.querySelector('[role="alert"]')
    expect(alert).toBeTruthy()
    expect(alert.textContent).toMatch(/does not trust this site.s security certificate/)
    // The whole point of Atena's fix: this is not the 2.2s toast.
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('an instant NotAllowedError with no certificate wording reads as a platform refusal, not a cancel', async () => {
    const err = Object.assign(new Error('x'), { name: 'NotAllowedError', message: '', isSecureContext: true, elapsedMs: 10 })
    passkeyLogin.mockRejectedValueOnce(err)
    const page = mount(<Login />)
    await act(async () => { button(page, 'Sign in with passkey').click(); await Promise.resolve(); await Promise.resolve() })
    expect(page.querySelector('[role="alert"]').textContent).toMatch(/refused to show the passkey prompt/)
  })

  it('a real dismissal — a slow NotAllowedError — stays exactly as silent as before', async () => {
    const err = Object.assign(new Error('x'), { name: 'NotAllowedError', message: '', isSecureContext: true, elapsedMs: 4000 })
    passkeyLogin.mockRejectedValueOnce(err)
    const page = mount(<Login />)
    await act(async () => { button(page, 'Sign in with passkey').click(); await Promise.resolve(); await Promise.resolve() })
    expect(page.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('a genuine server error (not a WebAuthn ceremony rejection) still falls back to a message', async () => {
    const err = Object.assign(new Error('server exploded'), { status: 500 })
    passkeyLogin.mockRejectedValueOnce(err)
    const page = mount(<Login />)
    await act(async () => { button(page, 'Sign in with passkey').click(); await Promise.resolve(); await Promise.resolve() })
    expect(page.querySelector('[role="alert"]').textContent).toBe('server exploded')
  })

  it('a successful sign-in still uses the toast, and clears any earlier error', async () => {
    passkeyLogin.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError', message: '', isSecureContext: true, elapsedMs: 10 }))
    const page = mount(<Login />)
    await act(async () => { button(page, 'Sign in with passkey').click(); await Promise.resolve(); await Promise.resolve() })
    expect(page.querySelector('[role="alert"]')).toBeTruthy()

    passkeyLogin.mockResolvedValueOnce({ id: 'u1', name: 'Ada' })
    await act(async () => { button(page, 'Sign in with passkey').click(); await Promise.resolve(); await Promise.resolve() })
    expect(page.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.toast).toHaveBeenCalledWith('Welcome back, Ada')
  })
})
