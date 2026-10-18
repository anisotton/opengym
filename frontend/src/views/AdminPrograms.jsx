import { useEffect, useRef, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { api, apiUpload, appBase } from '../lib/api.js'
import {
  CATEGORIES, DIFFICULTIES, formatMinutes, canPurge, coverAltError, fieldError, cropRectFor16x9,
  TITLE_MAX, DESCRIPTION_MAX
} from '../lib/programs.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button, TextField, TextArea } from '../components/ui.jsx'

// Admin-only training program catalog (ISO-1485) — instance-wide content an admin curates, not
// a user's own training data. Deliberately English-only, same as the rest of this dashboard
// (see Admin.jsx's own note) — no t()/locale entries.

const TABS = [['', 'All'], ['draft', 'Drafts'], ['published', 'Published'], ['trash', 'Trash']]
const categoryLabel = v => (CATEGORIES.find(c => c.value === v) || {}).label || v
const difficultyLabel = v => (DIFFICULTIES.find(d => d.value === v) || {}).label || v
const coverUrl = (id, rev) => appBase().replace(/\/$/, '') + '/api/admin/program/cover?id=' + encodeURIComponent(id) + '&v=' + rev

function Thumb({ program }) {
  if (!program.coverFile) {
    return <div className={'pg-thumb pg-thumb-ph cat-' + program.category} aria-hidden="true">{categoryLabel(program.category)}</div>
  }
  return <img className="pg-thumb" src={coverUrl(program.id, program.rev)} alt="" onError={e => { e.target.style.display = 'none' }} />
}

function StatusPill({ program }) {
  if (program.deletedAt) return <span className="adm-pill bad">trash</span>
  return <span className={'adm-pill' + (program.status === 'published' ? ' ok' : '')}>{program.status}</span>
}

/* ---------------------------------------------------------------- cover upload */

function CoverField({ program, onSaved, disabled }) {
  const toast = useUI(s => s.toast)
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [pendingAlt, setPendingAlt] = useState(program.coverAlt || '')
  const [altTouched, setAltTouched] = useState(false)
  const altErr = program.coverFile || pendingAlt ? coverAltError(pendingAlt, program.title) : null

  const pick = () => fileRef.current?.click()

  const onFile = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const bitmap = await createImageBitmap(file)
      const rect = cropRectFor16x9(bitmap.width, bitmap.height)
      if (!rect) throw new Error('Image too small (min 640×360)')
      const canvas = document.createElement('canvas')
      canvas.width = rect.outW; canvas.height = rect.outH
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.outW, rect.outH)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9))
      if (!blob) throw new Error('Could not process that image')
      const alt = pendingAlt || ''
      const err = coverAltError(alt, program.title)
      if (err) { setAltTouched(true); throw new Error('Add alt text first: ' + err) }
      const path = `/api/admin/program/cover?id=${encodeURIComponent(program.id)}&rev=${program.rev}` +
        `&w=${rect.outW}&h=${rect.outH}&alt=${encodeURIComponent(alt)}`
      const r = await apiUpload(path, blob, 'image/webp')
      toast('Cover uploaded')
      onSaved(r.program)
    } catch (err) { toast(err.message) }
    finally { setBusy(false) }
  }

  const remove = () => confirmSheet({
    title: 'Remove cover image?',
    message: 'The program goes back to the plain placeholder until a new cover is added.',
    confirmText: 'Remove', danger: true,
    onConfirm: () => api('/api/admin/program/cover/remove', { method: 'POST', body: JSON.stringify({ id: program.id, rev: program.rev }) })
      .then(r => { toast('Cover removed'); onSaved(r.program) })
      .catch(e => toast(e.message))
  })

  return <div className="adm-field">
    <label>Cover image</label>
    <div className="pg-cover-row">
      <Thumb program={program} />
      <div className="col" style={{ gap: 6 }}>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/avif" style={{ display: 'none' }} onChange={onFile} />
        <Button size="sm" disabled={disabled || busy} onClick={pick}>{busy ? 'Processing…' : program.coverFile ? 'Replace' : 'Add cover'}</Button>
        {program.coverFile && <button className="iconbtn adm-iconbtn" aria-label="Remove cover image" style={{ color: 'var(--red)' }} disabled={disabled || busy} onClick={remove}><Icon name="trash" /></button>}
      </div>
    </div>
    <div className="adm-hint">16:9, cropped automatically. JPEG, PNG or WebP.</div>
    <label style={{ marginTop: 8 }}>Alt text{!program.coverFile && ' (set when you add a cover)'}</label>
    <TextField value={pendingAlt} placeholder="Describe what the image shows (not the title)" disabled={disabled}
      onChange={e => setPendingAlt(e.target.value)} onBlur={() => setAltTouched(true)} />
    {altTouched && altErr && <div className="adm-hint" style={{ color: 'var(--red)' }}>{altErr}</div>}
  </div>
}

/* ---------------------------------------------------------------- create/edit form */

function emptyDraft() {
  return { title: '', description: '', category: 'general', difficulty: 'beginner', sessionMinutes: 45, status: 'draft' }
}

function ProgramFormSheet({ id, onDone, close }) {
  const toast = useUI(s => s.toast)
  const [program, setProgram] = useState(null)   // the loaded row, once it exists server-side
  const [draft, setDraft] = useState(emptyDraft())
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [staleBanner, setStaleBanner] = useState(null)
  const isNew = !id

  useEffect(() => {
    if (!id) return
    api('/api/admin/program?id=' + encodeURIComponent(id)).then(d => {
      setProgram(d.program)
      setDraft({
        title: d.program.title, description: d.program.description, category: d.program.category,
        difficulty: d.program.difficulty, sessionMinutes: d.program.sessionMinutes, status: d.program.status
      })
    }).catch(e => toast(e.message))
  }, [id])

  const inTrash = !!program?.deletedAt
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }))

  const validateAll = () => {
    const next = {}
    for (const f of ['title', 'description', 'sessionMinutes']) { const m = fieldError(f, draft[f]); if (m) next[f] = m }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const save = async () => {
    if (!validateAll()) return
    setSaving(true)
    setStaleBanner(null)
    try {
      if (isNew) {
        const r = await api('/api/admin/programs/new', { method: 'POST', body: JSON.stringify(draft) })
        setProgram(r.program)
        toast('Program created')
        onDone()
      } else {
        const r = await api('/api/admin/program/update', { method: 'POST', body: JSON.stringify({ id: program.id, rev: program.rev, ...draft }) })
        setProgram(r.program)
        toast('Saved')
        onDone()
      }
    } catch (e) {
      if (e.status === 409 && e.data?.code === 'stale') {
        setStaleBanner(e.data.current)
      } else if (e.status === 409 && e.data?.code === 'title-taken') {
        setErrors(x => ({ ...x, title: 'Another program already has this title' }))
      } else if (e.status === 400 && e.data?.field) {
        setErrors(x => ({ ...x, [e.data.field]: e.data.error }))
      } else {
        toast(e.message)
      }
    } finally { setSaving(false) }
  }

  const reload = () => api('/api/admin/program?id=' + encodeURIComponent(program.id)).then(d => {
    setProgram(d.program); setStaleBanner(null)
    setDraft({
      title: d.program.title, description: d.program.description, category: d.program.category,
      difficulty: d.program.difficulty, sessionMinutes: d.program.sessionMinutes, status: d.program.status
    })
  })

  const trash = () => confirmSheet({
    title: `Move "${program.title}" to trash?`,
    message: 'It disappears from the catalog right away.' + (program.status === 'published' ? ' It is currently published.' : '') +
      ' You can restore it for a while; after that it is deleted permanently.',
    confirmText: 'Move to trash', danger: true,
    onConfirm: () => api('/api/admin/program/trash', { method: 'POST', body: JSON.stringify({ id: program.id, rev: program.rev }) })
      .then(() => { toast('Moved to trash'); onDone(); close() })
      .catch(e => toast(e.message))
  })

  if (id && !program) return <div className="muted small">Loading…</div>

  return <>
    <h3>{isNew ? 'New program' : program.title}</h3>
    {staleBanner && <div className="adm-result bad" style={{ marginBottom: 10 }}>
      Changed by someone else since you opened this. <button className="btn" style={{ marginInlineStart: 8 }} onClick={reload}>Reload</button>
    </div>}
    <div className="adm-field">
      <label>Title</label>
      <TextField value={draft.title} maxLength={TITLE_MAX} disabled={inTrash} onChange={e => set('title', e.target.value)} />
      {errors.title && <div className="adm-hint" style={{ color: 'var(--red)' }}>{errors.title}</div>}
    </div>
    <div className="row" style={{ gap: 10 }}>
      <div className="adm-field" style={{ flex: 1 }}>
        <label>Category</label>
        <select className="adm-select" value={draft.category} disabled={inTrash} onChange={e => set('category', e.target.value)}>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div className="adm-field" style={{ flex: 1 }}>
        <label>Difficulty</label>
        <select className="adm-select" value={draft.difficulty} disabled={inTrash} onChange={e => set('difficulty', e.target.value)}>
          {DIFFICULTIES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>
    </div>
    <div className="adm-field">
      <label>Session length (minutes)</label>
      <input className="num" type="number" min="1" max="600" value={draft.sessionMinutes} disabled={inTrash}
        onChange={e => set('sessionMinutes', parseInt(e.target.value, 10) || 0)} />
      {errors.sessionMinutes && <div className="adm-hint" style={{ color: 'var(--red)' }}>{errors.sessionMinutes}</div>}
    </div>
    <div className="adm-field">
      <label>Description</label>
      <TextArea value={draft.description} maxLength={DESCRIPTION_MAX} rows={4} disabled={inTrash} onChange={e => set('description', e.target.value)} />
      {errors.description && <div className="adm-hint" style={{ color: 'var(--red)' }}>{errors.description}</div>}
    </div>
    <div className="adm-field">
      <label>Status</label>
      <select className="adm-select" value={draft.status} disabled={inTrash} onChange={e => set('status', e.target.value)}>
        <option value="draft">Draft</option>
        <option value="published">Published</option>
      </select>
    </div>
    {!isNew && program && <CoverField program={program} disabled={inTrash} onSaved={p => setProgram(p)} />}
    <div className="adm-actions">
      <Button variant="primary" disabled={saving || inTrash} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
      <Button onClick={close}>Cancel</Button>
      {!isNew && !inTrash && <button className="btn danger" style={{ marginInlineStart: 'auto' }} onClick={trash}>Move to trash</button>}
    </div>
    {!isNew && program && <>
      <h4 className="sec">History</h4>
      <History programId={program.id} />
    </>}
  </>
}

function History({ programId }) {
  const [events, setEvents] = useState(null)
  useEffect(() => { api('/api/admin/program?id=' + encodeURIComponent(programId)).then(d => setEvents(d.history)).catch(() => setEvents([])) }, [programId])
  if (!events) return <div className="muted small">Loading…</div>
  if (!events.length) return <div className="adm-empty">Nothing recorded yet.</div>
  return <div className="list">
    {events.map(e => <div key={e.id} className="row between" style={{ padding: '6px 2px', borderBottom: 'var(--hair) solid var(--sep)' }}>
      <span className="small">{e.action} — {e.actorName}</span>
      <span className="small muted">{new Date(e.at).toLocaleString()}</span>
    </div>)}
  </div>
}

/* ---------------------------------------------------------------- trash row actions */

// Locked (no Esc, no tap-outside) and the Delete button stays disabled until the typed text
// matches exactly — the server re-checks the same match itself (programs.js's
// titleMatchesForPurge), so this gate is about preventing a slip, not enforcing the rule.
function PurgeSheet({ program, onDone, close }) {
  const toast = useUI(s => s.toast)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = canPurge(typed, program.title)
  const purge = () => {
    setBusy(true)
    api('/api/admin/program/purge', { method: 'POST', body: JSON.stringify({ id: program.id, confirmTitle: typed }) })
      .then(() => { toast('Deleted permanently'); onDone(); close() })
      .catch(e => { setBusy(false); toast(e.message) })
  }
  return <div style={{ textAlign: 'center', padding: '4px 0' }}>
    <h3 style={{ marginBottom: 8 }}>Delete "{program.title}" for good?</h3>
    <div className="muted" style={{ marginBottom: 14, lineHeight: 1.5 }}>
      This cannot be undone. The program, its cover image and its links are deleted. Its history stays in the audit log.
    </div>
    <div className="adm-field" style={{ textAlign: 'start' }}>
      <label>Type the program title to confirm</label>
      <TextField value={typed} autoFocus placeholder={program.title} onChange={e => setTyped(e.target.value)} />
    </div>
    <button className="btn danger" disabled={!ok || busy} onClick={purge}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>Cancel</Button>
  </div>
}

function TrashRowActions({ program, reload }) {
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)

  const restore = () => api('/api/admin/program/restore', { method: 'POST', body: JSON.stringify({ id: program.id }) })
    .then(() => { toast('Restored as draft'); reload() })
    .catch(e => e.status === 409 && e.data?.code === 'title-taken'
      ? toast(`Another program is already called "${program.title}". Rename it first, then restore.`)
      : toast(e.message))

  const purge = () => openSheet(close => <PurgeSheet program={program} onDone={reload} close={close} />, { kind: 'center', locked: true })

  return <div className="row" style={{ gap: 6 }} onClick={e => e.stopPropagation()}>
    <Button size="sm" onClick={restore}>Restore</Button>
    <button className="iconbtn adm-iconbtn" aria-label="delete permanently" style={{ color: 'var(--red)' }} onClick={purge}><Icon name="trash" /></button>
  </div>
}

/* ---------------------------------------------------------------- main view */

export default function AdminPrograms() {
  const openSheet = useUI(s => s.openSheet)
  const toast = useUI(s => s.toast)
  const [tab, setTab] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)
  const [trashCount, setTrashCount] = useState(0)

  const load = () => {
    const trash = tab === 'trash'
    const status = trash ? '' : tab
    const params = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(trash ? { trash: '1' } : {}) })
    return api('/api/admin/programs?' + params.toString())
      .then(d => { setRows(d.programs); setTrashCount(d.trashCount || 0); setErr(null) })
      .catch(e => setErr(e.message))
  }

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q])

  const openForm = id => openSheet(close => <ProgramFormSheet id={id} onDone={load} close={close} />)

  return <div className="card">
    <div className="row between"><h2 style={{ margin: 0 }}>Training programs</h2>
      <Button variant="primary" size="sm" icon="plus" onClick={() => openForm(null)}>New program</Button></div>
    <div className="adm-lead">The instance's curated catalog of training programs — not any one user's own routines or workouts.</div>
    <div className="chips" style={{ marginBottom: 10 }}>
      {TABS.map(([v, l]) => <button key={v} className={'chip' + (tab === v ? ' on' : '')} onClick={() => setTab(v)}>
        {l}{v === 'trash' && trashCount ? ` (${trashCount})` : ''}
      </button>)}
    </div>
    <input className="field" style={{ marginBottom: 10 }} placeholder="Search title or description…" value={q} onChange={e => setQ(e.target.value)} />

    {err && <div className="adm-result bad" style={{ marginBottom: 10 }}>
      {err} <button className="btn" style={{ marginInlineStart: 8 }} onClick={load}>Retry</button>
    </div>}

    {!rows && !err && <div className="muted small">Loading…</div>}
    {rows && !rows.length && <div className="adm-empty">{q || tab ? 'No programs match.' : 'No programs yet.'}</div>}

    <div className="list">
      {(rows || []).map(p => <div key={p.id} className="item pg-row" onClick={() => tab !== 'trash' && openForm(p.id)}>
        <Thumb program={p} />
        <div className="grow">
          <div className="tt">{p.title} <StatusPill program={p} /></div>
          <div className="ss">{categoryLabel(p.category)} · {difficultyLabel(p.difficulty)} · {formatMinutes(p.sessionMinutes)}</div>
        </div>
        {tab === 'trash' ? <TrashRowActions program={p} reload={load} /> : <Icon name="chevronRight" className="chev" />}
      </div>)}
    </div>
  </div>
}
