import { useUI } from '../store/useUI.js'
export default function Toast() {
  const msg = useUI(s => s.toastMsg)
  const sticky = useUI(s => s.toastSticky)
  const dismiss = useUI(s => s.dismissToast)
  return <div id="toast" role={sticky ? 'alert' : undefined} className={(msg ? 'show' : '') + (sticky ? ' sticky' : '')}
    onClick={sticky ? dismiss : undefined}>{msg}</div>
}
