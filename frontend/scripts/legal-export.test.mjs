// frontend/scripts/legal-export.test.mjs
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderMarkdown, OUT_DIR, TARGETS } from './legal-export.mjs'

describe('legal-export', () => {
  it('renders title, version line, headings, paragraphs and lists', () => {
    const md = renderMarkdown({ id: 'x', title: 'T', version: '2026-10-17',
      sections: [{ heading: 'H', paragraphs: ['p1', { list: ['a', 'b'] }] }] })
    expect(md.split('\n')[0]).toMatch(/^<!-- Gerado por frontend\/scripts\/legal-export\.mjs/)
    expect(md).toContain('\n# T\n')
    expect(md).toContain('Versão: 2026-10-17')
    expect(md).toContain('\n## H\n')
    expect(md).toContain('\np1\n')
    expect(md).toContain('\n- a\n- b\n')
  })
  it('the committed docs/legal/*.md are what the modules render now', () => {
    for (const [doc, file] of TARGETS)
      expect(readFileSync(join(OUT_DIR, file), 'utf8'), file).toBe(renderMarkdown(doc))
  })
})
