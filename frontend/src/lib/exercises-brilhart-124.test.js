import { existsSync, statSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRILHART_124 } from './exercises-brilhart-124.js'
import { EXDB } from './exercises-data.js'
import { EXBRILHART } from './exercises-brilhart.js'
import {
  CATALOGUE, EXIDX, LIBRARY_CATALOGUE, LIBRARY_IDS, BODYPARTS, allExercises, exOr,
  imgSrc, gifSrc, registerCustom
} from './exercises.js'
import { withBrilhart124PtBrTitles } from './i18n.js'
import { _setLangState, exerciseNameFor } from './i18n-core.js'
import ptBR from '../exercise-names/pt-BR.js'
import { buildSessionEntries } from './session-start.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { estimate1RM } from './onerm.js'

// ISO-1638: Brilhart's own GIF for 124 existing EXDB exercises, plus hiding the rest of the
// 1,324 from the library (search, filters, muscle explorer, add/replace/swap picker) without
// touching their resolution by id — a routine, workout or history entry that cites a hidden id
// must keep opening exactly as before.
describe('the 124 Brilhart-illustrated exercises', () => {
  it('names exactly 124 distinct, existing EXDB ids, each with its own valid file on disk', () => {
    expect(BRILHART_124).toHaveLength(124)
    const exdbIds = new Set(EXDB.map(e => e.id))
    const seen = new Set()
    for (const { id, img, gif, titulo } of BRILHART_124) {
      expect(seen.has(id), id).toBe(false)
      seen.add(id)
      expect(exdbIds.has(id), id).toBe(true)
      expect(titulo?.trim(), id).toBeTruthy()
      const gifAbs = new URL('../../public/brilhart/' + gif, import.meta.url)
      const imgAbs = new URL('../../public/brilhart/' + img, import.meta.url)
      expect(existsSync(gifAbs), gif).toBe(true)
      expect(existsSync(imgAbs), img).toBe(true)
      // Not just "exists and non-empty": a magic-byte check of all 124, catching a truncated or
      // corrupted transfer that a size check alone would miss (acceptance criterion — checked
      // by script, not by sampling).
      const gifHead = readFileSync(gifAbs).subarray(0, 6).toString('ascii')
      expect(['GIF87a', 'GIF89a'], gif).toContain(gifHead)
      const imgHead = readFileSync(imgAbs).subarray(0, 2)
      expect([...imgHead], img).toEqual([0xff, 0xd8]) // JPEG SOI marker
    }
  })

  it('overlays media onto the matching CATALOGUE/EXIDX entry without changing its EXDB text', () => {
    for (const { id, img, gif } of BRILHART_124) {
      const ex = EXIDX[id]
      const original = EXDB.find(e => e.id === id)
      expect(ex.n).toBe(original.n)
      expect(ex.st).toEqual(original.st)
      expect(ex.src).toBe('brilhart')
      expect(ex.img).toBe(img)
      expect(ex.gif).toBe(gif)
      expect(imgSrc(ex)).toBe(import.meta.env.BASE_URL + 'brilhart/' + img)
      expect(gifSrc(ex)).toBe(import.meta.env.BASE_URL + 'brilhart/' + gif)
    }
  })

  it('shows the manifest pt-BR title in pt-BR, without touching the locked generic pack', () => {
    const [{ id, titulo }] = BRILHART_124
    const merged = withBrilhart124PtBrTitles(ptBR)
    expect(merged).not.toBe(ptBR) // a new object - the imported pt-BR.js module is never mutated
    expect(ptBR[id]).not.toBe(titulo) // the generic pack keeps its own curated translation
    _setLangState('pt-BR', {}, null, merged)
    try {
      expect(exerciseNameFor(EXIDX[id])).toBe(`${titulo} (${EXIDX[id].n})`)
    } finally {
      _setLangState('en', {}, null, null)
    }
  })
})

describe('the library-visible catalogue', () => {
  it('is exactly the 124 Brilhart-illustrated ids plus bf01-04, plus the user\'s own customs', () => {
    expect(LIBRARY_IDS.size).toBe(128)
    expect(LIBRARY_CATALOGUE).toHaveLength(128)
    expect(BODYPARTS.length).toBeGreaterThan(0)
    expect(BODYPARTS.length).toBeLessThan(new Set(EXDB.map(e => e.bp)).size + EXBRILHART.length)

    const custom = { id: 'custom-1', n: 'Meu exercício', custom: true, bp: 'chest', eq: 'none', tg: 'pectorals', sm: [], st: [] }
    registerCustom([custom])
    try {
      const visible = allExercises({ customEx: [custom] })
      expect(visible[0]).toBe(custom)
      expect(visible).toHaveLength(129)
      const visibleIds = new Set(visible.map(e => e.id))
      for (const { id } of BRILHART_124) expect(visibleIds.has(id), id).toBe(true)
      for (const e of EXBRILHART) expect(visibleIds.has(e.id), e.id).toBe(true)
      // A hidden EXDB id (every id outside the 124) never shows up to browse or pick.
      expect(visibleIds.has('0025')).toBe(false)
    } finally {
      registerCustom([])
    }
  })

  it('never includes a hidden EXDB id in CATALOGUE.length-sized full set confusion', () => {
    expect(CATALOGUE.length).toBe(EXDB.length + EXBRILHART.length)
    expect(LIBRARY_CATALOGUE.length).toBeLessThan(CATALOGUE.length)
  })
})

describe('a hidden EXDB exercise (left out of the library, never deleted)', () => {
  const id = '0025' // barbell bench press — not one of the 124, not bf01-04

  it('still resolves its name/attributes through EXIDX/exOr', () => {
    expect(EXIDX[id]?.n).toBe('barbell bench press')
    expect(exOr(id).n).toBe('barbell bench press')
  })

  it('still opens a routine that cites it, same as before this change', () => {
    const st = { unit: 'kg', workouts: [], exWeights: {}, routines: [] }
    const r = { id: 'r', prog: 'off', ex: [{ id, sets: 3, reps: 8, weight: 60 }] }
    const entries = buildSessionEntries(st, r)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe(id)
    expect(exOr(entries[0].id).n).toBe('barbell bench press')
  })

  it('still reads back a completed workout and its 1RM, same as before this change', () => {
    const active = {
      id: 'active-1', d: '2026-10-27', start: 1000, routineIds: ['routine-1'], name: 'Push', bw: 80,
      entries: [{ id, sets: [{ done: true, w: 60, r: 8 }], topW: 60, target: { sets: 1, reps: 8 } }],
    }
    const completed = buildCompletedWorkout(active, { end: 2000, prs: [] })
    const set = completed.entries[0].sets[0]
    expect(estimate1RM(set.w, set.r)).toBeCloseTo(60 * (1 + 8 / 30), 5)
  })
})
