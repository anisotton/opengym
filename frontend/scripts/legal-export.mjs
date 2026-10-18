#!/usr/bin/env node
// Renders the two legal texts (src/legal/*.js, the source of truth) to Markdown under
// docs/legal/, so the legal reviewer can read and diff them without Node. The generated
// files are committed on purpose; a test fails if they drift from the modules.
//
//   node scripts/legal-export.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import termos from '../src/legal/termos-de-uso.js'
import privacidade from '../src/legal/politica-de-privacidade.js'

const here = fileURLToPath(import.meta.url)

export const OUT_DIR = join(dirname(here), '..', '..', 'docs', 'legal')

export const TARGETS = [
  [termos, 'termos-de-uso.md'],
  [privacidade, 'politica-de-privacidade.md'],
]

const HEADER = '<!-- Gerado por frontend/scripts/legal-export.mjs a partir de frontend/src/legal/*.js — edite o módulo JS e rode o script; não edite este arquivo. -->'

// A string is a paragraph; { list } is a bullet list. Blocks are separated by a blank line.
export function renderMarkdown(doc) {
  const out = [HEADER, '', `# ${doc.title}`, '', `Versão: ${doc.version}`, '']
  for (const section of doc.sections) {
    out.push(`## ${section.heading}`, '')
    for (const p of section.paragraphs) {
      if (typeof p === 'string') out.push(p, '')
      else out.push(...p.list.map(item => `- ${item}`), '')
    }
  }
  return out.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const [doc, file] of TARGETS) {
    writeFileSync(join(OUT_DIR, file), renderMarkdown(doc))
    console.log(`wrote docs/legal/${file}`)
  }
}
