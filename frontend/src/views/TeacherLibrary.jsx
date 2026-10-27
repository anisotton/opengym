import { useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t, exerciseNameFor, exerciseNameClass } from '../lib/i18n.js'
import { uid, exerciseNameText } from '../lib/format.js'
import { defaultConfig, exLine } from '../lib/history.js'
import { speedUnitOf } from '../lib/speed.js'
import { copyRoutine } from '../lib/routines.js'
import { exOr } from '../lib/exercises.js'
import { exercisePicker, exConfigSheet, confirmSheet } from '../sheets.jsx'
import { Button, Row, Section } from '../components/ui.jsx'
import { Thumb } from '../components/Media.jsx'
import Icon from '../components/Icon.jsx'

/* ISO-1594/ISO-1610 — Tela 3: Biblioteca do professor (`/alunos/biblioteca`). S.teacherLibrary is
 * the teacher's own account data (unlike StudentDetail.jsx, writing here through useStore.update
 * is correct — it is the teacher's plan, synced normally by PUT /api/data).
 *
 * Known simplification (flagged for Sentinel/Oráculo): the design spec shows "Usada com {0}
 * alunas" per routine. ISO-1609's assignment model deliberately has no column linking an
 * assignment back to the library entry it was copied from (D16: an assignment is a disconnected
 * snapshot) — so that count cannot be computed from the API as it exists today without a schema
 * change to ISO-1609's already-reviewed contract. Left out rather than faked with a heuristic.
 * The exercise editor here is also a smaller subset of RoutineEdit.jsx's (no drag-reorder, no
 * supersets) — RoutineEdit itself cannot be reused as-is (hard-coupled to S.routines throughout,
 * confirmed by reading it; forking its full feature set was out of scope for this pass).
 */

function EditEntry({ r, i, e, S, edit }) {
  const ex = exOr(e.id)
  return <div className="item" style={{ cursor: 'pointer' }}
    onClick={() => exConfigSheet(ex, e, cfg => edit(x => { x[i] = { id: x[i].id, ...cfg } }), () => edit(x => { x.splice(i, 1) }), r)}>
    <Thumb ex={ex} />
    <div className="grow"><div className={'tt ' + exerciseNameClass(ex)}>{exerciseNameFor(ex)}</div><div className="ss">{exLine(e, S.unit, speedUnitOf(S))}</div></div>
    <button className="iconbtn" aria-label={t('Remove')} onClick={ev => { ev.stopPropagation(); edit(x => x.splice(i, 1)) }}><Icon name="xmark" /></button>
  </div>
}

function LibraryEditor({ id, onBack }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const r = S.teacherLibrary.find(x => x.id === id)
  if (!r) { onBack(); return null }
  const edit = fn => update(s => { fn(s.teacherLibrary.find(x => x.id === id).ex) })

  return <>
    <div className="hdr">
      <button className="iconbtn" onClick={onBack} aria-label={t('My library')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, margin: '0 12px' }}>
        <input className="input" defaultValue={r.name} style={{ fontWeight: 600, fontSize: 20 }}
          onChange={e => update(s => { s.teacherLibrary.find(x => x.id === id).name = e.target.value.trim() || t('Routine') })} />
      </div>
    </div>
    <div className="card" style={{ marginBottom: 14, padding: 10 }}>
      <div className="small dim">{t('Changing this routine does not change what students already received — each assignment is a snapshot taken at the time it was assigned.')}</div>
    </div>
    {r.fromProgramId && !r.ex.length && <div className="muted small" style={{ marginBottom: 12 }}>{t('Now add the exercises.')}</div>}

    {r.ex.length > 0 && <div className="list" style={{ marginBottom: 14 }}>
      {r.ex.map((e, i) => <EditEntry key={i} r={r} i={i} e={e} S={S} edit={edit} />)}
    </div>}

    <Button variant="primary" icon="plus" onClick={() => exercisePicker((ex, quick) => {
      if (quick) { edit(x => x.push({ id: ex.id, ...defaultConfig(ex.id) })); toast(t('"{0}" added to {1}', exerciseNameText(ex), r.name)) }
      else exConfigSheet(ex, null, cfg => edit(x => { x.push({ id: ex.id, ...cfg }) }), null, r)
    })}>{t('Add exercise')}</Button>
  </>
}

function StartFromProgramSheet({ close, onPick }) {
  const [programs, setPrograms] = useState(null)
  useEffect(() => { api('/api/teacher/programs').then(d => setPrograms(d.programs || [])).catch(() => setPrograms([])) }, [])
  return <>
    <h3>{t('Start from a Program')}</h3>
    <div className="muted small" style={{ marginBottom: 10 }}>{t('Only the name and description are copied — add the exercises yourself.')}</div>
    {programs === null ? <div className="muted small">…</div> : programs.length === 0
      ? <div className="muted small">{t('No published Programs yet.')}</div>
      : <div className="list">{programs.map(p => <Row key={p.id} title={p.title} subtitle={p.description} accessory="chevron" onClick={() => onPick(p)} />)}</div>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}

export default function TeacherLibrary() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const [editId, setEditId] = useState(null)

  if (editId) return <LibraryEditor id={editId} onBack={() => setEditId(null)} />

  const lib = S.teacherLibrary || []
  const addAndEdit = r => { update(s => { s.teacherLibrary = [...(s.teacherLibrary || []), r] }); setEditId(r.id) }
  const newRoutine = () => addAndEdit({ id: uid(), name: t('Routine'), ex: [] })
  const fromProgram = () => useUI.getState().openSheet(close => <StartFromProgramSheet close={close} onPick={p => { close(); addAndEdit({ id: uid(), name: p.title, ex: [], fromProgramId: p.id }) }} />)
  const duplicate = r => update(s => {
    const copy = copyRoutine(r, t('Copy'))
    s.teacherLibrary = [...(s.teacherLibrary || []), copy]
  })
  const remove = r => confirmSheet({
    title: t('Delete routine?'), message: t('"{0}" will be removed from your library.', r.name), confirmText: t('Delete'), danger: true,
    onConfirm: () => update(s => { s.teacherLibrary = (s.teacherLibrary || []).filter(x => x.id !== r.id) })
  })

  return <>
    <div className="hdr">
      <button className="iconbtn" data-back="/alunos" onClick={() => nav('/alunos')} aria-label={t('Students')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('My library')}</h1>
        <div className="sub">{lib.length === 1 ? t('1 routine') : t('{0} routines', lib.length)}</div></div>
      <Button size="sm" variant="primary" icon="plus" onClick={newRoutine}>{t('New routine')}</Button>
    </div>
    <Button variant="tinted" size="sm" onClick={fromProgram} style={{ marginBottom: 14 }}>{t('Start from a Program')}</Button>
    {lib.length === 0 ? <div className="empty">
      <div className="ico"><Icon name="list" /></div>
      <h3>{t('No routines in your library yet')}</h3>
      <div className="muted small" style={{ marginBottom: 12 }}>{t('Build a routine (or start from a catalog Program) to reuse with your students.')}</div>
      <Button variant="primary" onClick={newRoutine}>{t('New routine')}</Button>
    </div> : <Section>
      {lib.map(r => <Row key={r.id} title={r.name} onClick={() => setEditId(r.id)}>
        <button className="iconbtn" onClick={ev => { ev.stopPropagation(); duplicate(r) }} aria-label={t('Duplicate')}><Icon name="copy" /></button>
        <button className="iconbtn" onClick={ev => { ev.stopPropagation(); remove(r) }} aria-label={t('Delete')}><Icon name="trash" /></button>
      </Row>)}
    </Section>}
  </>
}
