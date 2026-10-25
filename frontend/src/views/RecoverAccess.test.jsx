// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* #/recuperar?token= (ISO-1398, redesigned by ISO-1595 §3.2/ISO-1596): with `password_login` on,
   opening the link must never spend the token by itself — only a real choice (submitting a new
   password, or tapping to create a passkey) may call POST /api/recover/redeem. With it off, the
   token is still spent on load, exactly as before ISO-1596. */
const mocks = vi.hoisted(() => ({
  token: 'tok', config: { password_login: true }, webauthn: true,
  redeem: vi.fn(), navs: [], setState: vi.fn(), setUser: vi.fn(), adoptProfile: vi.fn(async () => {}), toast: vi.fn(),
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ config: mocks.config, setUser: mocks.setUser, adoptProfile: mocks.adoptProfile })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  useStore.setState = (...a) => mocks.setState(...a)
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({
  useNavigate: () => to => mocks.navs.push(to),
  useSearchParams: () => [new URLSearchParams(mocks.token ? { token: mocks.token } : {})],
}))
vi.mock('../lib/api.js', () => ({ recoverRedeem: (...a) => mocks.redeem(...a), webauthnOK: () => mocks.webauthn }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn() }))

import RecoverAccess from './RecoverAccess.jsx'

let host, root
beforeEach(() => {
  Object.assign(mocks, { token: 'tok', config: { password_login: true }, webauthn: true })
  mocks.navs.length = 0
  mocks.redeem.mockReset(); mocks.setState.mockClear(); mocks.setUser.mockClear(); mocks.adoptProfile.mockClear(); mocks.toast.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async () => { await act(async () => root.render(<RecoverAccess />)) }
const settle = () => act(async () => { await Promise.resolve() })
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const byPlaceholder = p => host.querySelector(`input[placeholder="${p}"]`)
const alertText = () => host.querySelector('[role="alert"]')?.textContent || null
function type(el, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = async () => { act(() => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle() }

describe('RecoverAccess — no token', () => {
  it('reads as invalid without ever calling the server', async () => {
    mocks.token = ''
    await render()
    expect(mocks.redeem).not.toHaveBeenCalled()
    expect(host.textContent).toContain('That link is invalid or expired.')
  })
})

describe('RecoverAccess — password_login off (unchanged, redeems on load)', () => {
  beforeEach(() => { mocks.config = { password_login: false } })

  it('redeems the token on mount and opens the device-link flow', async () => {
    mocks.redeem.mockResolvedValue({ code: 'K7WQ2MZP', expires: 123 })
    await render()
    await settle()
    expect(mocks.redeem).toHaveBeenCalledWith('tok')
    expect(mocks.setState).toHaveBeenCalledWith({ linkCode: 'K7WQ2MZP' })
    expect(host.textContent).toContain('Create a passkey on this device to finish.')
  })

  it('a refused token shows the generic invalid message', async () => {
    mocks.redeem.mockRejectedValue(Object.assign(new Error('bad'), { status: 400, data: { code: 'token-invalid' } }))
    await render()
    await settle()
    expect(host.textContent).toContain('That link is invalid or expired.')
  })
})

describe('RecoverAccess — password_login on (ISO-1596): nothing is spent until a choice is made', () => {
  it('shows both choices on load without calling the server', async () => {
    await render()
    expect(mocks.redeem).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Choose how you want to get back in.')
    expect(button('Set a new password')).toBeTruthy()
    expect(button('Create a passkey on this device')).toBeTruthy()
  })

  it('no passkey support in this browser: only the password choice is offered', async () => {
    mocks.webauthn = false
    await render()
    expect(button('Create a passkey on this device')).toBeUndefined()
    expect(button('Set a new password')).toBeTruthy()
  })

  it('"Create a passkey on this device" spends the token immediately, same as before', async () => {
    mocks.redeem.mockResolvedValue({ code: 'K7WQ2MZP', expires: 123 })
    await render()
    await act(async () => { button('Create a passkey on this device').click(); await Promise.resolve() })
    expect(mocks.redeem).toHaveBeenCalledWith('tok')
    expect(mocks.setState).toHaveBeenCalledWith({ linkCode: 'K7WQ2MZP' })
    expect(host.textContent).toContain('Create a passkey on this device to finish.')
  })

  it('a refused passkey redeem lands on the invalid state', async () => {
    mocks.redeem.mockRejectedValue(new Error('bad'))
    await render()
    await act(async () => { button('Create a passkey on this device').click(); await Promise.resolve() })
    expect(host.textContent).toContain('That link is invalid or expired.')
  })

  it('"Set a new password" opens the form in place, still without calling the server', async () => {
    await render()
    act(() => button('Set a new password').click())
    expect(mocks.redeem).not.toHaveBeenCalled()
    expect(byPlaceholder('New password')).toBeTruthy()
    expect(button('Create a passkey instead')).toBeTruthy()
  })

  it('a too-short or mismatched password is caught here, before any request', async () => {
    await render()
    act(() => button('Set a new password').click())
    type(byPlaceholder('New password'), 'short')
    type(byPlaceholder('Repeat the password'), 'short')
    await submit()
    expect(alertText()).toBe('Use at least 10 characters.')
    expect(mocks.redeem).not.toHaveBeenCalled()
    type(byPlaceholder('New password'), 'correct horse battery')
    type(byPlaceholder('Repeat the password'), 'correct horse battry')
    await submit()
    expect(alertText()).toBe('The two passwords are not the same.')
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('submitting a valid password spends the token, signs in and goes home', async () => {
    mocks.redeem.mockResolvedValue({ user: { id: 'u1', name: 'Ana' } })
    await render()
    act(() => button('Set a new password').click())
    type(byPlaceholder('New password'), 'correct horse battery')
    type(byPlaceholder('Repeat the password'), 'correct horse battery')
    await submit()
    expect(mocks.redeem).toHaveBeenCalledWith('tok', 'correct horse battery')
    expect(mocks.setUser).toHaveBeenCalledWith({ id: 'u1', name: 'Ana' }, { adopt: true })
    expect(mocks.adoptProfile).toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('Welcome back, Ana')
    expect(mocks.navs).toEqual(['/home'])
  })

  it('a token already spent by a concurrent tab is shown in words, on the same form', async () => {
    // The real server error (api/server.js): { error: 'that link is invalid or expired', code: 'token-invalid' }.
    mocks.redeem.mockRejectedValue(Object.assign(new Error('that link is invalid or expired'), { status: 400, data: { code: 'token-invalid' } }))
    await render()
    act(() => button('Set a new password').click())
    type(byPlaceholder('New password'), 'correct horse battery')
    type(byPlaceholder('Repeat the password'), 'correct horse battery')
    await submit()
    expect(alertText()).toBe('That link is invalid or expired.')   // translated, not the raw English server text
    expect(byPlaceholder('New password')).toBeTruthy()   // still the form, not the generic full-page state
    expect(mocks.setUser).not.toHaveBeenCalled()
  })

  it('"Create a passkey instead" goes back to the choice — only before submitting', async () => {
    await render()
    act(() => button('Set a new password').click())
    act(() => button('Create a passkey instead').click())
    expect(host.textContent).toContain('Choose how you want to get back in.')
    expect(mocks.redeem).not.toHaveBeenCalled()
  })
})
