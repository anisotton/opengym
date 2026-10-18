// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPrograms from './AdminPrograms.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ answers: {}, sheets: [], calls: [] }))
vi.mock('../lib/api.js', () => ({
  api: (path, opts = {}) => {
    mocks.calls.push({ path, opts })
    const method = (opts.method || 'GET').toUpperCase()
    const key = method + ' ' + path.split('?')[0]
    if (key in mocks.answers) {
      const a = mocks.answers[key]
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
    }
    return Promise.reject(Object.assign(new Error('not found'), { status: 404, data: {} }))
  },
  apiUpload: vi.fn(() => Promise.resolve({ program: {} })),
  appBase: () => 'http://localhost'
}))
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: () => {}, openSheet: render => mocks.sheets.push(render) })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: opts => opts.onConfirm && opts.onConfirm() }))

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
function type(input, value) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  act(() => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

const PROGRAM = {
  id: 'p1', title: 'Full Body Starter', description: '', category: 'general', difficulty: 'beginner',
  sessionMinutes: 45, status: 'draft', rev: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
}

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.sheets.length = 0
  mocks.calls.length = 0
  mocks.answers = {
    'GET /api/admin/programs': { programs: [PROGRAM], trashCount: 0 },
    'GET /api/admin/programs/meta': {
      categories: [{ value: 'general', label: 'General fitness' }],
      difficulties: [{ value: 'beginner', label: 'Beginner' }],
      limits: {}, trashDays: 30, coverMaxMB: 5
    },
    'GET /api/admin/program': { program: PROGRAM, history: [{ id: 1, action: 'create', actorName: 'Adminna', at: '2026-01-01T00:00:00Z' }] }
  }
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

describe('AdminPrograms: list', () => {
  it('loads and shows a program with its category, difficulty and duration', async () => {
    const page = render(<AdminPrograms />)
    await settle()
    expect(page.textContent).toContain('Full Body Starter')
    expect(page.textContent).toContain('General fitness')
    expect(page.textContent).toContain('Beginner')
    expect(page.textContent).toContain('45 min')
  })

  it('an empty catalog says so', async () => {
    mocks.answers['GET /api/admin/programs'] = { programs: [], trashCount: 0 }
    const page = render(<AdminPrograms />)
    await settle()
    expect(page.textContent).toContain('No programs yet.')
  })

  it('a failed load shows the error with a Retry', async () => {
    mocks.answers['GET /api/admin/programs'] = new Error('server error')
    const page = render(<AdminPrograms />)
    await settle()
    expect(page.textContent).toContain('server error')
    const retry = [...page.querySelectorAll('button')].find(b => b.textContent === 'Retry')
    expect(retry).toBeTruthy()
  })

  it('shows the trash count on the Trash tab', async () => {
    mocks.answers['GET /api/admin/programs'] = { programs: [PROGRAM], trashCount: 3 }
    const page = render(<AdminPrograms />)
    await settle()
    const trashTab = [...page.querySelectorAll('.chip')].find(b => b.textContent.startsWith('Trash'))
    expect(trashTab.textContent).toContain('(3)')
  })
})

describe('AdminPrograms: create', () => {
  it('"New program" opens a form sheet', async () => {
    const page = render(<AdminPrograms />)
    await settle()
    const newBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('New program'))
    act(() => newBtn.click())
    expect(mocks.sheets.length).toBe(1)
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    expect(sheet.textContent).toContain('New program')
    expect(sheet.querySelector('input[placeholder], label')).toBeTruthy()
  })

  it('submits the form and reports a validation error on the right field', async () => {
    mocks.answers['POST /api/admin/programs/new'] = Object.assign(new Error('title must be 3-120 characters'), { status: 400, data: { field: 'title', error: 'title must be 3-120 characters' } })
    const page = render(<AdminPrograms />)
    await settle()
    const newBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('New program'))
    act(() => newBtn.click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    const titleInput = sheet.querySelector('.adm-field input')
    type(titleInput, 'Valid title')
    const save = [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Save')
    await act(async () => { save.click(); await settle() })
    expect(sheet.textContent).toContain('title must be 3-120 characters')
  })
})

describe('AdminPrograms: trash row actions', () => {
  it('restore posts to the restore route and reloads', async () => {
    mocks.answers['GET /api/admin/programs'] = { programs: [{ ...PROGRAM, deletedAt: '2026-01-02T00:00:00Z' }], trashCount: 1 }
    mocks.answers['POST /api/admin/program/restore'] = { program: PROGRAM }
    const page = render(<AdminPrograms />)
    await settle()
    const trashTab = [...page.querySelectorAll('.chip')].find(b => b.textContent.startsWith('Trash'))
    act(() => trashTab.click())
    await settle()
    const restoreBtn = [...page.querySelectorAll('button')].find(b => b.textContent === 'Restore')
    expect(restoreBtn).toBeTruthy()
    act(() => restoreBtn.click())
    await settle()
    expect(mocks.calls.some(c => c.path === '/api/admin/program/restore')).toBe(true)
  })
})
