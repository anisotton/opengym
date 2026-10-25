// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* #/verificar-email (ISO-1398): the screen the confirmation link lands on. The server only ever
   answers "confirmed" or one generic "no longer valid", so what this screen adds on its own is
   checked here — the mark and title per state, the store patched on success, a fresh link
   offered right there when the signed-in address is still pending, and an old link opened after
   the address was already confirmed shown as done rather than as a failure. */
const mocks = vi.hoisted(() => ({ user: null, token: 'tok', verify: vi.fn(), navs: [], setUser: vi.fn() }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.user, setUser: mocks.setUser })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('react-router-dom', () => ({
  useNavigate: () => to => mocks.navs.push(to),
  useSearchParams: () => [new URLSearchParams(mocks.token ? { token: mocks.token } : {})]
}))
vi.mock('../lib/api.js', () => ({ accountEmailVerify: (...a) => mocks.verify(...a) }))
// Settings' own resend button, with its cooldown, is tested with AccountEmail; here only that it is offered.
vi.mock('../components/AccountEmail.jsx', () => ({ ResendEmailButton: ({ label }) => <button className="resend">{label}</button> }))

import EmailVerify from './EmailVerify.jsx'

let host, root
beforeEach(() => {
  Object.assign(mocks, { user: null, token: 'tok' })
  mocks.navs.length = 0
  mocks.verify.mockReset(); mocks.setUser.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async () => {
  await act(async () => root.render(<EmailVerify />))
  await act(async () => { await Promise.resolve() })   // the verify promise settles
}
const mark = () => host.querySelector('.vfy-mark')?.className || null
const title = () => host.querySelector('.vfy-title')?.textContent || null
const text = () => host.querySelector('.vfy-text')?.textContent || null
const resend = () => host.querySelector('.resend')
const primary = () => host.querySelector('.btn.primary')

describe('EmailVerify', () => {
  it('a valid token: the check lands, the signed-in account is marked confirmed, the button opens the app', async () => {
    mocks.user = { id: 'u1', name: 'Ana', email: 'ana@example.com', emailVerified: false }
    mocks.verify.mockResolvedValue({ ok: true })
    await render()
    expect(mocks.verify).toHaveBeenCalledWith('tok')
    expect(mark()).toContain('ok')
    expect(title()).toBe('E-mail confirmed.')
    expect(text()).toMatch(/how you get back in/)
    expect(mocks.setUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', emailVerified: true }))
    expect(resend()).toBeNull()
    act(() => primary().click())
    expect(mocks.navs).toEqual(['/home'])
  })

  it('signed out, a valid token still confirms — there is just no account here to patch', async () => {
    mocks.verify.mockResolvedValue({ ok: true })
    await render()
    expect(title()).toBe('E-mail confirmed.')
    expect(mocks.setUser).not.toHaveBeenCalled()
  })

  it('a refused token for a signed-in, still-pending address offers a fresh link right here', async () => {
    mocks.user = { id: 'u1', name: 'Ana', email: 'ana@example.com', emailVerified: false }
    mocks.verify.mockRejectedValue(Object.assign(new Error('token-invalid'), { code: 'token-invalid' }))
    await render()
    expect(mark()).toContain('bad')
    expect(title()).toBe('This link no longer works')
    expect(resend()?.textContent).toBe('Send a new link')
    expect(primary()).toBeNull()   // "Open" steps back to plain when the resend is the main action
    expect(host.querySelector('.btn.plain')?.textContent).toBe('Open Brilhart Fitness')
  })

  it('a refused token after the address was already confirmed is shown as done, not as a failure', async () => {
    mocks.user = { id: 'u1', name: 'Ana', email: 'ana@example.com', emailVerified: true }
    mocks.verify.mockRejectedValue(new Error('token-invalid'))
    await render()
    expect(mark()).toContain('ok')
    expect(title()).toBe('E-mail confirmed.')
    expect(text()).toBe('Your e-mail was already confirmed.')
    expect(resend()).toBeNull()
    expect(primary()?.textContent).toBe('Open Brilhart Fitness')
  })

  it('signed out with a refused token: no resend to offer, only the way into the app', async () => {
    mocks.verify.mockRejectedValue(new Error('token-invalid'))
    await render()
    expect(title()).toBe('This link no longer works')
    expect(resend()).toBeNull()
    expect(primary()?.textContent).toBe('Open Brilhart Fitness')
  })

  it('no token in the address at all never calls the server and reads as a dead link', async () => {
    mocks.token = ''
    await render()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(title()).toBe('This link no longer works')
  })
})
