// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* "Esqueci minha senha" / "Perdi meu acesso" (ISO-1595 §3.1): the same sheet, reusing the one
   neutral body (it already fits both outcomes — a passkey or a new password), but a title that
   matches what the person who tapped the link actually has on screen: a password field (so
   "forgot it" is the question) or only a passkey (so "lost the device" is). */
const mocks = vi.hoisted(() => ({ config: { password_login: true }, request: vi.fn() }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ config: mocks.config })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ recoverRequest: (...a) => mocks.request(...a), accountEmailResend: vi.fn(), accountEmailSet: vi.fn() }))

import { openRecoverRequest } from './AccountEmail.jsx'

let host, root
beforeEach(() => {
  mocks.config = { password_login: true }
  mocks.sheets = []
  mocks.request.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const byPlaceholder = p => host.querySelector(`input[placeholder="${p}"]`)
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const settle = () => act(async () => { await Promise.resolve() })
function type(el, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function open() {
  openRecoverRequest()
  act(() => root.render(mocks.sheets.at(-1)(() => {})))
}

describe('RecoverRequestSheet ("Esqueci minha senha" / "Perdi meu acesso")', () => {
  it('password_login on: "Forgot your password?"', () => {
    mocks.config = { password_login: true }
    open()
    expect(host.querySelector('h3').textContent).toBe('Forgot your password?')
  })

  it('password_login off: the original passkey-recovery title', () => {
    mocks.config = { password_login: false }
    open()
    expect(host.querySelector('h3').textContent).toBe('Lost access to your device?')
  })

  it('the body fits either outcome and the response is neutral either way', async () => {
    mocks.request.mockResolvedValue({ ok: true })
    open()
    expect(host.textContent).toContain('we send a link to continue on this device')
    type(byPlaceholder('E-mail address'), 'ana@example.com')
    act(() => button('Send link').click())
    await settle()
    expect(mocks.request).toHaveBeenCalledWith('ana@example.com')
    expect(host.textContent).toContain('If ana@example.com has an account here, we sent a link to continue on this device.')
  })
})
