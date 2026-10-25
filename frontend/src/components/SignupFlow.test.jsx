// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignupFlow from './SignupFlow.jsx'
import { LEGAL_VERSION } from '../legal/version.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The passkey sign-up form's terms gate (ISO-1390): Create passkey stays disabled until the box is
   ticked, the box starts unticked, and the app sends its own bundle's LEGAL_VERSION. */
const mocks = vi.hoisted(() => ({
  passkeyRegister: vi.fn(async () => ({ id: 'u1', name: 'A' })),
  openLegalSheet: vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ passkeyRegister: (...a) => mocks.passkeyRegister(...a), bio: () => 'x' }))
vi.mock('./LegalText.jsx', () => ({ openLegalSheet: (...a) => mocks.openLegalSheet(...a) }))
vi.mock('./AccountEmail.jsx', () => ({ ResendEmailButton: () => null }))

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
function type(el, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)

function Harness({ onCreated = async () => {} }) {
  const [name, setName] = React.useState('Ana')
  const [code, setCode] = React.useState('')
  return <SignupFlow name={name} setName={setName} code={code} setCode={setCode} inviteOnly={false} close={() => {}} onCreated={onCreated} />
}
function filled(props) {
  const host = mount(<Harness {...props} />)
  type(host.querySelector('input[type="email"]'), 'ana@example.com')
  type(host.querySelector('input[type="date"]'), '1990-05-05')
  return host
}

beforeEach(() => { mocks.passkeyRegister.mockClear(); mocks.openLegalSheet.mockClear() })
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
})

describe('SignupFlow terms checkbox', () => {
  it('starts unticked, keeps Create passkey disabled, and enables it once ticked', () => {
    const host = filled()
    const box = host.querySelector('input[name="terms"]')
    expect(box.checked).toBe(false)
    expect(button(host, 'Create passkey').disabled).toBe(true)
    act(() => box.click())
    expect(box.checked).toBe(true)
    expect(button(host, 'Create passkey').disabled).toBe(false)
  })

  it('sends the bundle LEGAL_VERSION as the fifth argument, and hands on the acceptance it recorded', async () => {
    const onCreated = vi.fn(async () => {})
    const host = filled({ onCreated })
    act(() => host.querySelector('input[name="terms"]').click())
    act(() => button(host, 'Create passkey').click())
    await settle()
    expect(mocks.passkeyRegister).toHaveBeenCalledWith('Ana', '', 'ana@example.com', '1990-05-05', LEGAL_VERSION)
    // Settings shows the acceptance date straight away, not only after the next /api/me.
    const u = onCreated.mock.calls[0][0]
    expect(u).toMatchObject({ id: 'u1', termsVersion: LEGAL_VERSION, needsTerms: false })
    expect(Number.isNaN(Date.parse(u.termsAcceptedAt))).toBe(false)
  })

  // A server on newer terms than this bundle refuses the signup: the form says to update the app,
  // in the UI language, not the server's raw English.
  it('a stale terms version from the server asks for an app update', async () => {
    mocks.passkeyRegister.mockRejectedValueOnce(Object.assign(new Error('terms version is stale'), { status: 400, data: { code: 'terms-version-stale' } }))
    const host = filled()
    act(() => host.querySelector('input[name="terms"]').click())
    act(() => button(host, 'Create passkey').click())
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Update the app to accept the new terms.')
  })

  it('go() refuses to register when the box is unticked, even if the button is clicked', async () => {
    const host = filled()
    const btn = button(host, 'Create passkey')
    btn.disabled = false   // a programmatic call that bypasses the disabled attribute
    act(() => btn.click())
    await settle()
    expect(mocks.passkeyRegister).not.toHaveBeenCalled()
  })

  it('opens the documents from the links without ticking the box', () => {
    const host = filled()
    act(() => button(host, 'Read the Terms of Use').click())
    expect(mocks.openLegalSheet).toHaveBeenCalledWith('termos')
    act(() => button(host, 'Read the Privacy Policy').click())
    expect(mocks.openLegalSheet).toHaveBeenCalledWith('privacidade')
    expect(host.querySelector('input[name="terms"]').checked).toBe(false)
  })
})

// ISO-1521: a minor's birth date blocks sign-up outright, not just a dismissable notice.
const UNDERAGE = 'Brilhart Fitness is for people 18 and older. We cannot complete your sign-up.'
describe('SignupFlow under-18 block', () => {
  it('a minor birth date disables Create passkey, shows the exact message, and sends nothing', async () => {
    const host = mount(<Harness />)
    type(host.querySelector('input[type="email"]'), 'ana@example.com')
    type(host.querySelector('input[type="date"]'), '2015-06-01')
    act(() => host.querySelector('input[name="terms"]').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(UNDERAGE)
    const btn = button(host, 'Create passkey')
    expect(btn.disabled).toBe(true)
    btn.disabled = false   // a programmatic call that bypasses the disabled attribute
    act(() => btn.click())
    await settle()
    expect(mocks.passkeyRegister).not.toHaveBeenCalled()
  })

  it('an 18-or-older birth date never shows the under-18 message', () => {
    const host = filled()
    act(() => host.querySelector('input[name="terms"]').click())
    expect(host.querySelector('[role="alert"]')).toBe(null)
    expect(button(host, 'Create passkey').disabled).toBe(false)
  })
})
