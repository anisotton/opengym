// #/termos and #/privacidade (ISO-1390): the public legal pages. App.jsx renders this ahead of the
// authed/Login branch, so the text is readable signed in or out (and linkable from the signup form).
import { useNavigate } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import { Button } from '../components/ui.jsx'
import { LegalText, LEGAL_DOCS } from '../components/LegalText.jsx'
import logoColor from '../assets/brand/brilhart-fitness-vertical-cor.svg'
import logoNegative from '../assets/brand/brilhart-fitness-vertical-negativo.svg'

export default function Legal({ id }) {
  const nav = useNavigate()
  const doc = LEGAL_DOCS[id]
  const back = () => { if (window.history.length > 1) nav(-1); else nav('/home') }
  return <div className="narrow" style={{ textAlign: 'left', lineHeight: 1.6 }}>
    <h1 className="brand-logo">
      <img className="on-light" src={logoColor} alt="Brilhart Fitness" />
      <img className="on-dark" src={logoNegative} alt="Brilhart Fitness" />
    </h1>
    <h1>{doc.title}</h1>
    <div className="dim small">{t('Version {0}', doc.version)}</div>
    <LegalText doc={doc} />
    <Button variant="ghost" onClick={back}>{t('Back')}</Button>
  </div>
}
