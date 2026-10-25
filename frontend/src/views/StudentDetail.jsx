import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { exerciseNameFor, exerciseNameClass } from '../lib/i18n.js'
import { fmtDate, durPart, DAYS, DAYN } from '../lib/format.js'
import { setLabel } from '../lib/history.js'
import { hasCompletedWork } from '../lib/workout-model.js'
import { EXIDX } from '../lib/exercises.js'
import { e1rmSeries } from '../lib/onerm.js'
import { loadOfWorkouts, muscleBalanceWindow } from '../lib/muscles.js'
import { Button, Row, Section, Segmented, SelectRow, TextArea } from '../components/ui.jsx'
import { confirmSheet, menuSheet, WorkoutRow } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import LineChart from '../components/LineChart.jsx'
import BodyMap, { BodyMapLegend } from '../components/BodyMap.jsx'

/* ISO-1594/ISO-1610 — Tela 2: Ficha do aluno (`/alunos/:id`). Read-only: every field on screen
 * comes from GET /api/teacher/student (and the small set of teacher-only mutations below), held
 * entirely in this component's own useState — never in useStore/S. Opening this screen must not
 * change a single byte of the teacher's own `localStorage`/`gym_state_v1`; see
 * StudentDetail.store-isolation.test.jsx.
 */

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] // Monday-first, same order lib/plan-share.js uses

// fmtDate (lib/format.js) does `new Date(iso + 'T12:00:00')` — it wants a plain YYYY-MM-DD, not
// the full ISO datetime strings the teacher routes return for acceptedAt/endedAt/created/updated
// (Postgres timestamps via .toISOString()). Truncating here, once, instead of at every call site.
const dateOnly = iso => (iso ? iso.slice(0, 10) : null)

function nameOf(id, customEx) {
  if (EXIDX[id]) return exerciseNameFor(EXIDX[id])
  const c = (customEx || []).find(x => x.id === id)
  return c ? c.name : id
}

function ReadOnlyWorkoutSheet({ w, customEx, close }) {
  return <>
    <h3>{w.name}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{[fmtDate(w.d, true), ...durPart((w.end || 0) - (w.start || 0))].join(' · ')}</div>
    {(w.entries || []).map((e, i) => {
      const ex = EXIDX[e.id]
      return <div key={i} className="row wd-ex" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className={'tt ' + exerciseNameClass(ex)} style={{ fontWeight: 600 }}>{nameOf(e.id, customEx)}</div>
          <div className="ss">{(e.sets || []).filter(hasCompletedWork).map(s => setLabel(e.id, s, e.target)).join('  ·  ') || t('no sets')}</div>
        </div>
      </div>
    })}
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

function Tracking({ id, view }) {
  const workouts = view.workouts || []
  const exIds = useMemo(() => {
    const seen = new Set()
    const ids = []
    for (const w of workouts) for (const e of (w.entries || [])) { if (!seen.has(e.id)) { seen.add(e.id); ids.push(e.id) } }
    return ids
  }, [workouts])
  const [exId, setExId] = useState(null)
  useEffect(() => { if (!exId && exIds.length) setExId(exIds[exIds.length - 1]) }, [exIds, exId])

  if (!workouts.length) return <div className="empty"><div className="ico"><Icon name="dumbbell" /></div>{t('{0} has not logged a workout yet.', view.studentName || '')}</div>

  const points = exId ? e1rmSeries({ workouts }, exId) : []
  const windowed = muscleBalanceWindow(workouts, 90)
  const load = loadOfWorkouts(windowed)
  const bwPoints = (view.bodyweight || []).map(b => ({ t: new Date(b.d + 'T12:00:00').getTime(), y: b.w, d: b.d }))

  return <>
    <Section title={t('Logged workouts')}>
      <div className="list">
        {[...workouts].reverse().slice(0, 20).map(w => <WorkoutRow key={w.id} w={w}
          onClick={() => useUI.getState().openSheet(close => <ReadOnlyWorkoutSheet w={w} customEx={view.customEx} close={close} />)} />)}
      </div>
    </Section>

    {exIds.length > 0 && <Section title={t('1RM progress')}>
      <SelectRow title={t('Exercise')} value={exId} options={exIds.map(id => ({ value: id, label: nameOf(id, view.customEx) }))} onChange={setExId}
        search={{ placeholder: t('Search…'), label: t('Search…'), emptyLabel: t('No match'), match: (o, q) => o.label.toLowerCase().includes(q.trim().toLowerCase()) }} />
      {points.length > 1 ? <LineChart points={points} h={160} unit={view.unit} /> : <div className="muted small">{t('Not enough data yet.')}</div>}
    </Section>}

    <Section title={t('Muscle balance')} footer={t('Load over the last 90 days.')}>
      <BodyMap load={load} body="male" />
      <BodyMapLegend />
    </Section>

    <Section title={t('Body weight')}>
      {!view.shareBodyweight
        ? <div className="muted small">{t('The student does not share their body weight.')}</div>
        : bwPoints.length > 1 ? <LineChart points={bwPoints} h={140} unit={view.unit} />
        : <div className="muted small">{t('Not enough data yet.')}</div>}
    </Section>
  </>
}

function AssignSheet({ studentId, mode, close, onDone, onDenied }) {
  const toast = useUI(s => s.toast)
  const teacherLibrary = useStore(s => s.S.teacherLibrary)
  const [step, setStep] = useState('origin') // 'origin' | 'routine' | 'program' | 'schedule'
  const [kind, setKind] = useState(null)
  const [routine, setRoutine] = useState(null)   // a teacherLibrary entry
  const [programs, setPrograms] = useState(null)
  const [program, setProgram] = useState(null)
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10))
  const [days, setDays] = useState([])
  const [saving, setSaving] = useState(false)

  const pickRoutine = () => { setKind('routine'); setStep('routine') }
  const pickProgram = () => {
    setKind('program'); setStep('program')
    if (!programs) api('/api/teacher/programs').then(d => setPrograms(d.programs || [])).catch(() => setPrograms([]))
  }
  const toggleDay = d => setDays(ds => ds.includes(d) ? ds.filter(x => x !== d) : [...ds, d])

  const confirmAssign = () => {
    const body = { id: studentId, startsOn, days: days.length ? days : null }
    if (kind === 'routine') body.kind = 'routine', body.routine = { name: routine.name, ex: routine.ex, ...(routine.customEx?.length ? { customEx: routine.customEx } : {}) }
    else body.kind = 'program', body.programId = program.id
    const go = async () => {
      setSaving(true)
      try {
        await api('/api/teacher/student/assign', { method: 'POST', body: JSON.stringify(body) })
        close()
        onDone()
      } catch (e) {
        setSaving(false)
        if (e.status === 403) { close(); onDenied(); return }
        toast(e.data?.code === 'assignment-conflict' ? t('Another assignment just started. Reload and try again.') : t('Could not save. Try again.'))
      }
    }
    if (mode === 'switch') {
      confirmSheet({ title: t('Switch the current routine?'), message: t('The current routine will end and be replaced.'), confirmText: t('Switch'), onConfirm: go })
    } else go()
  }

  if (step === 'origin') return <>
    <h3>{mode === 'switch' ? t('Switch routine') : t('Assign a new routine')}</h3>
    <Button variant="tinted" onClick={pickProgram} style={{ marginBottom: 8 }}>{t('Recommend a Program')}</Button>
    <Button variant="tinted" onClick={pickRoutine}>{t('Build/choose a routine')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>

  if (step === 'routine') return <>
    <h3>{t('My library')}</h3>
    {!teacherLibrary?.length ? <div className="empty">
      <div className="muted small" style={{ marginBottom: 10 }}>{t('Your library is empty. Build a routine there first.')}</div>
      <Button variant="ghost" onClick={close}>{t('Done')}</Button>
    </div> : <div className="list">
      {teacherLibrary.map(r => <Row key={r.id} title={r.name} accessory="chevron" onClick={() => { setRoutine(r); setStep('schedule') }} />)}
    </div>}
  </>

  if (step === 'program') return <>
    <h3>{t('Catalog Programs')}</h3>
    {programs === null ? <div className="muted small">…</div> : programs.length === 0
      ? <div className="muted small">{t('No published Programs yet.')}</div>
      : <div className="list">{programs.map(p => <Row key={p.id} title={p.title} subtitle={p.description} accessory="chevron" onClick={() => { setProgram(p); setStep('schedule') }} />)}</div>}
  </>

  // step === 'schedule'
  return <>
    <h3>{t('Starts on')}</h3>
    {/* api/teacher.js's validateSchedule allows 7 days in the past to 60 in the future — matched
        here so the date picker itself refuses what the server would, rather than a round trip. */}
    <input type="date" className="field" value={startsOn} onChange={e => setStartsOn(e.target.value)}
      min={new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}
      max={new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)}
      style={{ marginBottom: 14 }} />
    <h3>{t('Days of the week (optional)')}</h3>
    <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
      {WEEK_ORDER.map(d => <button key={d} className={'btn sm' + (days.includes(d) ? ' primary' : ' tinted')} aria-pressed={days.includes(d)}
        title={t(DAYN[d])} onClick={() => toggleDay(d)}>{t(DAYS[d])}</button>)}
    </div>
    <div className="muted small" style={{ marginBottom: 14 }}>{days.length ? null : t('No fixed days — the student trains whenever they can.')}</div>
    <Button variant="primary" disabled={saving} onClick={confirmAssign}>{saving ? '…' : t('Confirm')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}

function dayList(days) {
  return days?.length ? days.slice().sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b)).map(d => t(DAYS[d])).join(' · ') : t('no fixed days')
}

// D10: a link the student just ended answers 403 on the very next call, from any tab — the view
// must drop everything and show "you no longer follow them" rather than let a stale screen sit
// there (the design doc's own "never show outdated data after that answer" rule). Every mutating
// call below checks for it; `onDenied` is StudentDetail's own setError('denied').
const reportIfDenied = (e, onDenied, toast) => (e.status === 403 ? onDenied() : toast(t('Could not save. Try again.')))

function Assignments({ id, view, reload, onDenied }) {
  const toast = useUI(s => s.toast)
  const a = view.assignment

  const openAssign = mode => useUI.getState().openSheet(close => <AssignSheet studentId={id} mode={mode} close={close} onDone={reload} onDenied={onDenied} />)

  const end = () => confirmSheet({
    title: t('End this routine?'), message: t('The routine stays on the student\'s Plan, marked as ended by the teacher.'),
    confirmText: t('End'), danger: true,
    onConfirm: () => api('/api/teacher/student/assignment/end', { method: 'POST', body: JSON.stringify({ id }) }).then(reload).catch(e => reportIfDenied(e, onDenied, toast))
  })

  return <>
    {a ? <Section title={t('Current routine')}>
      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontWeight: 600 }}>{a.name || t('(untitled)')}</div>
        <div className="muted small">{a.kind === 'program' ? t('Catalog Program') : t('Your routine')} · {t('since {0}', fmtDate(a.startsOn, true))}</div>
        <div className="muted small">{dayList(a.days)}</div>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <Button size="sm" onClick={() => openAssign('switch')}>{t('Switch')}</Button>
          <Button size="sm" variant="ghost" className="dim" onClick={end}>{t('End')}</Button>
        </div>
      </div>
    </Section> : null}

    {!a && <Button variant="primary" onClick={() => openAssign('new')}>{t('Assign a new routine')}</Button>}

    {view.assignmentHistory?.length > 0 && <Section title={t('Previous assignments')}>
      {view.assignmentHistory.map((h, i) => <Row key={i} title={h.name || t('(untitled)')}
        subtitle={[fmtDate(h.startsOn, true), h.endedAt ? fmtDate(dateOnly(h.endedAt), true) : null].filter(Boolean).join(' – ') + ' · ' +
          (h.endReason === 'replaced' ? t('switched for another') : h.endReason === 'by-student' ? t('ended by the student') : t('ended by the teacher'))} />)}
    </Section>}
  </>
}

function NoteCard({ n, onEdited, onDeleted, onDenied }) {
  const toast = useUI(s => s.toast)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(n.body)
  const save = async () => {
    try {
      const { note } = await api('/api/teacher/student/notes/update', { method: 'POST', body: JSON.stringify({ id: n.studentId, noteId: n.id, body: text }) })
      onEdited(note)
      setEditing(false)
    } catch (e) { reportIfDenied(e, onDenied, toast) } // stays in edit mode on an ordinary failure — the typed text is not lost
  }
  const del = () => confirmSheet({
    title: t('Delete this note?'), confirmText: t('Delete'), danger: true,
    onConfirm: () => api('/api/teacher/student/notes/delete', { method: 'POST', body: JSON.stringify({ id: n.studentId, noteId: n.id }) }).then(() => onDeleted(n.id)).catch(e => reportIfDenied(e, onDenied, toast))
  })
  if (editing) return <div className="card" style={{ padding: 12 }}>
    <TextArea value={text} onChange={e => setText(e.target.value.slice(0, 4000))} rows={4} style={{ width: '100%' }} />
    <div className="muted small" style={{ textAlign: 'end' }}>{text.length}/4000</div>
    <div className="row" style={{ gap: 8 }}><Button size="sm" variant="primary" onClick={save}>{t('Save')}</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('Cancel')}</Button></div>
  </div>
  return <div className="card" style={{ padding: 12 }}>
    <div className="row between"><div className="muted small">{fmtDate(dateOnly(n.updated || n.created), true)}</div>
      <button className="iconbtn" onClick={() => menuSheet({ items: [{ label: t('Edit'), onClick: () => setEditing(true) }, { label: t('Delete'), danger: true, onClick: del }] })}><Icon name="more" /></button></div>
    <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
  </div>
}

function NewNoteSheet({ id, close, onSaved, onDenied }) {
  const toast = useUI(s => s.toast)
  const [v, setV] = useState('')
  const save = async () => {
    try { await api('/api/teacher/student/notes', { method: 'POST', body: JSON.stringify({ id, body: v }) }); close(); toast(t('Note saved')); onSaved() }
    catch (e) { if (e.status === 403) { close(); onDenied() } else toast(t('Could not save. Try again.')) }
  }
  return <>
    <h3>{t('New note')}</h3>
    <div className="muted small" style={{ marginBottom: 10 }}>{t('Only you see these notes. They are deleted if the link ends.')}</div>
    <TextArea autoFocus value={v} onChange={e => setV(e.target.value.slice(0, 4000))} rows={6} style={{ width: '100%' }} />
    <div className="muted small" style={{ textAlign: 'end', marginBottom: 10 }}>{v.length}/4000</div>
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}

function Notes({ id, onDenied }) {
  const [notes, setNotes] = useState(null)
  const load = () => api('/api/teacher/student/notes?id=' + encodeURIComponent(id))
    .then(d => setNotes((d.notes || []).map(n => ({ ...n, studentId: id }))))
    .catch(e => e.status === 403 ? onDenied() : setNotes([]))
  useEffect(() => { load() }, [id])
  const newNote = () => useUI.getState().openSheet(close => <NewNoteSheet id={id} close={close} onSaved={load} onDenied={onDenied} />)
  return <>
    <div className="muted small" style={{ marginBottom: 10 }}>{t('Only you see these notes. They are deleted if the link ends.')}</div>
    <Button variant="primary" icon="plus" onClick={newNote} style={{ marginBottom: 10 }}>{t('New note')}</Button>
    {notes === null ? <div className="muted small">…</div> : notes.length === 0
      ? <div className="empty">{t('No notes yet.')}</div>
      : <div className="list">{notes.map(n => <NoteCard key={n.id} n={n} onDenied={onDenied}
          onEdited={updated => setNotes(ns => ns.map(x => x.id === n.id ? { ...updated, studentId: id } : x))}
          onDeleted={delId => setNotes(ns => ns.filter(x => x.id !== delId))} />)}</div>}
  </>
}

export default function StudentDetail() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const { id } = useParams()
  const [view, setView] = useState(null)   // GET /api/teacher/student response, local only
  const [name, setName] = useState(null)
  // GET /api/teacher/student does not carry the link's acceptedAt (that's the list route's own
  // field) — read once from GET /api/teacher/students, same place the name comes from.
  const [acceptedAt, setAcceptedAt] = useState(null)
  const [tab, setTab] = useState('tracking')
  const [error, setError] = useState(null) // 'denied' | 'other' | null

  const load = () => {
    setError(null)
    api('/api/teacher/students').then(d => {
      const found = (d.students || []).find(s => s.id === id)
      if (found) { setName(found.name); setAcceptedAt(found.acceptedAt) }
    }).catch(() => {})
    return api('/api/teacher/student?id=' + encodeURIComponent(id))
      .then(d => setView(d))
      .catch(e => setError(e.status === 403 ? 'denied' : 'other'))
  }
  useEffect(() => { load() }, [id])

  const removeStudent = () => confirmSheet({
    title: t('Remove {0} from your list?', name || ''),
    message: t('You stop seeing their workouts. They keep the routines you assigned — those become theirs. Your notes about them are deleted.'),
    confirmText: t('Remove'), danger: true,
    onConfirm: () => api('/api/teacher/student/remove', { method: 'POST', body: JSON.stringify({ id }) }).then(() => nav('/alunos')).catch(() => toast(t('Could not save. Try again.')))
  })

  if (error === 'denied') return <div className="empty">
    <div className="muted small" style={{ marginBottom: 12 }}>{t('You no longer follow {0}.', name || '')}</div>
    <Button variant="primary" onClick={() => nav('/alunos')}>{t('Back to Students')}</Button>
  </div>

  return <>
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/alunos')} aria-label={t('Students')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}>
        <h1>{name || '…'}</h1>
        {acceptedAt && <div className="sub">{t('Student since {0}', fmtDate(dateOnly(acceptedAt), true))}</div>}
      </div>
      <button className="iconbtn" onClick={() => menuSheet({ items: [{ label: t('Remove student'), danger: true, onClick: removeStudent }] })}><Icon name="more" /></button>
    </div>

    <Segmented value={tab} onChange={setTab} options={[
      { value: 'tracking', label: t('Tracking') },
      { value: 'routines', label: t('Routines') },
      { value: 'notes', label: t('Notes') }
    ]} />
    <div style={{ height: 14 }} />

    {error === 'other' ? <>
      <div className="muted small" style={{ marginBottom: 10 }}>{t('Could not load {0}\'s data.', name || '')}</div>
      <Button onClick={load}>{t('Try again')}</Button>
    </> : !view ? <div className="muted small">…</div> : (
      tab === 'tracking' ? <Tracking id={id} view={{ ...view, studentName: name }} /> :
      tab === 'routines' ? <Assignments id={id} view={view} reload={load} onDenied={() => setError('denied')} /> :
      <Notes id={id} onDenied={() => setError('denied')} />
    )}
  </>
}
