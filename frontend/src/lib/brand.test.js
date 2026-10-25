/* The fork is Brilhart Fitness. Every string a person can read in the app says so: upstream's
   locale keys and UI copy arrive naming Brilhart Fitness, and ISO-1385's rebrand pass has to be re-run on
   each merge. This pins it, so a merged string that still says Brilhart Fitness fails here instead of
   reaching a screen. Attribution, licences, file-format and cache identifiers and links to the
   upstream project are allowed to keep the name. */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = [
  /github\.com|gitlab\.com|duarte-santos|opengym\.|NOTICE|LICENSE|AGPL|©|Gym visual/i,
  /opengym_plan|opengym-device|opengym-catalogue|opengym_|opengym-/,   // identifiers, never shown
  /^\s*(\/\/|\/?\*)/,                                                  // comments
  /kurktchiev\/openGym|openGymSheet/,                                  // an upstream PR reference, a history-state key
]
const walk = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n)
  if (statSync(p).isDirectory()) return n === 'fonts' || n === 'legal' || n === 'assets' ? [] : walk(p)
  return /\.(js|jsx)$/.test(n) && !/\.test\.jsx?$/.test(n) && !/brand\.test/.test(n) ? [p] : []
})

describe('the product name in the app', () => {
  it('is Brilhart Fitness in every UI string and locale, never Brilhart Fitness', () => {
    const hits = []
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/openGym/.test(line)) return
        if (ALLOWED.some(re => re.test(line))) return
        hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim().slice(0, 100)}`)
      })
    }
    expect(hits, hits.join('\n')).toEqual([])
  })
})
