// Rendering for the admin activity log (GET /api/admin/audit).
//
// The server stores reason codes, not sentences — `{ ev: 'auth.login.fail', msg: 'unknown-credential' }`
// rather than "someone tried a passkey we don't know". Turning those into English
// belongs here and not in Admin.jsx: it is the only part of the feature that can be wrong in a way
// a person sees, and as a plain module it is testable without mounting the dashboard.
//
// Like the rest of the admin screen this is English-only — the operator surface deliberately
// stays out of the per-language string packs (see the header of views/Admin.jsx). Times still
// follow the UI language, the way numbers and dates already do.
import { dateLocale } from './i18n-core.js'

// The first segment of an event name is also the filter chip it belongs to.
export const auditCat = ev => String(ev || '').split('.')[0]

const LABELS = {
  'auth.login.ok': 'Signed in',
  'auth.login.fail': 'Sign-in failed',
  'auth.register.ok': 'Created a profile',
  'auth.register.fail': 'Profile creation failed',
  'auth.register.denied': 'Signup refused',
  'auth.logout': 'Signed out',
  'auth.logout.all': 'Signed out everywhere',
  // Settings → "Delete my account": the profile removed itself and everything of theirs.
  'auth.account.delete': 'Deleted their own account',
  // Device pairing (Settings → "Pair the mobile app"): the code is minted in a signed-in browser
  // tab and redeemed by the app, so "ok" is the phone coming online, not a sign-in.
  'auth.pair.create': 'Created a pairing code',
  'auth.pair.ok': 'Paired a phone',
  'auth.pair.fail': 'Pairing failed',
  // Password sign-in (#118), where the instance offers it.
  'auth.password.ok': 'Signed in with a password',
  'auth.password.fail': 'Password sign-in failed',
  'auth.password.locked': 'Password sign-in paused after repeated failures',
  'auth.password.set': 'Set a password',
  'auth.password.change': 'Changed their password',
  'auth.password.remove': 'Removed their password',
  'auth.password.reset': 'Used a reset code',
  // The account's one verified e-mail (ISO-1397), also usable as a second sign-in identifier
  // next to the profile name on a PASSWORD_LOGIN instance (ISO-1596 unified what used to be two
  // separate addresses here — see api/server.js's own "e-mail sign-in" comment). `msg` on set/
  // change is the proof it was set with and the address masked to two characters
  // ("password · a…@e…") — never the address itself.
  'auth.email.set': 'Added their e-mail',
  'auth.email.change': 'Changed their e-mail',
  'auth.email.fail': 'Changing their e-mail failed',
  'auth.email.verify.ok': 'Confirmed their e-mail',
  'auth.email.verify.fail': 'Confirming an e-mail failed',
  'auth.email.resend': 'Resent the confirmation e-mail',
  'auth.recover.request': 'Asked to recover access',
  'auth.recover.ok': 'Recovered access',
  'auth.recover.fail': 'Recovering access failed',
  // ISO-1596: the recovery link redeemed with a new password instead of pairing a device.
  'auth.recover.password': 'Reset their password with a recovery link',
  // More than one passkey, and one-time codes for another device (#95). `msg` on an addition or a
  // code is the proof it was made with (passkey, password); on a removal or a redemption, the
  // passkey's name.
  'auth.passkey.add': 'Added a passkey',
  'auth.passkey.fail': 'Adding a passkey failed',
  'auth.passkey.remove': 'Removed a passkey',
  'auth.link.create': 'Made a one-time code for another device',
  'auth.link.ok': 'Added a device with a one-time code',
  'auth.link.fail': 'Adding a device with a code failed',
  // The owner's proof (current password or a passkey) for one of the changes below was refused.
  'auth.proof.fail': 'Confirming a change failed',
  // ISO-1480: the browser refused a passkey ceremony outright — a certificate the device does
  // not trust, no screen lock, a non-secure origin — before any prompt could have been shown or
  // dismissed. `msg` carries the classifier's own enum, the flow/step and the timing
  // (lib/webauthn-error.js, POST /api/client-event); never a credential id or free text.
  'auth.webauthn.fail': 'A passkey prompt was refused by the device, not the person',
  // The password throttle paused an address; `msg` says for what (password, signup).
  'auth.throttled': 'Too many failed attempts from one address',
  'admin.user.disable': 'Disabled an account',
  'admin.user.enable': 'Re-enabled an account',
  'admin.user.delete': 'Deleted an account',
  // Self-service account deletion (ISO-1394 Phase 4, LGPD): its own event rather than
  // `admin.*`, since no admin acted — `msg` carries nothing beyond the uid proveOwner already
  // names in `act`, by design (no personal data in this one's audit row).
  'account.delete': 'Deleted their own account',
  'account.terms.accept': 'Accepted the Terms of Use and Privacy Policy',
  'admin.password.reset': 'Issued a password reset code',
  'admin.role.grant': 'Made someone an admin',
  'admin.role.revoke': 'Removed someone as admin',
  'admin.owner.transfer': 'Handed the owner role on',
  'admin.invite.create': 'Created an invite code',
  'admin.invite.revoke': 'Revoked an invite code',
  'admin.audit.clear': 'Cleared the activity log',
  // FIRST_USER_ADMIN=1: the first profile on a fresh instance is made admin as it signs up.
  'admin.first-user': 'Became admin as the first profile',
  'admin.denied': 'Blocked from an admin action',
  // ISO-1485: the training program catalog. `msg`/`target` name the program; `publish`/
  // `unpublish` are their own events (not folded into `update`) since they're the one change
  // that affects whether it's visible to anyone outside the admin dashboard.
  'admin.program.create': 'Created a training program',
  'admin.program.update': 'Edited a training program',
  'admin.program.publish': 'Published a training program',
  'admin.program.unpublish': 'Unpublished a training program',
  'admin.program.trash': 'Moved a training program to the trash',
  'admin.program.restore': 'Restored a training program from the trash',
  'admin.program.purge': 'Permanently deleted a training program',
  'admin.program.cover.set': "Set a training program's cover image",
  'admin.program.cover.remove': "Removed a training program's cover image",
  // The retention sweep, not an admin — no `uid` on this one (see server.js's audit() call).
  'program.purge.auto': 'A training program past its retention was deleted automatically',
  // Photos and videos of custom exercises: "Reset everything" clearing a profile's files, and the
  // upload or clean-up throttle pausing a profile (`msg` says which).
  'media.sweep': 'Cleared unused photos and videos',
  'media.throttled': 'Too many photo or video requests',
  // Stripe billing (ISO-1393): `msg` carries the plan name. No chip of its own, same as media —
  // these rows show under All.
  'billing.checkout': 'Started a Stripe checkout',
  // ISO-1619/ISO-1630: the admin payment-plan catalog. `activate`/`unpublish` are their own
  // events (not folded into a generic "update"), same precedent as admin.program.publish/
  // unpublish above — availability is the one change that affects whether a plan can be sold.
  'admin.billing.catalog.create': 'Created a new payment plan',
  'admin.billing.catalog.display': "Edited a payment plan's display text",
  'admin.billing.catalog.activate': 'Put a payment plan on sale',
  'admin.billing.catalog.deactivate': 'Took a payment plan off sale',
  'admin.billing.catalog.price.new': 'Created a new price for a payment plan',
  'admin.billing.catalog.price.publish': "Published a payment plan's new price",
  'admin.billing.catalog.order': 'Reordered the payment plan catalog',
  'admin.billing.catalog.reconcile': 'Reconciled the payment plan catalog against Stripe',
  // ISO-1619/ISO-1624 T2a, ISO-1625 T2b: one account's billing ficha and its actions — never
  // folded into a generic "update", same precedent as the catalog events just above.
  'admin.billing.subscription.change-plan': "Changed an account's plan",
  'admin.billing.subscription.cancel-period-end': "Scheduled an account's subscription to cancel",
  'admin.billing.subscription.resume': "Undid a scheduled cancellation on an account's subscription",
  'admin.billing.subscription.cancel-immediately': "Cancelled an account's subscription immediately",
  'admin.billing.subscription.suspend-collection': "Suspended an account's billing",
  'admin.billing.subscription.resume-collection': "Resumed an account's billing",
  'admin.billing.subscription.generate-link': 'Generated a subscription link for an account',
  'admin.billing.subscription.sync': "Synced an account's subscription with Stripe",
  // "Sign in with Google" (ISO-1597). `ok`'s `msg` carries the proof kind ('reauth') or, for a
  // pending signup with no account yet, a masked address; `refused`/`fail` carry a reason code.
  'auth.google.start': 'Started linking a Google account',
  'auth.google.ok': 'Signed in with Google',
  'auth.google.link': 'Linked a Google account',
  'auth.google.signup': 'Created a profile with Google',
  'auth.google.refused': 'Signing in with Google was refused',
  'auth.google.fail': 'Signing in with Google failed',
  'auth.google.unlink': 'Unlinked a Google account',
  // Teacher/student roles, the link between them and workout assignments (ISO-1594/ISO-1609).
  // `teacher.student.view` is logged every time, not just on refusal — it is access to another
  // person's training data, same reasoning as any other personal-data read worth a trail.
  'teacher.role.grant': 'Made a profile a teacher',
  'teacher.role.revoke': 'Took away a profile’s teacher role',
  'teacher.invite.create': 'Created a class invite code',
  'teacher.invite.revoke': 'Revoked a class invite code',
  'teacher.link.accept': 'Linked to a teacher',
  'teacher.link.end': 'Ended a teacher/student link',
  'teacher.link.bodyweight': 'Changed whether body weight is shared with their teacher',
  'teacher.assign': 'Assigned a routine or program',
  'teacher.assign.end': 'Ended an assignment',
  'teacher.student.view': 'Viewed a student’s training data',
  'teacher.note.create': 'Added a note about a student',
  'teacher.note.update': 'Edited a note about a student',
  'teacher.note.delete': 'Deleted a note about a student',
  'teacher.denied': 'Blocked from the teacher dashboard'
}
// An unknown event is shown raw rather than dropped or rendered as "undefined": a dashboard
// that is one version behind the server should still say *something* truthful.
export const auditLabel = ev => LABELS[ev] || String(ev || 'Unknown event')

const REASONS = {
  'challenge-expired': 'the sign-in took too long and expired',
  'unknown-credential': 'unknown passkey',
  'verify-error': 'the passkey could not be verified',
  'not-verified': 'the passkey was rejected',
  'user-missing': 'the passkey points at a profile that no longer exists',
  'account-disabled': 'the account is disabled',
  'credential-exists': 'that passkey already belongs to a profile',
  'invite-invalid': 'the invite code was used or revoked in the meantime',
  'invite-rejected': 'wrong or already-used invite code',
  'code-invalid': 'wrong or expired pairing code',
  'user-unavailable': 'the profile behind the code is disabled or gone',
  'bad-password': 'wrong password',
  'bad-current': 'wrong current password',
  'unknown-name': 'no profile with a password has that name',
  'unknown-email': 'no profile with a password has that e-mail',
  'email-taken': 'another profile already uses that e-mail',
  'step-up-failed': 'the passkey confirming the change was rejected',
  'reset-invalid': 'wrong or expired reset code',
  'link-invalid': 'wrong, used or expired device code',
  'passkey-limit': 'the profile already has as many passkeys as it can hold',
  'token-invalid': 'wrong, used or expired link',
  // What an `auth.throttled` pause was for.
  'password': 'wrong passwords or reset codes',
  'signup': 'wrong invite codes on password signup',
  'link': 'wrong one-time device codes',
  'email': 'e-mail addresses already in use',
  // What a `media.throttled` pause was for.
  'upload': 'photo and video uploads',
  'sweep': 'clearing unused photos and videos',
  // "Sign in with Google" (ISO-1597).
  'disabled': 'the account is disabled',
  'cancelled': 'they cancelled on Google’s side',
  'already-linked': 'that Google account is already linked to a different profile',
  'email-unverified': 'the e-mail matches a profile that has not confirmed it yet',
  'reauth': 'confirmed with a fresh Google sign-in',
  'reauth-mismatch': 'confirmed with a different Google account than the one linked',
  'google-proof-invalid': 'the Google confirmation was missing, expired or already used',
  // teacher.link.end's reason, and teacher.denied's one uniform refusal (ISO-1609).
  'by-student': 'the student unlinked',
  'by-teacher': 'the teacher removed the student',
  'not-your-student': 'not this teacher’s student'
}
export const auditReason = msg => REASONS[msg] || (msg ? String(msg) : '')

// What an `auth.proof.fail` was confirming (the server's `act`).
const ACTS = {
  'email': 'changing their e-mail',
  'password': 'setting or changing the password',
  'password-remove': 'removing the password',
  'passkey-add': 'adding a passkey',
  'passkey-remove': 'removing a passkey',
  'device-link': 'making a one-time code for another device',
  'account-delete': 'deleting their account',
  'google-link': 'linking a Google account',
  'google-remove': 'unlinking Google'
}
export const auditAct = act => ACTS[act] || (act ? String(act) : '')

// → { title, sub }. `sub` is the house "a · b · c" metadata line used by every list row.
export function auditLine(e) {
  if (!e) return { title: '', sub: '' }
  const parts = []
  if (e.name) parts.push(e.name)
  else if (e.uid) parts.push(e.uid)
  else if (!e.ok) parts.push('unknown caller')
  if (e.tname) parts.push('→ ' + e.tname)
  if (e.act) parts.push(auditAct(e.act))
  // The reason codes and the invite codes share the msg field; only failures read as a reason.
  if (e.msg) parts.push(e.ok ? e.msg : auditReason(e.msg))
  if (e.ip) parts.push(e.ip)
  return { title: auditLabel(e.ev), sub: parts.join(' · ') }
}

// The activity log is the one place in the app that needs a clock, and fmtDate() renders none —
// it is used by every other view and is not worth changing for this.
export function fmtWhen(ts, now = Date.now()) {
  if (!ts) return ''
  const d = new Date(ts)
  const time = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  const n = new Date(now)
  const sameDay = d.toDateString() === n.toDateString()
  if (sameDay) return 'today ' + time
  if (now - ts < 6 * 86400000 && ts <= now) return d.toLocaleDateString(dateLocale(), { weekday: 'short' }) + ' ' + time
  return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) + ' ' + time
}
