import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { fetchAccountProgram, programCoverUrl } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { tappable } from '../lib/use-sheet-keyboard.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/* ISO-1594/ISO-1610 §6: "Programa recomendado aparece como card no Plano/Home" — a teacher's
 * `kind: 'program'` assignment only ever sets S.teacherProgram = { programId, ... } (lib/teacher.js
 * importAssignment); nothing about the Program's own title/cover/description is copied into the
 * student's state at import time (D7: a recommendation, not content pulled into the plan). This
 * card is the one place that fetches them, via GET /api/account/program(/cover) — reachable by
 * any signed-in account once a Program is published, the same boundary GET /api/teacher/programs
 * already uses, not only the student it was recommended to.
 *
 * Deliberately no "start" action: there is no existing mechanism anywhere in this codebase that
 * turns a catalog Program into logged workouts for an ordinary (non-teacher, non-admin) account —
 * confirmed by reading every current call site of a Program (TeacherLibrary.jsx and
 * StudentDetail.jsx's AssignSheet, both teacher-only, both only ever copy the title). Building
 * that conversion is a separate, materially larger feature with no spec of its own yet; this card
 * shows the recommendation (cover, title, description, "recommended by your teacher" badge) and
 * lets the student view it — the one thing the API and the rest of the app can actually back
 * today — rather than wiring a "Start" button to nothing.
 */
function ProgramDetailSheet({ program, close }) {
  const [broken, setBroken] = useState(false)
  return <>
    <h3>{program.title}</h3>
    <div className="small" style={{ color: 'var(--acc)', fontWeight: 600, marginBottom: 10 }}>{t('Recommended by your teacher')}</div>
    {program.hasCover && !broken &&
      <img src={programCoverUrl(program.id)} alt="" style={{ width: '100%', borderRadius: 12, marginBottom: 12, aspectRatio: '16/9', objectFit: 'cover' }} onError={() => setBroken(true)} />}
    {program.description && <div className="muted small" style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>{program.description}</div>}
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

export default function TeacherProgramCard() {
  const programId = useStore(s => s.S.teacherProgram?.programId)
  const [program, setProgram] = useState(null)   // null = loading/none; false = failed to load
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setProgram(null)
    setBroken(false)
    if (!programId) return
    fetchAccountProgram(programId).then(d => setProgram(d.program)).catch(() => setProgram(false))
  }, [programId])

  if (!programId || !program) return null
  const open = () => useUI.getState().openSheet(close => <ProgramDetailSheet program={program} close={close} />)
  return (
    <div className="card tappable" style={{ cursor: 'pointer' }} {...tappable(open)}>
      <div className="row" style={{ gap: 10 }}>
        {program.hasCover && !broken
          ? <img src={programCoverUrl(program.id)} alt="" style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'cover', flex: 'none' }} onError={() => setBroken(true)} />
          : <span className="lrow-i" style={{ background: 'var(--indigo)' }}><Icon name="sparkles" /></span>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="lbl2" style={{ color: 'var(--acc)' }}>{t('Recommended by your teacher')}</div>
          <div className="ttl">{program.title}</div>
        </div>
        <Icon name="chevronRight" className="chev" />
      </div>
    </div>
  )
}
