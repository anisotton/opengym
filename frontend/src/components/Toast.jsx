import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { t } from '../lib/i18n.js'

// The one toast. Mostly text; with an action (the Undo after a set is removed) it carries a button
// at its end, stays longer and holds still while a finger or the mouse rests on it. Its × sends it
// away at once: five seconds of Undo over the set list is long when you did mean to delete. The ×
// sits at the start, the far end from Undo, so a thumb aiming for one never lands on the other.
export default function Toast() {
  const msg = useUI(s => s.toastMsg)
  const sticky = useUI(s => s.toastSticky)
  const dismiss = useUI(s => s.dismissToast)
  const action = useUI(s => s.toastAction)
  const { pauseToast, resumeToast, runToastAction, dismissToast } = useUI.getState()
  const live = !!(msg && action)
  // ISO-1480: a sticky toast (a persistent WebAuthn error) is an alert that stays until tapped;
  // the ordinary one is a status line, with an Undo action when the store offers one.
  return <div id="toast" role={sticky ? 'alert' : 'status'} className={(msg ? 'show' : '') + (live ? ' has-action' : '') + (sticky ? ' sticky' : '')}
    onClick={sticky ? dismiss : undefined}
    onPointerEnter={live ? pauseToast : undefined} onPointerDown={live ? pauseToast : undefined}
    onPointerLeave={live ? resumeToast : undefined} onPointerCancel={live ? resumeToast : undefined}
    onPointerUp={live ? (e => { if (e.pointerType !== 'mouse') resumeToast() }) : undefined}>
    {live && <button type="button" className="toast-x" aria-label={t('Close')} onClick={dismissToast}>
      <Icon name="xmark" />
    </button>}
    <span className="toast-msg">{msg}</span>
    {live && <button type="button" className="toast-act" key={action.id} onClick={runToastAction}>
      <Icon name="undo" />{action.label}
    </button>}
  </div>
}
