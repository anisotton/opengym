// Renders a legal document module (legal/*.js: { id, title, version, sections }) and opens it in a
// stacked sheet — so the signup form can show the text without leaving the page (ISO-1390).
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { Button } from './ui.jsx'
import termos from '../legal/termos-de-uso.js'
import privacidade from '../legal/politica-de-privacidade.js'

export const LEGAL_DOCS = { termos, privacidade }

const body = { textAlign: 'left', lineHeight: 1.6 }

export function LegalText({ doc }) {
  return <div style={body}>
    {doc.sections.map((s, i) => <section key={i}>
      <h2>{s.heading}</h2>
      {s.paragraphs.map((p, j) => typeof p === 'string'
        ? <p key={j}>{p}</p>
        : <ul key={j}>{p.list.map((li, k) => <li key={k}>{li}</li>)}</ul>)}
    </section>)}
  </div>
}

function LegalSheet({ id, close }) {
  const doc = LEGAL_DOCS[id]
  return <>
    <h3>{doc.title}</h3>
    <div className="dim small">{t('Version {0}', doc.version)}</div>
    <LegalText doc={doc} />
    <Button variant="ghost" onClick={close}>{t('Close')}</Button>
  </>
}

// Stacked (the default) and not locked: opened from inside another sheet, closing it returns there.
export const openLegalSheet = id => useUI.getState().openSheet(close => <LegalSheet id={id} close={close} />)
