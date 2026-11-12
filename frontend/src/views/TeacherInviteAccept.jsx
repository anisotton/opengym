import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { scopeItems } from '../lib/teacher.js'
import { Button } from '../components/ui.jsx'
import Login from './Login.jsx'

/* ISO-1594/ISO-1610 — Tela 4: Aceite de convite (`#/professor/convite/:code`). Reachable whether
 * signed in or out (see App.jsx's early-return list): while signed out this renders its own
 * prompt and, on demand, the ordinary Login screen in place — the hash never changes, so once
 * sign-in/sign-up finishes this same component re-renders straight into the preview, with the
 * code still in the URL (useParams), no redirect needed.
 *
 * POST /api/teacher-invite/preview can only ever answer `invite-invalid` (D11: the same message
 * for "does not exist", "already used" and "expired" — peekTeacherInvite's own query already
 * filters out an expired row, so none of the three can be told apart at preview time, by design).
 * The richer codes (`invite-expired`, `self-invite`, `already-has-teacher`, `scope-outdated`) can
 * only come back from the accept call itself, for the same invite having changed between the two
 * requests — rare, but handled with its own message rather than falling through to the generic one.
 */

const ERROR_MESSAGE = {
  'invite-invalid': () => t('This invite does not exist or was already used.'),
  'invite-expired': () => t('This invite has expired. Ask your teacher for a new link.'),
  'self-invite': () => t('This is an invite you created yourself — it is for a student, not for you.'),
  'already-has-teacher': () => t('You already have a teacher linked. Unlink in Settings before accepting a new invite.'),
}

export default function TeacherInviteAccept() {
  const nav = useNavigate()
  // Rendered from App.jsx's early-return list (reachable signed out), outside any <Route>, so
  // there is no match to read a :code param from — the code is the path's own last segment.
  const loc = useLocation()
  const code = decodeURIComponent(loc.pathname.replace(/^\/professor\/convite\//, '').replace(/\/$/, ''))
  const user = useStore(s => s.user)
  const [showLogin, setShowLogin] = useState(false)
  const [preview, setPreview] = useState(null) // { teacher, scopeVersion } once loaded
  const [error, setError] = useState(null)      // a key of ERROR_MESSAGE, or 'other'
  const [share, setShare] = useState(false)
  const [busy, setBusy] = useState(false)

  const loadPreview = () => {
    setError(null)
    setPreview(null)
    api('/api/teacher-invite/preview', { method: 'POST', body: JSON.stringify({ code }) })
      .then(d => setPreview(d))
      .catch(e => setError(e.data?.code || 'other'))
  }
  useEffect(() => { if (user) loadPreview() }, [user, code])

  if (!user) {
    if (showLogin) return <Login />
    return <div className="narrow" style={{ paddingTop: '18vh', textAlign: 'center' }}>
      <p className="muted" style={{ marginBottom: 18 }}>{t('You were invited by a teacher on Brilhart Fitness. Sign in or create your account to continue.')}</p>
      <Button variant="primary" onClick={() => setShowLogin(true)}>{t('Sign in')}</Button>
      <div style={{ height: 10 }} />
      <Button onClick={() => setShowLogin(true)}>{t('Create account')}</Button>
    </div>
  }

  if (error) return <div className="empty">
    <div className="muted small" style={{ marginBottom: 12 }}>{(ERROR_MESSAGE[error] || (() => t('Something went wrong. Try again.')))()}</div>
    <Button variant="primary" onClick={() => nav('/home')}>{t('Go to Home')}</Button>
  </div>

  if (!preview) return <div className="muted small" style={{ padding: 20 }}>…</div>

  const scope = scopeItems(preview.scopeVersion)
  if (!scope) return <div className="empty">
    <div className="muted small" style={{ marginBottom: 12 }}>{t('The list of what your teacher sees has changed. Check it again before accepting.')}</div>
    <Button variant="primary" onClick={loadPreview}>{t('Reload')}</Button>
  </div>

  const accept = async () => {
    setBusy(true)
    try {
      await api('/api/teacher-invite/accept', { method: 'POST', body: JSON.stringify({ code, scopeVersion: preview.scopeVersion, shareBodyWeight: share }) })
      useUI.getState().toast(t('All set! {0} now follows your workouts.', preview.teacher.name))
      nav('/settings')
    } catch (e) {
      setBusy(false)
      if (e.data?.code === 'scope-outdated') { loadPreview(); return }
      if (ERROR_MESSAGE[e.data?.code]) { setError(e.data.code); return }
      useUI.getState().toast(t('Could not accept the invite. Try again.'))
    }
  }

  return <div className="narrow">
    <h1>{t('Invite from {0}', preview.teacher.name)}</h1>
    <h3 className="sec">{t('{0} will be able to see:', preview.teacher.name)}</h3>
    <ul className="scope-list">{scope.sees.map((s, i) => <li key={i}>✓ {s}</li>)}</ul>
    <h3 className="sec">{t('{0} will NOT see:', preview.teacher.name)}</h3>
    <ul className="scope-list">{scope.neverSees.map((s, i) => <li key={i}>✗ {s}</li>)}</ul>
    <div className="card" style={{ padding: 12, margin: '10px 0' }}>
      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={share} onChange={e => setShare(e.target.checked)} style={{ marginTop: 3 }} />
        <span>{t('Also share my body weight')}</span>
      </label>
      <div className="muted small" style={{ marginTop: 4 }}>
        {t('Body weight is health data — off by default. You can turn it on or off anytime in Settings → My teacher.')}
      </div>
    </div>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('You can unlink anytime, in Settings.')}</div>
    <Button variant="primary" disabled={busy} onClick={accept} style={{ marginBottom: 8 }}>{busy ? '…' : t('Accept')}</Button>
    <Button variant="ghost" onClick={() => nav('/home')}>{t('Decline')}</Button>
  </div>
}
