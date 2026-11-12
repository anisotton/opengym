// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ISO-1595 §1.4: Google refuses OAuth inside a WebView (disallowed_useragent), so the Capacitor
   build never shows the button at all — gated on MOBILE (lib/mobile.js), never on whether the API
   says Google is configured, because the API has no way to know what shell it is running in. A
   separate file because MOBILE is read once at module load — nothing here can flip it mid-run. */
const mocks = vi.hoisted(() => ({ config: { password_login: true, google_login: true }, webauthn: true }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ config: mocks.config, S: {}, setUser: vi.fn(), setUserFromMe: vi.fn(), adoptProfile: vi.fn(async () => ({})), setGuest: vi.fn(), loadConfig: vi.fn(async () => mocks.config), pushState: vi.fn(), pullState: vi.fn() })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: () => ({}) })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), BIO: 'x', bio: () => 'x',
  api: vi.fn(async () => null), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(), beginGoogleAuth: vi.fn(),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: true }))
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }))

let host, root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Login on the Capacitor build (MOBILE)', () => {
  it('never shows "Sign in with Google", even though the instance has it configured', () => {
    act(() => root.render(<Login />))
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).not.toContain('Sign in with Google')
  })
})
