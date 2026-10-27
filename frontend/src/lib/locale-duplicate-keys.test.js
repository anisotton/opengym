import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ISO-1604 review: a second 'Back' entry added for the Frente/Costas view switcher silently
// shadowed the pre-existing 'Back' used by the Coach's nav button (each with its own, different
// translation) — JS keeps only the last of two identical object keys, so pt.js's new "Costas"
// lost to the later "Voltar" already in the file. `import()`ing the pack can't catch this: the
// duplicate is already resolved by the time the module is evaluated — only the source text
// still has both. Every pack here is a flat `{ "source string": "translation" }` literal, one
// pair per line (i18n-core.js's own description of the format), so a per-line scan is enough;
// it would need to change if a pack ever nested one.
const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales')
const files = readdirSync(localesDir).filter(f => f.endsWith('.js'))

describe('locale packs have no duplicate source keys', () => {
  it.each(files)('%s', file => {
    const text = readFileSync(join(localesDir, file), 'utf8')
    const seen = new Map()
    for (const match of text.matchAll(/^\s*(['"])((?:[^\\]|\\.)*?)\1\s*:/gm)) {
      const key = match[2]
      seen.set(key, (seen.get(key) || 0) + 1)
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k)
    expect(dupes, `duplicate keys in ${file}`).toEqual([])
  })
})
