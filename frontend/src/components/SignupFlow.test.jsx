// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignupFlow from './SignupFlow.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The passkey sign-up form's terms gate (ISO-1390): Create passkey stays disabled until the box is
   ticked, the box starts unticked, and the app sends its own bundle's LEGAL_VERSION. */
const mocks = vi.hoisted(() => ({
  passkeyRegister: vi.fn(async () => ({ id: 'u1', name: 'A' })),
  openLegalSheet: vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ passkeyRegister: (...a) => mocks.passkeyRegister(...a), bio: () => 'x' }))
vi.mock('./LegalText.jsx', () => ({ openLegalSheet: (...a) => mocks.openLegalSheet(...a) }))
vi.mock('./AccountEmail.jsx', () => ({ useMinorNotice: () => {}, ResendEmailButton: () => null }))

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

function Harness() {
  const [name, setName] = React.useState('Ana')
  const [code, setCode] = React.useState('')
  return <SignupFlow name={name} setName={setName} code={code} setCode={setCode} inviteOnly={false} close={() => {}} onCreated={async () => {}} />
}
function filled() {
  const host = mount(<Harness />)
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

  it('sends the bundle LEGAL_VERSION as the fifth argument', async () => {
    const host = filled()
    act(() => host.querySelector('input[name="terms"]').click())
    act(() => button(host, 'Create passkey').click())
    await settle()
    expect(mocks.passkeyRegister).toHaveBeenCalledWith('Ana', '', 'ana@example.com', '1990-05-05', '2026-10-17')
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
