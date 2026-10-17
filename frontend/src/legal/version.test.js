import { describe, expect, it } from 'vitest'
import { LEGAL_VERSION } from './version.js'
import { LEGAL_VERSION as API_LEGAL_VERSION } from '../../../api/legal.js'
import termos from './termos-de-uso.js'
import privacidade from './politica-de-privacidade.js'

describe('LEGAL_VERSION', () => {
  it('is an ISO date and the API copy is identical', () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(API_LEGAL_VERSION).toBe(LEGAL_VERSION)
  })
  it('both documents carry it and follow the contract', () => {
    for (const doc of [termos, privacidade]) {
      expect(doc.version).toBe(LEGAL_VERSION)
      expect(['termos', 'privacidade']).toContain(doc.id)
      expect(doc.title.length).toBeGreaterThan(0)
      for (const s of doc.sections) {
        expect(typeof s.heading).toBe('string')
        for (const p of s.paragraphs) expect(typeof p === 'string' || Array.isArray(p.list)).toBe(true)
      }
    }
  })
})
