import { describe, expect, it } from 'vitest'
import { EXDB, EXIDX, exOr, registerCustom } from './exercises.js'
import { buildSessionEntries } from './session-start.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { estimate1RM } from './onerm.js'
import { fatigueOf } from './recovery.js'
import { musclesOf } from './muscles.js'

// ISO-1603: third-party img/gif fields were stripped from the 1,324 built-in exercises
// (frontend/src/lib/exercises-data.js). A routine or workout saved before that change can still
// carry ids like '0001'/'0025' — and, on an even older save, a stray `img`/`gif` string copied
// onto a custom exercise. None of that may stop the exercise from resolving, a routine from
// opening, or 1RM/recovery from reading the session back the way it always did.
describe('legacy saved state after the third-party exercise media removal', () => {
  it('the built-in catalogue no longer carries img/gif, but every id still resolves', () => {
    expect(EXDB.length).toBe(1324)
    for (const ex of EXDB) {
      expect(ex).not.toHaveProperty('img')
      expect(ex).not.toHaveProperty('gif')
    }
    const barbellBenchPress = EXIDX['0025']
    expect(barbellBenchPress?.n).toBe('barbell bench press')
    expect(barbellBenchPress?.st?.length).toBeGreaterThan(0)
  })

  it('opens a routine saved with only a dataset id, same as before media existed', () => {
    const st = { unit: 'kg', workouts: [], exWeights: {}, routines: [] }
    const r = { id: 'r', prog: 'off', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }
    const entries = buildSessionEntries(st, r)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('0025')
    expect(exOr(entries[0].id).n).toBe('barbell bench press')
  })

  it('a custom exercise saved before this migration can still carry stray img/gif strings without breaking resolution', () => {
    const legacyCustom = {
      id: 'custom-legacy-1', n: 'My old custom bench', custom: true,
      bp: 'chest', eq: 'barbell', tg: 'pectorals', sm: [], st: [],
      // Written by a build from before the dataset media was removed.
      img: '0025-old.jpg', gif: '0025-old.gif',
    }
    registerCustom([legacyCustom])
    try {
      expect(EXIDX['custom-legacy-1']).toEqual(legacyCustom)
      expect(exOr('custom-legacy-1').n).toBe('My old custom bench')
    } finally {
      registerCustom([]) // leave EXIDX as every other test in this file expects it
    }
  })

  it('sums 1RM and feeds recovery from a legacy-shaped completed workout exactly as before', () => {
    const id = '0025'
    const active = {
      id: 'active-1', d: '2026-08-08', start: 1000, routineIds: ['routine-1'], name: 'Push', bw: 80,
      entries: [{ id, sets: [{ done: true, w: 60, r: 8 }], topW: 60, target: { sets: 1, reps: 8 } }],
    }
    const completed = buildCompletedWorkout(active, { end: 2000, prs: [] })
    const set = completed.entries[0].sets[0]
    expect(estimate1RM(set.w, set.r)).toBeCloseTo(60 * (1 + 8 / 30), 5)

    const weights = musclesOf(EXIDX[id])
    expect(Object.keys(weights).length).toBeGreaterThan(0)
    const now = Date.UTC(2026, 7, 9, 12)
    const fatigue = fatigueOf([completed], now)
    expect(Number.isFinite(Object.values(fatigue)[0] ?? 0)).toBe(true)
  })
})
