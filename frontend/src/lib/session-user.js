// GET /api/me → the store's `user`, in one place for every path that asks (boot on the web and on
// the phone, passkey and password sign-in). Before ISO-1390 this was copied inline three times;
// the terms fields would have had to be added to each copy, and a copy that missed them would
// let that sign-in path skip the "we updated our terms" sheet until the next reload.
//
// `base` is the user the caller already holds (a sign-in answers {id,name,admin} itself), and
// defaults to the one inside `me`. The e-mail fields ride along only while the server sends them
// (ISO-1397, always since ISO-1596 — `'needsEmail' in me` tells an older server apart without
// guessing from a falsy value it never sent). `google` (ISO-1597) rides the same way: `null` for
// a profile with no linked identity, an object once one exists, and simply absent on a server from
// before that migration. The terms fields are always set: an older server that sends none simply
// never asks for acceptance.
export function userFromMe(me, base = me.user) {
  return {
    ...base,
    ...('needsEmail' in me ? { email: me.email, emailVerified: !!me.emailVerified, needsEmail: !!me.needsEmail } : {}),
    ...('google' in me ? { google: me.google } : {}),
    termsVersion: me.termsVersion ?? null,
    termsAcceptedAt: me.termsAcceptedAt ?? null,
    needsTerms: !!me.needsTerms,
  }
}
