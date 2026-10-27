import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hideBoot } from './lib/boot.js'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation, useNavigationType } from 'react-router-dom'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI } from './components/ui.jsx'
import { setWeightDecimals } from './lib/format.js'
import { accentValue, applyAccent } from './lib/accent.js'
import { setLang, useLang, baseLang, t } from './lib/i18n.js'
import { parseGoogleCallback, takePendingReauth } from './lib/google-reauth.js'
import { resumeGoogleReauth } from './lib/api.js'
import { passwordError } from './components/PasswordAuth.jsx'
import { effectiveLang } from './lib/default-lang.js'
import { setPlayOnSilent, setVibrate, setAlarmBuzzer, setNativeBuzzer } from './lib/sound.js'
import { buzzAsAlarm } from './lib/rest-alert.js'
import { setNav, notePath, keyBefore, navToWorkout } from './lib/nav.js'
import { workoutVolume } from './lib/history.js'
import { setSystemBarsLight } from './lib/system-bars.js'
import { initBackButton } from './lib/back.js'
import { installEdgeSwipeBack, BACK_PREVIEW_EVENT } from './lib/edge-swipe-back.js'
import { startWatchSync, bindWatchAppActions, patchSetIn } from './lib/watch-sync.js'
import { stampWorkout } from './lib/sync-merge.js'
import { logWeighIn } from './lib/bodyweight.js'
import { startWidgetSync } from './lib/widgets.js'
import { startLiveActivitySync } from './lib/live-activity.js'
import { useWakeLock } from './lib/wakelock.js'
import { installViewportGuard } from './lib/viewport-guard.js'
import { installChipDrag } from './lib/hchips.js'
import { syncPushSubscription } from './lib/push.js'
import { MOBILE, nativePlatform } from './lib/mobile.js'
import { exitWorkoutEdit, startFlow, beginWorkout } from './sheets.jsx'
import Icon from './components/Icon.jsx'
import TabBar from './components/TabBar.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Modals from './components/Modals.jsx'
import Toast from './components/Toast.jsx'
import SyncBanner from './components/SyncBanner.jsx'
import RestTimer from './components/RestTimer.jsx'
import TimerFlash from './components/TimerFlash.jsx'
import { openDeviceLinkRedeem, AddPasskeySheet } from './components/Passkeys.jsx'
import { needsEmailPromptDue, openNeedsEmailPrompt } from './components/AccountEmail.jsx'
import { openTermsSheet } from './components/TermsSheet.jsx'
import { useOnline } from './components/ServerSync.jsx'
import Login from './views/Login.jsx'
import EmailVerify from './views/EmailVerify.jsx'
import Legal from './views/Legal.jsx'
import RecoverAccess from './views/RecoverAccess.jsx'
import MobileOnboarding from './views/MobileOnboarding.jsx'
import PermissionSteps from './views/PermissionSteps.jsx'
import Home from './views/Home.jsx'
import CheckIn from './views/CheckIn.jsx'
import Plan from './views/Plan.jsx'
import RoutineEdit from './views/RoutineEdit.jsx'
import Workout from './views/Workout.jsx'
import Stats from './views/Stats.jsx'
import History from './views/History.jsx'
import Library from './views/Library.jsx'
import Muscles from './views/Muscles.jsx'
import StructuralBalance from './views/StructuralBalance.jsx'
import ProgressPhotos from './views/ProgressPhotos.jsx'
import { SettingsRoute } from './views/Settings.jsx'
import SettingsPlan from './views/SettingsPlan.jsx'
import Admin from './views/Admin.jsx'
import CoachChat from './views/CoachChat.jsx'
import Measurements from './views/Measurements.jsx'
import CoachIntake from './views/CoachIntake.jsx'
import CoachSetup from './views/CoachSetup.jsx'
import Students from './views/Students.jsx'
import StudentDetail from './views/StudentDetail.jsx'
import TeacherLibrary from './views/TeacherLibrary.jsx'
import TeacherInviteAccept from './views/TeacherInviteAccept.jsx'

// last known scrollY per route, so back-navigation can put the page where it was
const scrollPositions = new Map()

bindUI(useUI)   // lets the shared controls open sheets without importing the store at module scope

// theme === 'system' follows the OS/browser preference instead of a fixed choice.
const resolveTheme = theme => theme === 'light' || theme === 'dark'
  ? theme
  : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

// The accent is the Brilhart brand's and fixed in index.css; S.accent is only still read by the
// Android rest notification (lib/rest-alert.js). The bar colour follows the brand guide: ameixa
// on the light theme, the dark theme's plum on dark. Keep in sync with the script in index.html.
function applyPrefs(theme, accent) {
  const de = document.documentElement
  de.dataset.theme = resolveTheme(theme)
  applyAccent(de, accent, de.dataset.theme)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = de.dataset.theme === 'light' ? '#4A284D' : '#1C141E'
  if (MOBILE) setSystemBarsLight(de.dataset.theme === 'light')
}

function Shell() {
  const navigate = useNavigate()
  const loc = useLocation()
  const navType = useNavigationType()
  const { S, user, ready } = useStore()
  // iOS: whether timer sounds get past the ring/silent switch (Settings → Sounds). Page-level,
  // so it is applied here on load and on change rather than at each beep.
  useEffect(() => { setPlayOnSilent(!!S.soundOnSilent) }, [S.soundOnSilent])
  // Settings → Vibrate, the same way: one page-level switch rather than a check at each buzz.
  useEffect(() => { setVibrate(S.vibrate !== false) }, [S.vibrate])
  // Android app: "Vibrate when the phone is on silent" sends the end-of-rest buzz through the
  // native side as an alarm (#375). buzzAsAlarm answers false off Android, so iOS buzzes as before.
  useEffect(() => { setAlarmBuzzer(MOBILE && S.vibrate !== false && S.vibrateOnSilent ? buzzAsAlarm : null) }, [S.vibrate, S.vibrateOnSilent])
  // iPhone app: the page cannot buzz (no navigator.vibrate), its native side can.
  useEffect(() => { if (MOBILE) nativePlatform().then(p => { if (p === 'ios') setNativeBuzzer(buzzAsAlarm) }) }, [])
  const isGuest = useStore(s => s.isGuest())
  const needsMobileOnboarding = useStore(s => s.needsMobileOnboarding)
  const permSteps = useStore(s => s.permSteps)
  const langV = useLang()   // re-renders the whole shell when the language (pack) changes
  useEffect(() => { setNav(navigate) }, [navigate])
  const lastEditPath = useRef(loc.pathname)
  // Any in-app route exit, browser back included, returns to the persisted draft and asks for a
  // save decision. Reload needs no prompt because the draft itself is already in local storage.
  useEffect(() => {
    const previous = lastEditPath.current
    lastEditPath.current = loc.pathname
    // The live store, not this render's S: a save that just closed the editor may not have
    // reached this render yet, and asking again would offer to delete the workout it saved.
    if (previous !== '/workout' || !useStore.getState().S.active?.editingWorkoutId || loc.pathname === '/workout') return
    const destination = loc.pathname + loc.search
    navigate('/workout', { replace: true })
    exitWorkoutEdit(() => navigate(destination, { replace: true }))
  }, [loc.pathname, loc.search, S.active?.editingWorkoutId, navigate])
  // A preset key, or the user's own colour as '#rrggbb' (lib/accent.js), already checked.
  const accent = accentValue(S)
  useEffect(() => { applyPrefs(S.theme, accent) }, [S.theme, accent])
  // 'system' needs to react live if the OS theme flips while the app is open, not just on
  // the next mount — a fixed 'dark'/'light' choice never re-fires this since matchMedia
  // isn't consulted for those.
  useEffect(() => {
    if (S.theme !== 'system' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyPrefs(S.theme, accent)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [S.theme, accent])
  // A profile that never picked a language follows the instance default or the browser (#303) —
  // worked out here, on this device, and never written into the synced state (lib/default-lang.js).
  const config = useStore(s => s.config)
  const lang = effectiveLang(S, config)
  useEffect(() => { setLang(lang, S.enParens?.[baseLang(lang)] ?? true, S.enOnly?.[baseLang(lang)] === true) }, [lang, S.enParens, S.enOnly])
  // Same shape as the language: a module-level display setting, pushed when it changes (#139).
  useEffect(() => { setWeightDecimals(S.wdec) }, [S.wdec])
  useEffect(() => { document.documentElement.lang = lang }, [langV, lang])
  // Forward navigation starts at the top; going back lands where you left off.
  // The position is recorded from scroll events rather than read at route
  // change, because by then a shorter page may already have clamped it.
  const pathRef = useRef(null)
  // iOS leaves the page displaced after the keyboard goes away (see lib/viewport-guard.js).
  useEffect(() => installViewportGuard(), [])
  // Click-drag a horizontal chip strip to scroll it sideways (lib/hchips.js) — on a desktop
  // browser there's otherwise no way to reach the filters past the edge.
  useEffect(() => installChipDrag(), [])
  // Once per signed-in boot, hand the server this browser's push subscription again (see
  // lib/push.js): a subscription the instance lost is back before the next reminder is due,
  // with nobody having to visit Settings. Web only — the APK has no service worker.
  useEffect(() => {
    if (MOBILE || !user || !ready) return
    syncPushSubscription().catch(() => {})
  }, [user?.id, ready])
  // An account behind on the Terms of Use / Privacy Policy (ISO-1390) gets the locked "we updated
  // our terms" sheet — signed in only (a guest or the demo has no account to record it on), and
  // only online: accepting is a server call, and offline use of the app is never blocked, so the
  // sheet waits for the network and opens the moment it comes back. Once per account per visit;
  // still unaccepted, the next load (boot's fresh /api/me) asks again. The sheets below wait
  // behind it rather than stacking over a locked one. And only on this visit's own /api/me answer
  // (`termsChecked`): the user kept in storage carries the `needsTerms` of an earlier visit, and a
  // boot whose /api/me failed (a 5xx, a proxy, a network that is "online" but reaches nothing)
  // would otherwise lock the app behind an Accept that can only fail.
  const termsChecked = useStore(s => s.termsChecked)
  const needsTerms = !!user?.needsTerms && !isGuest && termsChecked
  const online = useOnline()
  const termsOffered = useRef(null)
  useEffect(() => {
    if (!ready || !needsTerms || !online || termsOffered.current === user.id) return
    termsOffered.current = user.id
    openTermsSheet()
  }, [ready, needsTerms, online, user?.id])
  // Opened from a device-link QR code (#95): once boot knows who is here, the sheet that redeems
  // it opens by itself — over the sign-in screen, or over the app for a guest or a signed-in
  // browser. Once per visit; closed, the code stays for the sign-in screen's own button.
  const linkCode = useStore(s => s.linkCode)
  const linkOffered = useRef(false)
  useEffect(() => {
    if (!ready || !linkCode || linkOffered.current) return
    if (needsTerms) return   // behind the terms sheet (ISO-1390), its turn not spent
    linkOffered.current = true
    openDeviceLinkRedeem()
  }, [ready, linkCode, needsTerms])
  // Account from before ISO-1397 that still has no e-mail (ISO-1398): once per sign-in, at most
  // once every 7 days while it stays unset (needsEmailPromptDue, its own local deferral) — never
  // blocks the app either way. Held off on /recuperar and /verificar-email (their own sheets own
  // the screen) and while a device-link redeem is pending (ISO-1415, stacked-sheets follow-up to
  // ISO-1398) or the terms sheet is owed (ISO-1390) — not consumed in those cases, so it still
  // fires once the route, the pending code or the terms clear, rather than being skipped for the
  // rest of the visit.
  const needsEmailOffered = useRef(false)
  const emailSheetRoute = loc.pathname === '/recuperar' || loc.pathname === '/verificar-email' || loc.pathname === '/termos' || loc.pathname === '/privacidade'
  useEffect(() => {
    if (!ready || !user?.needsEmail || needsEmailOffered.current || !needsEmailPromptDue()) return
    if (emailSheetRoute || linkCode || needsTerms) return
    needsEmailOffered.current = true
    openNeedsEmailPrompt()
  }, [ready, user?.id, user?.needsEmail, emailSheetRoute, linkCode, needsTerms])
  // Google's own redirect back, for the signed-in half (ISO-1595 §4.5, ISO-1597/ISO-1598):
  // always a full-page navigation, landing on #/configuracoes (api/billing.js's own fixed
  // route for this case too — not Settings.jsx itself, which is where the result actually
  // belongs) with the result in the `google` query param. The signed-out half (login/signup,
  // landing on #/entrar) is Login.jsx's own job — it reads the same query itself, since it
  // needs the full screen for several of the results (ISO-1595 §4.1/§4.3), not just a toast.
  // `reauth-ok` resumes whatever ProveOwner's "Confirm with Google" was for (lib/google-reauth.js)
  // — the one request that action needed all along, now that the proof exists; every other
  // result here is already final and just needs a word about it.
  const googleCB = parseGoogleCallback(loc.search)
  const [googleBusy, setGoogleBusy] = useState(() => !!googleCB && !!(user || isGuest))
  useEffect(() => {
    if (!googleCB || !(user || isGuest)) return
    let cancelled = false
    let wentHome = false
    const pending = takePendingReauth()
    ;(async () => {
      try {
        if (googleCB.google === 'reauth-ok' && pending && googleCB.proof) {
          if (pending.kind === 'delete-account') {
            await useStore.getState().deleteAccount({ googleProof: googleCB.proof })
            if (cancelled) return
            wentHome = true
            navigate('/home', { replace: true })
            useUI.getState().toast(t('Account deleted'))
            return
          }
          if (pending.kind === 'add-passkey') {
            const ready2 = await resumeGoogleReauth(pending, googleCB.proof)
            if (cancelled) return
            useUI.getState().openSheet(close => <AddPasskeySheet state={{ passkeys: [], password: false }} initialReady={ready2} close={close} done={() => {}} />)
          } else {
            await resumeGoogleReauth(pending, googleCB.proof)
            if (cancelled) return
            const doneToast = {
              'remove-password': t('Password removed'),
              'unlink-google': t('Google unlinked.'),
              'set-password': t('Password saved — you are signed out everywhere else.'),
              'set-email': t('E-mail saved'),
            }[pending.kind]
            useUI.getState().toast(doneToast || t('Done'))
          }
        } else if (googleCB.google === 'linked') useUI.getState().toast(t('Google linked.'))
        else if (googleCB.google === 'already-linked') useUI.getState().toast(t('This Google account is already linked to a different profile.'))
        else if (googleCB.google === 'reauth-mismatch') useUI.getState().toast(t('That Google account doesn’t match the one linked to this profile.'))
        else if (googleCB.google === 'cancelled') { /* silent, ISO-1595 §4.6 — a real decline is not an error */ }
        else if (googleCB.google !== 'ok') useUI.getState().toast(t("We couldn't link your Google account. Try again."))
      } catch (e) {
        if (!cancelled) useUI.getState().toast(passwordError(e))
      } finally {
        if (!cancelled) {
          setGoogleBusy(false)
          if (!wentHome) navigate('/settings', { replace: true })
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.search])
  useEffect(() => {
    const onScroll = () => {
      // Modals pins the body while a sheet is open; scrollY is 0 then, not a position.
      if (document.body.style.position === 'fixed') return
      scrollPositions.set(pathRef.current, window.scrollY)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  // The edge swipe back (lib/edge-swipe-back.js) asks for the page it goes back to underneath
  // while the finger moves (`preview`), and says where it is going as it lets go (`returning`):
  // that page comes back where it was scrolled to, as the back button's push would not.
  const [preview, setPreview] = useState(null)
  const returning = useRef(null)
  useEffect(() => {
    const on = e => {
      const d = e.detail || {}
      if ('commit' in d) returning.current = d.commit
      else setPreview(d.path || null)
    }
    window.addEventListener(BACK_PREVIEW_EVENT, on)
    return () => window.removeEventListener(BACK_PREVIEW_EVENT, on)
  }, [])
  // Any navigation ends a preview: promoted (it is the page now) or not needed any more.
  useEffect(() => { setPreview(null) }, [loc.pathname])
  useLayoutEffect(() => {
    const first = pathRef.current === null
    const samePath = pathRef.current === loc.pathname
    pathRef.current = loc.pathname
    notePath(loc.pathname, loc.key)
    if (returning.current && returning.current === loc.pathname && !first) {
      returning.current = null
      const y = scrollPositions.get(loc.pathname) || 0
      // Promoted from the preview it is laid out already: back at y in this same frame. A page
      // mounted fresh (no preview) needs its layout pass first, as a POP does.
      if (document.querySelector('#app > .page[data-promoted]')) { window.scrollTo(0, y); return }
      const frame = window.requestAnimationFrame(() => window.scrollTo(0, y))
      return () => window.cancelAnimationFrame(frame)
    }
    returning.current = null
    // A fresh load arrives as a POP with nothing remembered. It goes to the top like any new
    // route — now, not a frame later: that frame landed on top of a scroll a view made on mount
    // (the superset card centring its row, views/Workout.jsx), and a smooth scroll cut off by a
    // scrollTo is simply gone.
    if (navType !== 'POP' || first) { window.scrollTo(0, 0); return }
    // A POP that stays on the route we are on is not a back-navigation: it is the history
    // entry a sheet pushed (Modals.jsx, #63) being unwound as the sheet closes. Nothing new
    // mounted, Modals puts the page back where it was itself, and a view that scrolled on
    // purpose because the sheet closed — the workout list going to the current exercise after
    // ⋯ → Layout → List (#224) — must not be dragged back to a position recorded before that
    // scroll's event had even been dispatched.
    if (samePath) return
    const y = scrollPositions.get(loc.pathname) || 0
    // the restored view needs a layout pass before it is tall enough to scroll to y
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, y))
    return () => window.cancelAnimationFrame(frame)
  }, [loc.pathname, navType])
  // bound to the workout, not to the route — checking Stats mid-session keeps the screen on
  useWakeLock(!!S.active && !S.active.editingWorkoutId && S.keepAwake !== false)
  // A running workout has the whole screen (v1.3.11): no tab bar, and the rest bar docks to the
  // bottom edge in its place. Its header's ⌄ goes back to the app, where the tab bar's Resume
  // brings it back. Finishing stays in the workout's own header and list, not in a bottom button
  // (owner, 2026-10-14: the bottom Complete / Finish button of #563 is gone again).
  const inWorkout = loc.pathname === '/workout' && !!S.active
  useEffect(() => {
    document.body.classList.toggle('no-tabbar', inWorkout)
    return () => document.body.classList.remove('no-tabbar')
  }, [inWorkout])
  // The chat owns the bottom of the screen as well: its composer sits where the tabs would be.
  // The first-launch card has no tabs either: they changed the route behind it.
  const noTabs = inWorkout || loc.pathname === '/coach' || needsMobileOnboarding || permSteps

  const authed = user || isGuest
  // The boot screen in index.html covers the start; it goes once there is something to show.
  // Ahead of every early return below: a hook that runs on some renders only is a hook-count
  // mismatch the moment the condition flips (the Google callback screen, say).
  useEffect(() => { if (ready || authed) hideBoot() }, [ready, authed])

  // Reachable whether signed in or out, and ahead of the Login/Routes split below: the person
  // opening a mailed link has usually lost any session on this device, but may also click it on
  // the same browser that is already signed in (EmailVerify.jsx, RecoverAccess.jsx — ISO-1398).
  // Modals/Toast come along: RecoverAccess finishes through the same device-link redeem sheet
  // App.jsx's own `linkCode` effect opens below (it needs somewhere to render into), and its
  // "Passkey added" toast lands the same way a device-link QR redeem's does.
  if (loc.pathname === '/verificar-email') return <><div id="app" className="vfade"><EmailVerify /></div><Modals /><Toast /></>
  // Terms and privacy text: public, same reasoning (views/Legal.jsx, ISO-1390).
  if (loc.pathname === '/termos') return <><div id="app" className="vfade"><Legal id="termos" /></div><Modals /><Toast /></>
  if (loc.pathname === '/privacidade') return <><div id="app" className="vfade"><Legal id="privacidade" /></div><Modals /><Toast /></>
  if (loc.pathname === '/recuperar') return <><div id="app" className="vfade"><RecoverAccess /></div><Modals /><Toast /></>
  // The invite-accept screen (ISO-1594/ISO-1610) owns its own signed-out state (a short prompt,
  // then the ordinary Login in place) rather than falling through to the generic `!authed`
  // branch below, which would show Login with no mention of the invite at all. Checked ahead of
  // googleBusy below: the Google redirect always lands on #/configuracoes (never on this path),
  // but keeping the specific route first means that stays true even if that ever changes.
  if (loc.pathname.startsWith('/professor/convite/')) return <><div id="app" className="vfade"><TeacherInviteAccept /></div><Modals /><Toast /></>
  // Processing a signed-in Google result (above): avoids a one-frame flash of whatever
  // #/configuracoes would otherwise render (SettingsPlan, api/billing.js's own route) before the
  // effect above lands on Settings itself.
  if (googleBusy) return (
    <div id="app">
      <div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', fontSize: 34, color: 'var(--label-3)' }}>
        <Icon name="dumbbell" />
      </div>
    </div>
  )

  if (!ready && !authed) return (
    <div id="app">
      <div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', fontSize: 34, color: 'var(--label-3)' }}>
        <Icon name="dumbbell" />
      </div>
    </div>
  )

  const view = l => (!authed ? <Login /> : needsMobileOnboarding ? <MobileOnboarding /> : permSteps ? <PermissionSteps /> : (
    <Routes location={l}>
      <Route path="/home" element={<Home />} />
      {/* Gym check-in — switched off in Settings, the route falls through to the
          catch-all redirect below. */}
      {S.checkIn !== false && <Route path="/checkin" element={<CheckIn />} />}
      <Route path="/plan" element={<Plan />} />
      <Route path="/plan/r/:id" element={<RoutineEdit />} />
      <Route path="/workout" element={<Workout />} />
      <Route path="/stats" element={<Stats />} />
      <Route path="/history" element={<History />} />
      <Route path="/library" element={<Library />} />
      <Route path="/muscles" element={<Muscles />} />
      <Route path="/structural-balance" element={<StructuralBalance />} />
      <Route path="/progress-photos" element={<ProgressPhotos />} />
      <Route path="/measurements" element={<Measurements />} />
      <Route path="/settings" element={<SettingsRoute />} />
      <Route path="/settings/:page" element={<SettingsRoute />} />
      {/* ISO-1395: api/billing.js's Checkout/Portal success_url and cancel_url are fixed,
          Sentinel-approved strings pointing at '/configuracoes' with no sub-path — this
          route has to be exactly that, not the issue's own illustrative '/settings/plan'. */}
      <Route path="/configuracoes" element={<SettingsPlan />} />
      {/* The Coach screens gate themselves on the instance config; the routes exist
          unconditionally so a deep link from a notification lands somewhere sane
          rather than on the catch-all. */}
      <Route path="/coach" element={<CoachChat />} />
      <Route path="/coach/intake" element={<CoachIntake />} />
      <Route path="/coach/proposal" element={<Navigate to="/coach" replace />} />
      <Route path="/coach/setup" element={<CoachSetup />} />
      {/* Teacher-only (ISO-1594/ISO-1610) — same gated-redirect pattern as /admin below.
          A teacher is also always a student of their own account (D11); only the role
          check gates this, never anything about the account's own training data. */}
      <Route path="/alunos" element={user?.role === 'teacher' ? <Students /> : <Navigate to="/home" replace />} />
      <Route path="/alunos/biblioteca" element={user?.role === 'teacher' ? <TeacherLibrary /> : <Navigate to="/home" replace />} />
      <Route path="/alunos/:id" element={user?.role === 'teacher' ? <StudentDetail /> : <Navigate to="/home" replace />} />
      <Route path="/admin" element={user?.admin ? <Admin /> : <Navigate to="/home" replace />} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  ))
  const showPreview = !!preview && preview !== loc.pathname && authed && !needsMobileOnboarding && !permSteps

  return (
    <>
      {/* One page per route, keyed on it: a view that throws is contained, and switching tabs
          re-mounts the boundary, so the tab bar is always a way out. While an edge swipe back
          is under way the page it goes back to sits underneath (Page `under`), and as the swipe
          lands it simply stays: same key, same parent, so React keeps it instead of mounting
          the route again. */}
      <div id="app">
        <Page key={loc.pathname} loc={loc} render={view} />
        {showPreview && <Page key={preview} loc={previewLoc(preview)} render={view} under scrollY={scrollPositions.get(preview) || 0} />}
      </div>
      {/* Outside #app: the view's fade-in animates a transform, and a fixed element inside it
          would ride along with the page for the length of it. Decides for itself when to show —
          including on the sign-in screen, when the server has just ended the session. */}
      <SyncBanner />
      {!noTabs && <TabBar onStart={startFlow} />}
      <RestTimer />
      <Modals />
      <Toast />
      <TimerFlash />
    </>
  )
}

// The location the page underneath renders with: the entry it will be, when history knows it.
const previewLoc = pathname => ({ pathname, search: '', hash: '', state: null, key: keyBefore(pathname) || 'back-preview' })

/* One route's page. `under`: the page an edge swipe back is about to return to, drawn beneath
   the current one (index.css .page.under): fixed, at the scroll position it was left at, inert
   and hidden from assistive tech, so nothing in it can be tapped, focused or read out while it
   only shows. When the swipe lands it becomes the page in place (same element, same state, no
   second mount, no fade): the styles the gesture painted on it go, and App puts the window back
   at that scroll position in the same frame. */
function Page({ loc, render, under = false, scrollY = 0 }) {
  const ref = useRef(null)
  const wasUnder = useRef(under)
  const promoted = wasUnder.current && !under
  useLayoutEffect(() => {
    if (under || !wasUnder.current) return
    const el = ref.current
    if (el) { el.style.transform = ''; el.style.transition = ''; el.style.visibility = '' }
  }, [under])
  return <div ref={ref} className={'page' + (under ? ' under' : wasUnder.current ? '' : ' vfade')}
    data-path={loc.pathname} data-promoted={promoted ? '' : undefined}
    aria-hidden={under || undefined} inert={under || undefined}>
    <div className="page-in" style={under && scrollY ? { transform: `translateY(${-scrollY}px)` } : undefined}>
      <ErrorBoundary>{render(loc)}</ErrorBoundary>
    </div>
  </div>
}

export default function App() {
  const boot = useStore(s => s.boot)
  useEffect(() => { boot() }, [boot])
  // Android system back — sheet, then page, then press-again-to-exit (see lib/back.js)
  useEffect(() => {
    let stop = null, gone = false
    initBackButton().then(fn => { if (gone) fn(); else stop = fn })
    return () => { gone = true; stop?.() }
  }, [])
  // iOS: swipe from the left edge for the page's own back button (lib/edge-swipe-back.js)
  useEffect(() => installEdgeSwipeBack(), [])
  // iPhone app with an Apple Watch: the running workout goes to the watch, its ticks come back
  // (lib/watch-sync.js). Nothing at all on the web, on Android, or without a paired watch.
  useEffect(() => {
    if (!MOBILE) return
    let stop = null, gone = false
    startWatchSync({ useStore, useUI }).then(fn => { if (gone) fn(); else stop = fn })
    // A session started on the watch starts here as the phone's Start does, with the watch's id
    // and start time, and no weigh-in question (the lifter is at the watch, not here).
    const unbind = bindWatchAppActions({
      start: (ids, { bw = null, ...opts } = {}) => beginWorkout(ids, bw, opts),
      // The watch's weigh-in: logged as the phone's check-in logs one (today's replaces today's).
      weighIn: ({ w, at }) => useStore.getState().update(s => { logWeighIn(s, w, at) }),
      // The watch removed its copies of deleted workouts from Apple Health: the phone's removal
      // runs again, finds them gone and stops retrying them.
      healthDeleted: () => { import('./lib/health-sync.js').then(m => m.syncHealth(useStore.getState().S)).catch(() => {}) },
      patchSet: (where, fields, opts = {}) => useStore.getState().update(s => {
        patchSetIn(s, where, fields, stampWorkout, { ...opts, recount: w => { w.vol = workoutVolume(w) } })
      }),
      // Ticks from the watch are the workout screen's to apply: it opens, and drains the queue.
      openWorkout: () => { if (!String(window.location.hash || '').startsWith('#/workout')) navToWorkout() },
    })
    return () => { gone = true; stop?.(); unbind() }
  }, [])
  // iPhone app: the Home Screen widgets and the workout's Live Activity (lib/widgets.js,
  // lib/live-activity.js). Nothing at all on the web or on Android.
  useEffect(() => {
    if (!MOBILE) return
    const stops = [], gone = { v: false }
    const keep = fn => { if (gone.v) fn(); else stops.push(fn) }
    startWidgetSync({ useStore }).then(keep).catch(() => {})
    startLiveActivitySync({ useStore, useUI }).then(keep).catch(() => {})
    return () => { gone.v = true; stops.forEach(fn => fn()) }
  }, [])
  return <HashRouter><Shell /></HashRouter>
}
