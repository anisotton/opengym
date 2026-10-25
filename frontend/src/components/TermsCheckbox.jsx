// The sign-up acceptance box (ISO-1390). Unchecked by default — the parent owns the state and
// starts it at false; acceptance is never pre-ticked or implied. The two links open the documents
// in the legal sheet without touching the box.
import { t } from '../lib/i18n.js'
import { openLegalSheet } from './LegalText.jsx'

export default function TermsCheckbox({ checked, onChange }) {
  return <div style={{ marginTop: 12 }}>
    <label className="small" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <input type="checkbox" name="terms" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{t('I have read and accept the Terms of Use and the Privacy Policy.')}</span>
    </label>
    <div className="small" style={{ marginTop: 6 }}>
      <button type="button" className="linklike" onClick={() => openLegalSheet('termos')}>{t('Read the Terms of Use')}</button>
      {' · '}
      <button type="button" className="linklike" onClick={() => openLegalSheet('privacidade')}>{t('Read the Privacy Policy')}</button>
    </div>
  </div>
}
