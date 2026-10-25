import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { copyText } from '../lib/clipboard.js'
import { Button, Row, Section, SearchField, TextField } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import QrCanvas from '../components/QrCanvas.jsx'

// ISO-1594/ISO-1610: Tela 1 — Meus alunos. Teacher-only (gated by role in App.jsx); the data
// here (names, summaries) is read straight from GET /api/teacher/students on every visit — never
// stored in S, so it never rides along on this account's own PUT /api/data (D4/D5).

const inviteUrl = code => location.origin + location.pathname + '#/professor/convite/' + encodeURIComponent(code)

function daysAgo(iso) {
  const today = todayISO()
  return Math.round((new Date(today + 'T12:00:00') - new Date(iso + 'T12:00:00')) / 86400000)
}

function lastWorkoutLabel(iso) {
  if (!iso) return null
  const d = daysAgo(iso)
  if (d <= 0) return t('Today')
  if (d === 1) return t('Yesterday')
  return t('{0} days ago', d)
}

function summaryLine(s) {
  if (s.idle) return t('Idle for {0} days', s.idleDays)
  const parts = [lastWorkoutLabel(s.lastWorkoutAt) || t('No workouts yet')]
  parts.push(s.workoutsThisWeek === 1 ? t('1 workout this week') : t('{0} workouts this week', s.workoutsThisWeek))
  if (s.adherence) parts.push(t('{0} of {1} expected workouts (last 28 days)', s.adherence.done, s.adherence.expected))
  return parts.join(' · ')
}

function InviteSheet({ close }) {
  const toast = useUI(s => s.toast)
  const [invites, setInvites] = useState(null)
  const [note, setNote] = useState('')
  const [fresh, setFresh] = useState(null) // { code, expires, note? }
  const [limited, setLimited] = useState(false)
  const load = () => api('/api/teacher/invites').then(d => setInvites(d.invites || [])).catch(() => setInvites([]))
  useEffect(() => { load() }, [])
  const create = async () => {
    setLimited(false)
    try {
      const { invite } = await api('/api/teacher/invites/new', { method: 'POST', body: JSON.stringify({ note }) })
      setFresh(invite)
      setNote('')
      load()
    } catch (e) {
      if (e.data?.code === 'invite-limit') setLimited(true)
      else toast(t('Could not generate the code. Try again.'))
    }
  }
  const revoke = hash => confirmSheet({
    title: t('Revoke invite?'), message: t('Anyone with this link or code loses access to it.'),
    confirmText: t('Revoke'), danger: true,
    onConfirm: () => api('/api/teacher/invites/revoke', { method: 'POST', body: JSON.stringify({ hash }) })
      .then(() => { if (fresh) setFresh(null); load() })
      .catch(() => toast(t('Could not revoke the invite. Try again.')))
  })
  const copy = async () => { if (await copyText(inviteUrl(fresh.code))) toast(t('Copied')) }
  const expired = fresh && fresh.expires <= Date.now()
  return <>
    <h3>{t('Invite a student')}</h3>
    {!fresh ? <>
      <div className="muted small" style={{ marginBottom: 10 }}>
        {t('Generate a code or link. Your student opens the link (or types the code after signing in) and sees exactly what you will see before accepting.')}
      </div>
      <TextField placeholder={t('Label (optional)')} value={note} onChange={e => setNote(e.target.value.slice(0, 60))} style={{ marginBottom: 10 }} />
      <Button variant="primary" icon="plus" onClick={create}>{t('Generate code')}</Button>
      {limited && <div className="muted small" style={{ color: 'var(--red)', marginTop: 8 }}>
        {t('You already have 20 active invites. Revoke one to generate another.')}
      </div>}
    </> : expired ? <>
      <div className="muted small" style={{ marginBottom: 10 }}>{t('This code has expired.')}</div>
      <Button variant="primary" onClick={() => setFresh(null)}>{t('Make a new code')}</Button>
    </> : <>
      <div className="ci-qr-plate" style={{ width: 'fit-content', margin: '0 auto 14px' }}><QrCanvas value={inviteUrl(fresh.code)} size={200} /></div>
      <div className="card" dir="ltr" style={{ textAlign: 'center', fontSize: 24, fontWeight: 700, letterSpacing: '.12em', padding: '14px 0' }}>{fresh.code}</div>
      <div style={{ height: 12 }} />
      <div className="row" style={{ gap: 8 }}>
        <Button icon="link" onClick={copy}>{t('Copy link')}</Button>
        {typeof navigator.share === 'function' && <Button icon="share" onClick={() => navigator.share({ url: inviteUrl(fresh.code) }).catch(() => {})}>{t('Share')}</Button>}
      </div>
      <div className="muted small" style={{ marginTop: 10 }}>{t('Expires in 7 days.')}</div>
    </>}
    {invites?.length > 0 && <>
      <div style={{ height: 16 }} />
      <Section title={t('Pending invites ({0})', invites.length)}>
        {invites.map(inv => <Row key={inv.hash} title={inv.note || t('Unlabeled invite')}
          subtitle={inv.expires <= Date.now() + 86400000 ? t('expires today') : t('expires in {0} days', Math.max(1, Math.round((inv.expires - Date.now()) / 86400000)))}>
          <Button size="sm" variant="ghost" className="dim" onClick={() => revoke(inv.hash)}>{t('Revoke')}</Button>
        </Row>)}
      </Section>
    </>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

export default function Students() {
  const nav = useNavigate()
  const [students, setStudents] = useState(null) // null = loading, [] = loaded empty
  const [error, setError] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [q, setQ] = useState('')

  const load = () => {
    setError(false)
    return Promise.all([
      api('/api/teacher/students').then(d => setStudents(d.students || [])).catch(() => setError(true)),
      api('/api/teacher/invites').then(d => setPendingCount((d.invites || []).length)).catch(() => {})
    ])
  }
  useEffect(() => { load() }, [])

  // The invite sheet refreshes its own list internally (create/revoke); `pendingCount` here
  // catches up on this view's own next load (mount, or the "Try again" / search reload) rather
  // than needing a close callback openSheet does not provide — a swipe-to-dismiss closes through
  // Modals.jsx's own handler, never through the function passed to openSheet.
  const openInvite = () => useUI.getState().openSheet(close => <InviteSheet close={close} />)

  const filtered = (students || []).filter(s => !q.trim() || (s.name || '').toLowerCase().includes(q.trim().toLowerCase()))
  const sorted = [...filtered].sort((a, b) => {
    const ai = a.summary?.idle ? (a.summary.idleDays || 0) : -1
    const bi = b.summary?.idle ? (b.summary.idleDays || 0) : -1
    return bi - ai
  })

  return <>
    <div className="hdr">
      <div><h1>{t('Students')}</h1><div className="sub">{(students?.length ?? 0) === 1 ? t('1 student') : t('{0} students', students?.length ?? 0)}</div></div>
      <Button size="sm" variant="primary" icon="plus" onClick={openInvite}>{t('Invite')}</Button>
    </div>

    {students === null ? <div className="muted small">…</div> : error ? <>
      <div className="muted small" style={{ marginBottom: 10 }}>{t('Could not load your students.')}</div>
      <Button onClick={load}>{t('Try again')}</Button>
    </> : students.length === 0 ? <div className="empty">
      <div className="ico"><Icon name="people" /></div>
      <h3>{t('No students yet')}</h3>
      <div className="muted small" style={{ marginBottom: 12 }}>{t('Invite your first student — generate a link or code and send it to them.')}</div>
      <Button variant="primary" onClick={openInvite}>{t('Invite')}</Button>
    </div> : <>
      <SearchField value={q} onChange={e => setQ(e.target.value)} onClear={() => setQ('')} placeholder={t('Search student…')} />
      <div style={{ height: 10 }} />
      {pendingCount > 0 && <Row icon="link" title={t('Pending invites ({0})', pendingCount)} accessory="chevron" onClick={openInvite} />}
      {sorted.length === 0 ? <div className="empty"><div className="ico"><Icon name="magnifier" /></div>{t('No student found matching "{0}".', q)}</div> : (
        <Section title={t('Your students')}>
          {sorted.map(s => <Row key={s.id} title={s.name || t('(no name)')} subtitle={summaryLine(s.summary)}
            iconTint={s.summary?.idle ? 'var(--orange)' : undefined} icon={s.summary?.idle ? 'warning' : undefined}
            accessory="chevron" onClick={() => nav('/alunos/' + encodeURIComponent(s.id))} />)}
        </Section>
      )}
      <div style={{ height: 10 }} />
      <Button variant="tinted" icon="list" onClick={() => nav('/alunos/biblioteca')}>{t('My library')}</Button>
    </>}
  </>
}
