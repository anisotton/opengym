// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* A device whose person already has a profile elsewhere (#95) gets a passkey of its own from a
   code on the signed-in device. Brilhart Fitness keeps that to the QR code, which opens the
   redeem sheet by itself (App.jsx, linkCode): the sign-in screen offers only the passkey and a
   new profile, so there is no typed-code button on it. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [] }
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
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))

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

beforeEach(() => { mocks.webauthn = true; mocks.config = null; mocks.sheets.length = 0 })
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login: a code from another device', () => {
  it('is not offered on the sign-in screen, which keeps to the passkey and a new profile', () => {
    mocks.config = { allow_guest: false }
    expect(buttons(mount(<Login />))).toEqual(['Sign in with passkey', 'Create new profile', 'Lost access to your device?'])
  })

  it('is not offered in a browser that cannot make a passkey, with or without passwords', () => {
    mocks.webauthn = false
    expect(buttons(mount(<Login />))).not.toContain('Use a code from your other device')
    mocks.config = { password_login: true }
    expect(buttons(mount(<Login />))).not.toContain('Use a code from your other device')
  })

  it('still redeems a code from the QR link, through the sheet App.jsx opens', async () => {
    const { openDeviceLinkRedeem } = await import('../components/Passkeys.jsx')
    openDeviceLinkRedeem()
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(sheet.querySelector('h3').textContent).toBe('Add this device')
    expect(sheet.querySelector('input[placeholder="Code from your other device"]')).toBeTruthy()
  })
})

describe('Login: brand copy', () => {
  it('shows the Brilhart Fitness line under the logo and the closing line', () => {
    const page = mount(<Login />)
    expect(page.textContent).toContain('Conditioning for ballet.')
    expect(page.textContent).toContain('Today’s strength is tomorrow’s lightness.')
    expect(page.textContent).not.toContain('Passkeys use')
  })
})
