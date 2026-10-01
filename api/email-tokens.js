/* One-time tokens for the two flows that prove someone controls an address (ISO-1397): e-mail
 * confirmation after signup ('verify', 24h) and "I lost my access" ('recover', 15min). Just the
 * code math here, same split as device-link.js: a long random token and its one-way hash. The
 * rows are store.js's (email_tokens, migrations/002) — purpose, expiry and single-use are a
 * column and a WHERE clause there, not anything this module decides.
 *
 * Unlike device-link.js's dash-grouped code (read off a screen and typed by hand), this token
 * only ever travels inside a URL a mail client already copies exactly — no human types it — so
 * it is plain base64url, not folded through an alphabet that forgives transcription mistakes.
 */
import crypto from 'node:crypto';

export const VERIFY_TTL_MS = 24 * 3600000;
export const RECOVER_TTL_MS = 15 * 60000;

export function makeEmailToken() {
  return crypto.randomBytes(32).toString('base64url'); // 256 bits
}
export const hashEmailToken = token => crypto.createHash('sha256').update('opengym-email:' + String(token || '')).digest('hex');
