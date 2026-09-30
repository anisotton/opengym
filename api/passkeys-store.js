/* More than one passkey on a profile (#95).
 *
 * A passkey lives where it was made — Windows Hello on one PC, one phone's keychain, one security
 * key — so a profile that only ever had the passkey it was created with could not be reached from
 * a second device, and "Create profile" there made a new, empty one.
 *
 * Just the pure shaping rules here — which fields a name/transports list may keep — kept out of
 * server.js so they can be tested without a WebAuthn ceremony. The rows themselves are
 * PostgreSQL's `passkeys` table now (store.js, ISO-1403), including the rule that matters most —
 * a profile never loses its last way in (`passkeyRemovalRefused`, store.js — `otherWays` is how
 * many ways besides its passkeys can still sign the profile in, a password on an instance with
 * password sign-in on; server.js decides that, store.js only counts). */

// Far above anyone's real use — a phone, a laptop, a security key or two.
export const MAX_PASSKEYS = 20;
export const NAME_MAX = 40;

// A label someone typed: control characters out, runs of whitespace folded, capped. Empty means
// no name, and the app shows a numbered "Passkey n" instead.
//
// Invisible format characters go too. The device redeeming a code names its own passkey, and the
// owner and the admin read that name: a right-to-left override (U+202E) turns the rest of it
// around, so a passkey could be made to read like another one. The two joiners stay, since emoji
// sequences and several scripts (Devanagari and Arabic among them) need them to render.
export const passkeyName = v => (typeof v === 'string' ? v : '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/(?![\u200c\u200d])\p{Cf}/gu, '')
  .replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// `transports` comes from the browser that made the passkey, which is to say from the request. It
// is handed back to browsers as a hint, so only a short list of short words is kept.
export const transportsOf = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 16).slice(0, 8) : []);
