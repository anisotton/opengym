// @vitest-environment happy-dom
// The admin drill-down carries no training data at all any more (ISO-1394 Phase 4, LGPD):
// GET /api/admin/user only ever answers account and subscription fields now.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ answers: {}, sheets: [] }))
vi.mock('../lib/api.js', () => ({
  api: path => {
    const key = path.split('?')[0]
    return key in mocks.answers ? Promise.resolve(mocks.answers[key]) : Promise.reject(new Error('not found'))
  }
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: { id: 'adm', name: 'Admin', admin: true }, S: {} })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: () => {}, openSheet: render => mocks.sheets.push(render) })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))
vi.mock('./AdminCoach.jsx', () => ({ default: () => null }))

const mounted = []
function render(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(el))
  return host
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.sheets.length = 0
  mocks.answers = {
    '/api/admin/users': { users: [{ id: 'u1', name: 'Mallory', lastSync: null, disabled: false, online: false }], invite_only: false },
    '/api/admin/invites': { invites: [] },
    '/api/admin/audit': { rows: [] },
    '/api/admin/user': {
      user: { id: 'u1', name: 'Mallory', created: '2026-09-01T00:00:00Z', disabled: false, admin: false },
      lastSync: null, subscription: null
    }
  }
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

describe('Admin user drill-down', () => {
  it('opens a profile and offers "Disable account", with no workout data anywhere on the sheet', async () => {
    const page = render(<Admin />)
    await settle()
    const row = [...page.querySelectorAll('.item')].find(el => el.textContent.includes('Mallory'))
    expect(row).toBeTruthy()
    act(() => row.click())
    expect(mocks.sheets.length).toBe(1)
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    const buttons = [...sheet.querySelectorAll('button')].map(b => b.textContent)
    expect(buttons).toContain('Disable account')
    expect(buttons).not.toContain('Download their data')
    expect(sheet.textContent).not.toMatch(/Workout|Weigh-in|Routine/)
    // Account + subscription tiles instead, with no subscription configured reading as '—'.
    const tiles = [...sheet.querySelectorAll('.tile')].map(t => t.textContent)
    expect(tiles).toEqual(['Plan—', 'Status—', 'Next charge—', 'Last syncnever'])
  })
})

describe('Admin: no training data anywhere on the page', () => {
  it('the list and "Training now" show only account facts — no workout count, routine or sets', async () => {
    mocks.answers['/api/admin/users'] = {
      users: [
        { id: 'u1', name: 'Mallory', lastSync: Date.now() - 3600000, disabled: false, online: true },
        { id: 'u2', name: 'Bob', lastSync: Date.now() - 86400000, disabled: false, online: false },
      ],
      invite_only: false,
    }
    const page = render(<Admin />)
    await settle()
    expect(page.textContent).toContain('Training now')
    // Mallory is online, so she shows up in both the "Training now" card and the list, with no
    // routine name, exercise index or set count — only ISO-1447's own `online: boolean`.
    const live = [...page.querySelectorAll('.card')].find(c => c.textContent.includes('Training now'))
    expect(live.textContent).not.toMatch(/workout|weigh-in|routine|exercise|set/i)
    expect(live.textContent).toContain('Mallory')
    expect(live.textContent).not.toContain('Bob')
    const rows = [...page.querySelectorAll('.item')]
    expect(rows.map(r => r.textContent).join(' ')).not.toMatch(/workout|weigh-in|routine/i)
    const mallory = rows.find(el => el.textContent.includes('Mallory'))
    const bob = rows.find(el => el.textContent.includes('Bob'))
    expect(mallory.textContent).toContain('online')
    expect(bob.textContent).toMatch(/last sync/)
    expect(bob.textContent).not.toContain('online')
  })
})

// The users call failing, or answering without a list, used to leave "Loading…" up for good —
// what a paired phone that had lost its pairing showed its admin, and all it showed.
describe('Admin when the users cannot be loaded', () => {
  const text = page => page.textContent
  it('an answer without a list is an error, not an endless "Loading…"', async () => {
    mocks.answers['/api/admin/users'] = {}
    const page = render(<Admin />)
    await settle()
    expect(text(page)).not.toContain('Loading…')
    expect(text(page)).toContain('Could not load the users')
    expect(text(page)).toContain('The server answered without a list of users.')
  })

  it('a failed call says why, and "Try again" loads the list once the server answers', async () => {
    delete mocks.answers['/api/admin/users']
    const page = render(<Admin />)
    await settle()
    expect(page.querySelector('[role="alert"]').textContent).toContain('not found')

    mocks.answers['/api/admin/users'] = { users: [{ id: 'u1', name: 'Mallory', lastSync: null, disabled: false, online: false }], invite_only: false }
    const retry = [...page.querySelectorAll('button')].find(b => b.textContent === 'Try again')
    act(() => retry.click())
    await settle()
    expect(page.querySelector('[role="alert"]')).toBeNull()
    expect(text(page)).toContain('1 users')
    expect([...page.querySelectorAll('.item')].some(el => el.textContent.includes('Mallory'))).toBe(true)
  })

  it('a list that loaded stays up when a later update fails, marked as the last one', async () => {
    const page = render(<Admin />)
    await settle()
    delete mocks.answers['/api/admin/users']
    const refresh = page.querySelector('[aria-label="refresh"]')
    act(() => refresh.click())
    await settle()
    expect(text(page)).toContain('The last update failed')
    expect([...page.querySelectorAll('.item')].some(el => el.textContent.includes('Mallory'))).toBe(true)
  })
})
