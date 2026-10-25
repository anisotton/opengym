import { useState } from 'react'
import { imgSrc, gifSrc } from '../lib/exercises.js'
import { musclesOf } from '../lib/muscles.js'
import { useStore } from '../store/useStore.js'
import { t, exerciseNameFor } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import CustomMedia, { CustomThumb } from './CustomMedia.jsx'
import BodyMap from './BodyMap.jsx'

// An exercise's picture, wherever one shows. A custom exercise goes to CustomMedia.jsx — its own
// photo, GIF, video or link, from the local media store — and never through imgSrc/gifSrc, which
// name files of the shipped dataset (a stray img/gif on a custom exercise, written by a fork, is
// ignored). The split is by component, not by branch, so each side keeps its own hooks in order.
export default function Media(p) {
  return p.ex?.custom ? <CustomMedia {...p} /> : <BuiltinMedia {...p} />
}

// A built-in exercise's own views: the Brilhart exercises carry a front/back pair (or just
// front, until the back GIFs exist — ISO-1605), every other built-in (EXDB, text-only since the
// third-party library was pulled, ISO-1603) carries none. The single top-level img/gif a
// Brilhart entry also has is always a copy of its front view, kept there so list thumbnails
// (BuiltinThumb below) stay the front pose without needing to know about `views` at all.
const viewsOf = ex => (ex.views?.length ? ex.views : ex.gif ? [{ key: 'front', img: ex.img, gif: ex.gif }] : [])

// Primary/secondary legend for the muscle-map stand-in. Not BodyMapLegend's Less/More ramp —
// that scale is training volume or fatigue, which isn't what's being shown here.
function MuscleLegend() {
  return (
    <div className="hm-legend">
      <span>{t('Primary target')}</span><div className="hm-c l4" />
      <div className="hm-c l2" /><span>{t('Secondary')}</span>
    </div>
  )
}

// Segmented Frente/Costas control for the Brilhart exercises. Not the shared <Segmented> from
// ui.jsx: it needs to float over the media in a corner with its own translucent styling (to
// read on top of any GIF), not sit in the document flow like every other use of it.
function ViewSwitch({ views, view, onChange }) {
  return (
    <div className="gifviews" style={{ '--n': views.length, '--i': view }} onClick={e => e.stopPropagation()}>
      <span className="gv-sel" aria-hidden="true" />
      {views.map((v, i) => (
        <button key={v.key} className={i === view ? 'on' : ''} aria-pressed={i === view}
          aria-label={v.key === 'back' ? t('Show back view') : t('Show front view')}
          onClick={() => onChange(i)}>
          {v.key === 'back' ? t('Back') : t('Front')}
        </button>
      ))}
    </div>
  )
}

// Big autoplaying animation; tap toggles to the still frame. `compact` shrinks it (superset cards).
// `minimizable` (workout view) adds a persistent minimize/expand control so the animation stops
// eating the screen; the chosen size is saved to settings and carries across exercises and
// future workouts (issue #12). Settings can also turn workout media off entirely
// (gifSize 'off') — then nothing renders here and the exercise card closes up, exactly like
// an exercise without media. Any other/legacy value behaves as 'full'.
//
// An exercise with no media of its own (every EXDB entry today) still reserves this same slot:
// the muscle map it's already got the data for (target/secondary) stands in, wherever the slot
// is tall enough to read one (≥160px — the full card and the detail sheet; not the superset
// 120px or minimized 84px bands, where a body silhouette is noise, not signal) — the neutral
// icon tile covers those, same as a real media failure.
function BuiltinMedia({ ex, id, compact, minimizable }) {
  const [playing, setPlaying] = useState(true)
  const views = viewsOf(ex)
  const [view, setView] = useState(0)
  // null = showing the gif (or its still, if paused); 'gif' = the gif failed, showing the still;
  // 'all' = the still failed too, that view is exhausted. One slot per view, so a Brilhart
  // exercise can fall back to its other view before giving up to the generic icon.
  const [fails, setFails] = useState(() => views.map(() => null))
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)
  if (minimizable && gifSize === 'off') return null
  const mini = minimizable && gifSize === 'mini'
  const sizeClass = (compact ? ' compact' : '') + (mini ? ' mini' : '')
  const toggleSize = e => { e.stopPropagation(); update(s => { s.gifSize = mini ? 'full' : 'mini' }) }

  if (!views.length) {
    const showMap = !compact && !mini
    return (
      <div className={'exmedia nomedia' + sizeClass} id={id} aria-label={showMap ? t('Muscle map for this exercise') : undefined}>
        {showMap
          ? <><BodyMap className="exbm" load={musclesOf(ex)} /><MuscleLegend /></>
          : <div className="exmedia-x"><Icon name="dumbbell" /></div>}
      </div>
    )
  }

  const current = views[view]
  const broken = fails.every(f => f === 'all')
  const showGif = playing && fails[view] == null
  const onError = () => {
    const next = [...fails]
    next[view] = next[view] == null ? 'gif' : 'all'
    if (next[view] === 'all') {
      const other = next.findIndex((f, i) => i !== view && f !== 'all')
      if (other !== -1) setView(other)
    }
    setFails(next)
  }
  const onTap = () => {
    if (broken || fails[view] != null) { setFails(views.map(() => null)); setPlaying(true); return }
    setPlaying(p => !p)
  }
  return (
    <div className={'exmedia' + sizeClass + (broken ? ' broken' : '')} id={id} onClick={onTap}>
      {broken
        ? <div className="exmedia-x"><Icon name="dumbbell" /></div>
        : <img decoding="async" draggable={false}
            src={showGif ? gifSrc(ex, current.gif) : imgSrc(ex, current.img)}
            alt={exerciseNameFor(ex)} onError={onError} />}
      {views.length > 1 && !broken && <ViewSwitch views={views} view={view} onChange={setView} />}
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {!mini && !broken && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

// A still that will not load (offline and never cached, a lapsed session on a gated instance, a
// CDN hiccup) gets the same neutral tile as an exercise without media, instead of the browser's
// broken-image glyph in a list of them (#281). The failure is remembered per image, so a list
// that re-renders does not ask again; a new exercise in the same slot tries its own. Always the
// front view for a Brilhart exercise (ex.img), never whatever view the detail sheet last showed
// — a thumbnail is the pose that identifies the exercise, not a status readout.
export function Thumb(p) {
  return p.ex?.custom ? <CustomThumb {...p} /> : <BuiltinThumb {...p} />
}
function BuiltinThumb({ ex }) {
  const src = ex.img ? imgSrc(ex) : null
  const [broken, setBroken] = useState(null)
  if (!src || broken === src) return <div className="thumb thumb-x" aria-label={t('No image available for this exercise')}><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" draggable={false} src={src} alt="" onError={() => setBroken(src)} />
}
