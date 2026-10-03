// @vitest-environment happy-dom
// Settings → "Delete account" (ISO-1449/ISO-1394, spec by Atena in ISO-1448): the export offer,
// the proof (the same ProveOwner RemovePasskeySheet uses), and the final confirmation that spends
// it. PasswordAuth.jsx is the real one — what each step sends, and what it says back in the UI
// language, is the point; the passkey prompt and the store are stand-ins.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteAccountRow } from './DeleteAccount.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { webauthn: true, hasData: false, sheets: [], online: true, navs: [], user: { id: 'u1', name: 'Ana' } }
  state.toast = vi.fn()
  state.closeAll = vi.fn()
  state.deleteAccount = vi.fn(async () => {})
  state.passkeyAssertion = vi.fn(async () => ({ cid: 'login-cid', credential: { id: 'k1' } }))
  state.snapshot = () => ({ user: state.user, deleteAccount: state.deleteAccount })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => mocks.hasData }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: (render, opts) => { mocks.sheets.push({ render, opts }); return {} }, closeAll: () => mocks.closeAll() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async () => ({})),
  webauthnOK: () => mocks.webauthn,
  passkeyAssertion: (...a) => mocks.passkeyAssertion(...a),
  passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
}))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn() }))
vi.mock('../lib/nav.js', () => ({ nav: to => mocks.navs.push(to) }))

const fail = (status, data) => Object.assign(new Error(data?.error || 'HTTP ' + status), { status, data })
const named = (name, e = new Error(name)) => Object.assign(e, { name })

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
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const click = async (host, text) => { act(() => button(host, text).click()); await settle() }
const alertText = host => host.querySelector('[role="alert"]')?.textContent || null
// Whether the device has a network (navigator.onLine), and the event that says it changed —
// mirrors ServerSync.jsx's useOnline, which this component reuses unmocked.
const network = on => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on }); window.dispatchEvent(new Event(on ? 'online' : 'offline')) }
const openedSheet = i => { const close = vi.fn(); return { host: mount(mocks.sheets[i ?? mocks.sheets.length - 1].render(close)), close } }
// Mounts the row and taps it, returning sheet 1 — the common starting point for every flow test.
const openRow = (props = {}) => {
  mount(<DeleteAccountRow doExport={() => {}} doExportZip={() => {}} hasMedia={false} passkeysState={PASSKEYS} {...props} />)
  const host = document.querySelector('.lrow')
  act(() => host.click())
  return openedSheet()
}

const PASSKEYS = { passkeys: [{ id: 'k1' }], password: false, lastWayIn: false }

beforeEach(() => {
  network(true)
  mocks.webauthn = true
  mocks.sheets.length = 0
  mocks.navs.length = 0
  mocks.user = { id: 'u1', name: 'Ana' }
  for (const f of [mocks.toast, mocks.closeAll, mocks.deleteAccount, mocks.passkeyAssertion]) f.mockClear()
  mocks.deleteAccount.mockImplementation(async () => {})
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Settings: the "Delete account" row', () => {
  it('is hidden until the passkey list has loaded', () => {
    const host = mount(<DeleteAccountRow doExport={() => {}} doExportZip={() => {}} hasMedia={false} passkeysState={null} />)
    expect(host.textContent).toBe('')
  })

  it('opens sheet 1 with what goes, and offers export without closing it', async () => {
    const doExport = vi.fn()
    const doExportZip = vi.fn()
    const host = mount(<DeleteAccountRow doExport={doExport} doExportZip={doExportZip} hasMedia={true} passkeysState={PASSKEYS} />)
    expect(host.textContent).toContain('Erases everything')
    act(() => host.querySelector('.lrow').click())
    expect(mocks.sheets.length).toBe(1)
    const sheet = openedSheet()
    expect(sheet.host.textContent).toContain('Delete your account?')
    expect(sheet.host.textContent).toContain('Your plan, workouts and body-weight history')
    expect(sheet.host.textContent).toContain('Your subscription — canceled right now')
    await click(sheet.host, 'Export backup (JSON)')
    expect(doExport).toHaveBeenCalledTimes(1)
    await click(sheet.host, 'Export with photos & videos (.zip)')
    expect(doExportZip).toHaveBeenCalledTimes(1)
    // Neither export call advanced or closed the sheet.
    expect(sheet.close).not.toHaveBeenCalled()
    expect(mocks.sheets.length).toBe(1)
  })

  it('"Continue to delete" is disabled offline, and never calls the server by itself', async () => {
    network(false)
    const sheet = openRow()
    expect(sheet.host.textContent).toMatch(/offline/i)
    expect(button(sheet.host, 'Continue to delete').disabled).toBe(true)
  })

  it('Cancel on sheet 1 closes without opening anything else', async () => {
    const sheet = openRow()
    await click(sheet.host, 'Cancel')
    expect(sheet.close).toHaveBeenCalled()
    expect(mocks.sheets.length).toBe(1)
  })
})

describe('Settings: proving identity (sheet 2) never deletes anything by itself', () => {
  async function openProof() {
    const sheet1 = openRow()
    await click(sheet1.host, 'Continue to delete')
    return { sheet1, sheet2: openedSheet() }
  }

  it('a successful proof opens sheet 3 with it, and calls the server nothing yet', async () => {
    const { sheet2 } = await openProof()
    expect(sheet2.host.textContent).toContain('Confirm it’s you')
    await click(sheet2.host, 'Confirm with a passkey')
    expect(mocks.passkeyAssertion).toHaveBeenCalledTimes(1)
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
    expect(sheet2.close).toHaveBeenCalled()
    const sheet3 = openedSheet()
    expect(sheet3.host.textContent).toContain('Delete for good?')
    expect(sheet3.host.textContent).toContain('Ana')
  })

  it('a dismissed passkey prompt is no error, and Cancel just closes sheet 2', async () => {
    const { sheet2 } = await openProof()
    mocks.passkeyAssertion.mockRejectedValueOnce(named('NotAllowedError'))
    await click(sheet2.host, 'Confirm with a passkey')
    expect(alertText(sheet2.host)).toBeNull()
    expect(mocks.sheets.length).toBe(2)   // no sheet 3 opened
    await click(sheet2.host, 'Cancel')
    expect(sheet2.close).toHaveBeenCalled()
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
  })
})

describe('Settings: the final confirmation (sheet 3) is the only step that calls the server', () => {
  async function openFinal() {
    const sheet1 = openRow()
    await click(sheet1.host, 'Continue to delete')
    await click(openedSheet().host, 'Confirm with a passkey')
    return openedSheet()
  }

  it('success clears this device and goes to the entry screen', async () => {
    const sheet = await openFinal()
    await click(sheet.host, 'Delete my account')
    expect(mocks.deleteAccount).toHaveBeenCalledWith({ cid: 'login-cid', credential: { id: 'k1' } })
    expect(mocks.closeAll).toHaveBeenCalledTimes(1)
    expect(mocks.navs).toEqual(['/home'])
    expect(mocks.toast).toHaveBeenCalledWith('Account deleted')
  })

  it('a network failure leaves the sheet open and clears nothing', async () => {
    const sheet = await openFinal()
    mocks.deleteAccount.mockRejectedValueOnce(Object.assign(new Error('network'), {}))
    await click(sheet.host, 'Delete my account')
    expect(alertText(sheet.host)).toBe('Could not delete — are you online?')
    expect(mocks.closeAll).not.toHaveBeenCalled()
    expect(mocks.navs).toEqual([])
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(button(sheet.host, 'Delete my account').disabled).toBe(false)
  })

  it('the last admin sees the specific refusal, with only Cancel offered', async () => {
    const sheet = await openFinal()
    mocks.deleteAccount.mockRejectedValueOnce(fail(400, { code: 'last-admin' }))
    await click(sheet.host, 'Delete my account')
    expect(sheet.host.textContent).toMatch(/only admin.*promote someone else/)
    expect(button(sheet.host, 'Delete my account')).toBeUndefined()
    expect(button(sheet.host, 'Cancel')).toBeTruthy()
    expect(mocks.closeAll).not.toHaveBeenCalled()
  })

  it('a refused proof (session changed meanwhile) shows the usual wording and stays open', async () => {
    const sheet = await openFinal()
    mocks.deleteAccount.mockRejectedValueOnce(fail(403, { code: 'passkey' }))
    await click(sheet.host, 'Delete my account')
    expect(alertText(sheet.host)).toBe('Your passkey could not be confirmed.')
    expect(mocks.closeAll).not.toHaveBeenCalled()
  })

  it('Cancel closes without calling the server', async () => {
    const sheet = await openFinal()
    await click(sheet.host, 'Cancel')
    expect(sheet.close).toHaveBeenCalled()
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
  })
})
