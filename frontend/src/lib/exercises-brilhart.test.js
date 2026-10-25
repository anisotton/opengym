import { describe, expect, it } from 'vitest'
import { EXBRILHART } from './exercises-brilhart.js'
import { EXDB } from './exercises-data.js'
import { CATALOGUE, EXIDX, imgSrc, gifSrc, registerCustom } from './exercises.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { exerciseHistory } from './exercise-history.js'

describe('the Brilhart exercise ids', () => {
  it('never collide with an EXDB id or a custom exercise id', () => {
    const exdbIds = new Set(EXDB.map(e => e.id))
    for (const ex of EXBRILHART) {
      expect(exdbIds.has(ex.id), ex.id).toBe(false)
      expect(ex.id).toMatch(/^bf\d{2}$/)
      expect(ex.id.startsWith('c')).toBe(false) // registerCustom's own id shape
    }
  })

  it('appear in CATALOGUE and EXIDX alongside the built-in dataset', () => {
    for (const ex of EXBRILHART) {
      expect(CATALOGUE.find(e => e.id === ex.id)).toBe(ex)
      expect(EXIDX[ex.id]).toBe(ex)
    }
  })

  it('a custom exercise never shadows a Brilhart built-in — and restores it on removal', () => {
    const custom = { id: 'bf01', custom: true, n: 'Meu próprio port de bras' }
    registerCustom([custom])
    expect(EXIDX.bf01).toBe(custom) // a user is allowed to override it, same as any built-in id
    registerCustom([]) // removing it restores the real catalogue entry, not a dangling custom row
    expect(EXIDX.bf01).toBe(EXBRILHART.find(e => e.id === 'bf01'))
  })
})

describe('Brilhart exercise media', () => {
  it('resolves through the app bundle (BASE_URL), not the EXDB img/gif base', () => {
    const [ex] = EXBRILHART
    const base = import.meta.env.BASE_URL + 'brilhart/'
    expect(imgSrc(ex)).toBe(base + ex.img)
    expect(gifSrc(ex)).toBe(base + ex.gif)
    expect(imgSrc(ex)).not.toContain('img/')
    expect(gifSrc(ex)).not.toContain('gif/')
  })

  it('carries a front view today, ready for a back view to be appended later', () => {
    for (const ex of EXBRILHART) {
      expect(ex.views.map(v => v.key)).toEqual(['front'])
      expect(ex.views[0].gif).toBe(ex.gif)
      expect(ex.views[0].img).toBe(ex.img)
    }
  })
})

describe('Brilhart exercise content', () => {
  it('is a bodyweight, draft-marked exercise with pt-BR instructions', () => {
    for (const ex of EXBRILHART) {
      expect(ex.eq).toBe('body weight')
      expect(ex.draft).toBe(true)
      expect(ex.st.length).toBeGreaterThanOrEqual(4)
      expect(ex.st.length).toBeLessThanOrEqual(6)
      ex.st.forEach(step => expect(step.trim()).not.toBe(''))
    }
  })
})

describe('training a Brilhart exercise end to end', () => {
  it('finishes a session and shows up in exercise history, like any catalogue exercise', () => {
    const active = {
      id: 'active-bf01', d: '2026-10-25', start: 1000, routineIds: ['routine-1'], name: 'Balé',
      entries: [{ id: 'bf01', sets: [{ done: true, r: 12 }, { done: true, r: 12 }], target: { mode: 'reps', sets: 2, reps: 12 } }],
    }
    const completed = buildCompletedWorkout(active, { end: 2000, prs: [] })
    expect(completed.entries[0].id).toBe('bf01')

    const S = { workouts: [completed] }
    const h = exerciseHistory(S, 'bf01')
    expect(h.total).toBe(1)
    expect(h.sessions[0].sets).toEqual([{ done: true, r: 12 }, { done: true, r: 12 }])
  })
})
