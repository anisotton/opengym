// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPrograms from './AdminPrograms.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  answers: {}, sheets: [], calls: [], lockCalls: [],
  confirmSheet: Object.assign((opts) => { mocks.confirmSheet.calls.push(opts); return opts.onConfirm && opts.onConfirm() }, { calls: [] })
}))
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
  const snap = () => ({
    toast: () => {},
    openSheet: render => {
      mocks.sheets.push(render)
      const id = mocks.sheets.length - 1
      return { id, close: () => {}, lock: v => mocks.lockCalls.push({ id, v }) }
    }
  })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: (...a) => mocks.confirmSheet(...a) }))

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
  mocks.confirmSheet.calls.length = 0
  mocks.lockCalls.length = 0
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

// Atena's review (ISO-1485): four required fixes — a broken cover falls back visibly instead of
// a blank gap, trashing offers an immediate Undo, Cancel on a dirty form confirms first, and an
// invalid submit is wired for assistive tech and moves focus to the first bad field.
describe('AdminPrograms: cover fallback on a broken file', () => {
  const WITH_COVER = { ...PROGRAM, coverFile: 'abc123.jpg', coverMime: 'image/jpeg', coverAlt: 'a gym floor' }

  it('the list falls back to the category placeholder, badged "Cover missing", not a blank gap', async () => {
    mocks.answers['GET /api/admin/programs'] = { programs: [WITH_COVER], trashCount: 0 }
    const page = render(<AdminPrograms />)
    await settle()
    const img = page.querySelector('img.pg-thumb')
    expect(img).toBeTruthy()
    act(() => img.dispatchEvent(new Event('error')))
    await settle()
    expect(page.querySelector('img.pg-thumb')).toBeNull()
    expect(page.textContent).toContain('Cover missing')
  })

  it('the form shows a plain reupload/remove hint when the preview fails to load', async () => {
    mocks.answers['GET /api/admin/programs'] = { programs: [WITH_COVER], trashCount: 0 }
    mocks.answers['GET /api/admin/program'] = { program: WITH_COVER, history: [] }
    const page = render(<AdminPrograms />)
    await settle()
    act(() => page.querySelector('.item.pg-row').click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    const img = sheet.querySelector('img.pg-thumb')
    act(() => img.dispatchEvent(new Event('error')))
    await settle()
    expect(sheet.textContent).toContain('The cover file could not be loaded — upload it again or remove it.')
  })
})

describe('AdminPrograms: trash gives an immediate Undo', () => {
  it('trashing from the form opens an 8s banner whose Undo restores the program', async () => {
    mocks.answers['POST /api/admin/program/trash'] = { program: { ...PROGRAM, deletedAt: '2026-01-02T00:00:00Z', rev: 2 } }
    mocks.answers['POST /api/admin/program/restore'] = { program: PROGRAM }
    const page = render(<AdminPrograms />)
    await settle()
    act(() => page.querySelector('.item.pg-row').click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    const trashBtn = [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Move to trash')
    act(() => trashBtn.click())
    await settle()
    expect(page.textContent).toContain('Moved "Full Body Starter" to trash.')
    const undoBtn = [...page.querySelectorAll('button')].find(b => b.textContent === 'Undo')
    expect(undoBtn).toBeTruthy()
    act(() => undoBtn.click())
    await settle()
    expect(mocks.calls.some(c => c.path === '/api/admin/program/restore')).toBe(true)
  })
})

describe('AdminPrograms: Cancel asks before discarding unsaved edits', () => {
  it('closes immediately when nothing changed', async () => {
    const page = render(<AdminPrograms />)
    await settle()
    const newBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('New program'))
    act(() => newBtn.click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    const cancelBtn = [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Cancel')
    act(() => cancelBtn.click())
    expect(mocks.confirmSheet.calls.length).toBe(0)
  })

  it('confirms "Discard changes?" once a field was edited', async () => {
    const page = render(<AdminPrograms />)
    await settle()
    const newBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('New program'))
    act(() => newBtn.click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    type(sheet.querySelector('#pg-f-title'), 'Something typed')
    const cancelBtn = [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Cancel')
    act(() => cancelBtn.click())
    expect(mocks.confirmSheet.calls.length).toBe(1)
    expect(mocks.confirmSheet.calls[0].title).toBe('Discard changes?')
  })
})

// Atena's second pass on ISO-1485: Cancel's own confirm only guards that one button — backdrop
// tap, swipe-down, Esc and the Android back button all close a sheet directly through
// components/Modals.jsx without ever calling this form's cancel(). Locking the sheet while dirty
// (the sheet handle's own `lock`, read by every one of those gesture handlers — confirmed by
// reading Modals.jsx: `if (!sheet.locked) close()` guards all four) is what keeps them from
// slipping past the same "Discard changes?" the explicit Cancel asks for; Modals.jsx itself is
// unmodified and already enforces it, so this test is only responsible for proving the sheet
// asks to be locked and unlocked at the right moments.
describe('AdminPrograms: the sheet locks itself while dirty, so ambient close gestures cannot bypass it', () => {
  it('locks once a field is edited and unlocks once the edit is undone', async () => {
    const page = render(<AdminPrograms />)
    await settle()
    const newBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('New program'))
    act(() => newBtn.click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    expect(mocks.lockCalls.some(c => c.v === true)).toBe(false)

    const titleInput = sheet.querySelector('#pg-f-title')
    type(titleInput, 'Something typed')
    expect(mocks.lockCalls.at(-1)).toEqual({ id: 0, v: true })

    type(titleInput, '')   // back to the untouched draft
    expect(mocks.lockCalls.at(-1)).toEqual({ id: 0, v: false })
  })

  it('unlocks again once a dirty edit is saved', async () => {
    mocks.answers['POST /api/admin/programs/new'] = { program: { ...PROGRAM, title: 'Renamed' } }
    const page = render(<AdminPrograms />)
    await settle()
    const newBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('New program'))
    act(() => newBtn.click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    type(sheet.querySelector('#pg-f-title'), 'Renamed')
    expect(mocks.lockCalls.at(-1)).toEqual({ id: 0, v: true })

    const save = [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Save')
    await act(async () => { save.click(); await settle() })
    expect(mocks.lockCalls.at(-1)).toEqual({ id: 0, v: false })
  })
})

describe('AdminPrograms: an invalid submit is accessible', () => {
  it('wires aria-invalid/aria-describedby on the bad field and moves focus to it', async () => {
    const page = render(<AdminPrograms />)
    await settle()
    const newBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('New program'))
    act(() => newBtn.click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    const titleInput = sheet.querySelector('#pg-f-title')   // emptyDraft's title is '' — too short
    const save = [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Save')
    await act(async () => { save.click(); await settle() })
    expect(titleInput.getAttribute('aria-invalid')).toBe('true')
    expect(titleInput.getAttribute('aria-describedby')).toBe('pg-f-title-err')
    expect(sheet.querySelector('#pg-f-title-err')).toBeTruthy()
    expect(document.activeElement).toBe(titleInput)
  })
})
