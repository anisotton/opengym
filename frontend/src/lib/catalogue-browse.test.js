/* catalogue/browse/ (scripts/catalogue/build.mjs) lists the catalogue for contributors. It used to
   ship any picture: this fork carries none of the dataset's media (ISO-1601). The pages are text. */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIR = fileURLToPath(new URL('../../../catalogue/browse/', import.meta.url))
const pages = readdirSync(DIR).filter(f => f.endsWith('.md'))

describe('catalogue/browse', () => {
  it('shows no picture inline, on any page', () => {
    expect(pages.length).toBeGreaterThan(1)
    for (const f of pages) {
      const md = readFileSync(DIR + f, 'utf8')
      expect(md, f).not.toMatch(/<img\b/i)
      expect(md, f).not.toMatch(/!\[[^\]]*\]\(/)
    }
  })

  it('links each exercise to its JSON, and to no picture', () => {
    const md = readFileSync(DIR + 'back.md', 'utf8')
    const row = md.split('\n').find(l => /^\| \[\d+\]/.test(l))
    const id = /^\| \[(\d+)\]\(\.\.\/exercises\/(\d+)\.json\)/.exec(row)
    expect(id && id[1]).toBe(id && id[2])
    expect(row).not.toContain('../media/')
  })
})
