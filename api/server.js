/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import * as coachConfig from './coach/config.js';
import * as coachJobs from './coach/jobs.js';
import { coachRoutes } from './coach/routes.js';
import { startCadence } from './coach/cadence.js';
import { startWarmup } from './coach/warmup.js';
import { dayReminderPush, restTimerPush, testPush } from './push-messages.js';
import { verifyError } from './verify-error.js';
import {
  hashPassword, verifyPassword, needsRehash, passwordProblem, passwordLength, nameKey, BusyError,
  MIN_LENGTH, MAX_LENGTH, makeResetCode, hashResetCode, resetCodeMatches, RESET_TTL_MS, warmUp,
  normalizeEmail, maskEmail
} from './password.js';
import { createBackoff, createWindow } from './rate-limit.js';
import { MAX_PASSKEYS } from './passkeys-store.js';
import * as oauthGoogle from './oauth-google.js';
import { createMediaStore, mediaLimits, mediaConfig, MediaError, HASH_RE, sniffMedia } from './media.js';
import { connectAndMigrate, withTransaction } from './db.js';
import {
  getUserState, getUserStateRev, putUserState,
  getUserById, getAllUsers, createUser, setPassword, removePasswordUnlessLast, rehashPassword,
  setPasswordReset, bumpSessionVersion, setEmail, markEmailVerified, setDisabled, touchLastPull,
  setLastReminder, deleteUser, upsertUser, backfillPasswordResetBy, setTermsAccepted,
  createSession, getSession, revokeSession,
  createInvite, getAllInvites, codeExists, inviteIsValid, consumeInvite, revokeInvite, upsertInvite,
  upsertSub, capUserSubs, getUserSubs, getUserIdsWithPush, hasPush, subStatus, deleteSub, unsubscribe,
  createDeviceLink, findDeviceLink, burnDeviceLink, dropDeviceLinks, upsertDeviceLink,
  listPasskeys, getPasskeyById, countPasskeys, insertPasskey, renamePasskey, passkeyRemovalRefused,
  removePasskey, touchPasskeyUse, upsertPasskey,
  insertOAuthIdentity, findOAuthIdentityBySubject, findOAuthIdentityByUser, touchOAuthIdentityUse,
  removeOAuthIdentityUnlessLast,
  createEmailToken, consumeEmailToken, claimStripeEvent, unclaimStripeEvent, insertStripeCleanup,
  listPrograms, getProgram, listProgramEvents, createProgram, updateProgram, trashProgram,
  restoreProgram, purgeProgram, purgeExpiredPrograms, setProgramCover, clearProgramCover,
  coverStillReferenced, getAllCoverFiles
} from './store.js';
import {
  CATEGORIES as PROGRAM_CATEGORIES, DIFFICULTIES as PROGRAM_DIFFICULTIES,
  CATEGORY_LABELS as PROGRAM_CATEGORY_LABELS, DIFFICULTY_LABELS as PROGRAM_DIFFICULTY_LABELS,
  TITLE_MIN as PROGRAM_TITLE_MIN, TITLE_MAX as PROGRAM_TITLE_MAX, DESCRIPTION_MAX as PROGRAM_DESCRIPTION_MAX,
  SESSION_MINUTES_MIN, SESSION_MINUTES_MAX, COVER_ALT_MIN, COVER_ALT_MAX, COVER_WIDTH_MIN, COVER_HEIGHT_MIN, COVER_DIM_MAX,
  validateProgram, validateCoverAlt, validateCoverDims, programConfig
} from './programs.js';
import { makeEmailToken, hashEmailToken, VERIFY_TTL_MS, RECOVER_TTL_MS } from './email-tokens.js';
import { sendMail } from './mail.js';
import { LEGAL_VERSION } from './legal.js';
import { renderVerifyEmail } from './mail-templates/verify-email.js';
import { renderRecoverEmail } from './mail-templates/recover-access.js';
import { renderPreChargeNotice } from './mail-templates/pre-charge-notice.js';
import {
  BILLING_ON, getStripe, hasActiveAccess, createCheckoutSession, createPortalSession,
  billingStatus, applyStripeEvent, setFirstPeriodNoticeHook, tickFirstPeriodNotices, nextChargeAmountCents,
  attemptStripeCleanup, tickStripeCleanup
} from './billing.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
// Phase 1b (ISO-1403): db.json and a profile's training data (state-<uid>.json) have both moved
// onto PostgreSQL (store.js) — mandatory from here on, including api/coach/jobs.js's own
// readState/listUserIds (jobs.setPool(pool), in listen() below). db.json itself is read exactly
// once more, at boot (readBootDb below), to migrate whatever an instance upgrading from before
// this phase still has on disk; nothing after that reads or writes it again.
const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (PostgreSQL holds profile state — see docs/SELF_HOSTING.md)');
  process.exit(1);
}
let pool; // set once connectAndMigrate() resolves, in listen() below
// A snapshot of every user, refreshed each reminder tick (below) — the one thing left that reads
// the account list synchronously: the account-lockout backoff's `keep` predicate (ACCOUNT_FAILS)
// and coach/cadence.js's tick, handed this as `deps.users()`. Up to one tick stale
// (REMINDER_TICK_MS, 10s in production) — fine for both: a lockout entry that lingers a beat past
// a password removal, a weekly cadence check against a user list a few seconds old. Everything
// cadence.js reads *about* a user (their state, their Coach record) is read fresh on every tick
// regardless, through jobs.js's own Postgres-backed readState — only the list of who to check is
// this snapshot.
let usersCache = [];
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'Brilhart Fitness';
// What a confirmation or recovery link points at (ISO-1397) — the app is a HashRouter, so a path
// is always "/#/…". Falls back to ORIGIN, same as docker-compose.yml already does for the og:url/
// og:image tags that have used this fallback since Phase 0; most instances never need to set it
// separately from ORIGIN at all.
const APP_URL = process.env.APP_URL || ORIGIN;
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// Guest mode ("Continue without account") keeps everything in the browser and never touches this
// server — but on an instance meant for a known set of people, an entrance nobody can walk back
// out of is still the wrong front door (#42). Default ON, so existing instances are unchanged;
// the polarity is inverted from INVITE_ONLY because the safe default here is the permissive one.
const ALLOW_GUEST = !/^(0|false|no|off)$/i.test(process.env.ALLOW_GUEST || '');
// Name-and-password sign-in next to passkeys (#118). Off by default: it adds a second way into
// every account that opts in, so an instance has to ask for it. While it is off every password
// route answers 404 and the app shows none of it; hashes already stored stay where they are.
const PASSWORD_LOGIN = /^(1|true|yes|on)$/i.test(process.env.PASSWORD_LOGIN || '');
// "Sign in with Google" (ISO-1597). Both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required —
// with either missing, every /api/auth/google/* and /api/register/google route is absent (404,
// the googleRoutes spread below never happens) and GET /api/config answers exactly as it did
// before this feature existed. GOOGLE_REDIRECT_URI is only for an instance whose public API
// address differs from APP_URL (reached through a different hostname than the app itself); the
// default has to match whatever is registered as the OAuth client's redirect URI in Google Cloud
// Console, or Google itself refuses the request before any of this code runs.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${APP_URL}/api/auth/google/callback`;
const GOOGLE_LOGIN = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
// The language the sign-in screen, and every profile that never picked one, starts in (#303) —
// for an instance whose people share a language. Only a tag's shape is checked here; the app
// matches it against the languages it has and ignores one it does not know. Unset, it is left
// out of /api/config and the app behaves as before.
const DEFAULT_LANG = (() => {
  const v = String(process.env.DEFAULT_LANG || '').trim();
  if (!v) return '';
  if (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(v)) return v;
  console.warn(`DEFAULT_LANG "${v.slice(0, 40)}" is not a language tag such as pt-BR or de — ignored`);
  return '';
})();
// Whether the address a request came from may be read from the headers a proxy sets. Only the
// sign-in throttle asks (limitAddress below); the bundled compose file sets it, because the API
// is reachable there only through the web container, which overwrites those headers.
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });
/* The secrets are locked down file by file rather than by sealing the whole directory.
 *
 * A blanket `chmod 0700` on DATA looks stronger and is worse: ./data is a host bind mount and
 * this container runs as root, so it lands on the host as root-owned 0700 and anything else
 * the owner runs against their own data directory — a backup script, the MCP server in #19,
 * their own `jq` — gets EACCES on files that are theirs. Locking the four files that actually
 * hold secrets keeps the Coach runtime out of them without taking the directory hostage.
 *
 * Best-effort throughout: a bind-mounted host filesystem may refuse chmod, and that is not a
 * reason to refuse to boot. The privilege drop in adapters/spawn.js is the control that does
 * fail closed. */
const lock = f => { try { fs.chmodSync(path.join(DATA, f), 0o600); } catch { /* not present yet, or host says no */ } };
['secret', 'db.json', 'coach.json'].forEach(lock);

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

// db.json itself is only ever read once more, at boot (readBootDb below) — the one-time
// migration of whatever an instance upgrading from before ISO-1403 still has on disk. Nothing
// after boot reads or writes it: every collection it used to hold lives in PostgreSQL now.
const dbFile = path.join(DATA, 'db.json');
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
function readBootDb() {
  let db = { users: [], creds: [], subs: [], invites: [], deviceLinks: [] };
  try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch { /* no db.json — a fresh instance */ }
  db.users = db.users || []; db.creds = db.creds || []; db.subs = db.subs || [];
  db.invites = db.invites || []; db.deviceLinks = db.deviceLinks || [];
  return db;
}
function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
// When a profile last fetched its document (GET /api/data). The document's own `_ts` moves only
// on a push, so a device that only ever read — a second phone, a profile that trains elsewhere
// and just looks — showed "last sync never" in the admin dashboard (QA 1.3.9). Kept on the user
// record and written at most every ten minutes per profile, since every foreground return pulls.
const PULL_NOTE_MS = 10 * 60 * 1000;
async function notePull(user, now = Date.now()) {
  if (user.lastPull && now - user.lastPull < PULL_NOTE_MS) return;
  user.lastPull = now;
  try { await touchLastPull(pool, user.id, now); } catch (e) { console.error('db save failed', e.message); }
}
// The later of the last push and the last pull.
const lastSyncOf = (u, S) => Math.max(S?._ts || 0, u?.lastPull || 0) || null;
// A profile's training data (ISO-1403) — PostgreSQL's user_state table, not state-<uid>.json.
// Kept as its own async function, rather than calling getUserState(pool, uid) at every call site,
// so callers that only want the document (media.js's injected readState, the reminder tick, the
// admin views) do not also have to know about `pool` or unwrap `{ state, rev }` themselves.
async function readState(uid) {
  return (await getUserState(pool, uid)).state;
}
// An entry is an object a reader can dereference, and `records` is every entry of a stored
// list. PUT /api/data drops the rest on the way in — a null workout, a routine that is a
// number — and refuses a list that is not an array at all, but a file written before it did
// answers to nobody, and the readers below walk those lists (`r.id`, `w.d`, `.slice()`). One
// throw inside an admin route is a 500 for that whole profile: the drill-down never leaves
// "Loading…", the Disable button lives inside it, and the account an operator opened the
// dashboard to stop is exactly the one they then cannot. Answering with the entries that are
// there is the honest reading of such a file — what was dropped carried nothing to show.
const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const records = v => (Array.isArray(v) ? v.filter(record) : []);

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

/* A push subscription's `endpoint` is a URL this server connects out to, chosen by whoever is
   signed in — so without a check /api/push/* is a request-forgery lever, and the api container
   sits on the same Docker network as the rest of the self-hoster's stack. Three limits below:

   1. PUSH_AGENT rejects any connection to a private/loopback/link-local address at the moment
      the socket is opened. Validating the URL alone would leave a DNS-rebinding window — the
      name is resolved a second time inside web-push — so the check has to live in the lookup
      the request itself uses, not in a prior pass. A literal IP address never goes through
      that lookup at all — Node hands it straight to connect() — so literals are judged by
      pushEndpointError instead: at subscribe, and again in sendPush for an endpoint that got
      into storage some other way.
   2. PUSH_TIMEOUT_MS: an endpoint that accepts TCP and then stalls used to hang the request
      handler that awaited it, indefinitely. web-push sets no timeout of its own.
   3. PUSH_CONCURRENCY: one small request must not turn into an unbounded burst of outbound
      connections (with MAX_SUBS_PER_USER below, that is the other half of the same problem). */
const PUSH_TIMEOUT_MS = 10000;
const PUSH_CONCURRENCY = 6;
const MAX_SUBS_PER_USER = 20;

function isPrivateAddr(ip) {
  const v = String(ip).toLowerCase();
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (m4) {
    const a = +m4[1], b = +m4[2];
    if (a === 0 || a === 10 || a === 127) return true;            // this-network, private, loopback
    if (a === 169 && b === 254) return true;                      // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 192 && b === 0) return true;                        // 192.0.0.0/24, 192.0.2.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a >= 224) return true;                                    // multicast + reserved
    return false;
  }
  // IPv6 is judged on its eight groups, never on the text: the same address arrives as
  // `::ffff:127.0.0.1` from dns.lookup, as `::ffff:7f00:1` from new URL, and in whatever
  // spelling a caller chose, and a rule keyed to one spelling misses the others.
  const g = ipv6Groups(v);
  if (!g) return false;
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {     // IPv4-mapped IPv6
    return isPrivateAddr(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (g.slice(0, 7).every(x => x === 0) && g[7] <= 1) return true; // unspecified, loopback
  if ((g[0] & 0xffc0) === 0xfe80) return true;                    // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;                    // unique local fc00::/7
  return false;
}

// The eight 16-bit groups of an IPv6 literal in any textual form — compressed, zero-padded,
// upper-case, with a dotted IPv4 tail — or null when the string is not one.
function ipv6Groups(v) {
  if (!net.isIPv6(v)) return null;
  let s = v.replace(/%.*$/, '');                                  // zone id
  const m4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (m4) {
    const [a, b, c, d] = m4[1].split('.').map(Number);
    s = s.slice(0, -m4[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail = ''] = s.split('::');
  const groups = head ? head.split(':') : [];
  const rest = tail ? tail.split(':') : [];
  if (s.includes('::')) while (groups.length + rest.length < 8) groups.push('0');
  return groups.concat(rest).map(x => parseInt(x, 16));
}

// Same shape as dns.lookup, so https.Agent can use it directly.
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some(a => isPrivateAddr(a.address))) {
      return cb(Object.assign(new Error('refusing to connect to a private address: ' + hostname), { code: 'EPUSHBLOCKED' }));
    }
    cb(null, address, family);
  });
}
const PUSH_AGENT = new https.Agent({ lookup: guardedLookup, keepAlive: false });

// Cheap pre-check so a bad endpoint is refused at subscribe time with a useful message, rather
// than silently never delivering. For a hostname PUSH_AGENT is what actually enforces the address
// rule; for a literal address this is the check, which is why sendPush runs it again.
function pushEndpointError(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return 'endpoint is not a valid URL'; }
  if (u.protocol !== 'https:') return 'endpoint must be an https:// URL';
  if (u.username || u.password) return 'endpoint must not carry credentials';
  // A literal address is judged right here — and only here: Node hands a literal straight to
  // connect() without consulting the Agent's lookup. Hostnames are left to PUSH_AGENT, which is
  // the check that has to hold against rebinding.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isPrivateAddr(host)) return 'endpoint must not point at a private address';
  }
  return null;
}

// `deviceId` narrows the send to the subscriptions one browser registered (the rest-timer alert
// belongs to the device that started the rest); a subscription stored without one — an older
// client — still gets everything, as before.
async function sendPush(userId, payload, deviceId) {
  let subs = await getUserSubs(pool, userId);
  if (deviceId && subs.some(s => s.deviceId === deviceId)) subs = subs.filter(s => s.deviceId === deviceId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  // Pruning a dead or refused subscription is bookkeeping, not the send. Most callers do not
  // await this function at all (the rest-timer setTimeout, the Coach proposal hook), so a
  // Postgres delete that fails right now would turn the throw into an unhandled rejection and
  // take the process down — caught and logged per row instead. A row this leaves behind is
  // pruned again the next time a send to it fails, same as before.
  const prune = endpoint => deleteSub(pool, endpoint).catch(e => console.error('push: could not prune dead subscription', e.message));
  let next = 0;
  const worker = async () => {
    while (next < subs.length) {
      const sub = subs[next++];
      // Re-judged before every send: PUSH_AGENT never sees a literal address, so an endpoint
      // that is private (however it got into the database) is dropped here rather than connected to.
      const bad = pushEndpointError(sub.endpoint);
      if (bad) {
        console.error('push endpoint refused', userId, bad);
        await prune(sub.endpoint);
        continue;
      }
      // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
      // low-urgency background push more aggressively under battery-saving modes. TTL is left
      // at the library default (long) so a briefly-offline device still gets it once reconnected,
      // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
      // actually control anyway.
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body,
          { urgency: 'high', timeout: PUSH_TIMEOUT_MS, agent: PUSH_AGENT });
      } catch (e) {
        console.error('push send failed', userId, e.statusCode, e.body || e.message);
        // 404/410: the push service says the subscription is gone. 403: it refuses our VAPID
        // signature — a subscription made against a key this instance no longer has (data/vapid.json
        // regenerated). Neither will ever deliver again; keeping them only hides the fact from the
        // Settings toggle, which reads the browser's side. The client re-subscribes on its next boot.
        if (e.statusCode === 404 || e.statusCode === 410 || e.statusCode === 403) await prune(sub.endpoint);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, subs.length) }, worker));
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
// One timer per device, not per account: a phone resting in the gym and a desktop tab at home
// each carry their own, so the tab's on-screen completion (which cancels) cannot silence the
// phone's alert. A client that sends no device id gets the old account-wide behaviour.
// In memory only — an API restart drops whatever is pending.
const restTimers = new Map(); // `${userId}:${deviceId}` -> Timeout
const restKey = (userId, deviceId) => `${userId}:${deviceId || ''}`;
function scheduleRestTimer(userId, deviceId, sec, lang) {
  const k = restKey(userId, deviceId);
  const t = restTimers.get(k);
  if (t) clearTimeout(t);
  restTimers.set(k, setTimeout(() => {
    restTimers.delete(k);
    sendPush(userId, restTimerPush(lang), deviceId);
  }, sec * 1000));
}
function cancelRestTimer(userId, deviceId) {
  // no device id: an older client — clear everything the account has pending, as it always did
  for (const [k, t] of restTimers) {
    if (deviceId ? k === restKey(userId, deviceId) : k.startsWith(userId + ':')) { clearTimeout(t); restTimers.delete(k); }
  }
}
// A device id is what the browser made up for itself (lib/push.js): one short token per browser
// profile, nothing identifying. Anything else is treated as absent.
const deviceIdOf = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined);

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
// The `?.` on each entry is this copy's own: it reads whatever is on disk, including a file written before PUT /api/data dropped null entries.
// A weekday can hold a routine-id list (combine routines); the reminder only needs the first.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r?.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return [].concat(S.week?.[wd] || []).find(id => S.routines?.some(r => r?.id === id)) || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday is derived from the zone's own date, not the server's — a Sunday-evening review
    // has to be Sunday where the user is, which is what the reminder already assumes for time.
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
// The tick used to want the exact minute: `reminder.time === now.hhmm`, checked every 10 s. Any
// restart, redeploy or stalled event loop across that one minute lost the whole day's reminder —
// "sometimes it just doesn't come". A reminder that is due is now sent for up to this many
// minutes after its time, once per local date (`user.lastReminder`); later than that it is
// skipped rather than delivered at a time nobody asked for.
const REMINDER_WINDOW_MIN = 15;
// How often the tick looks. 10 s keeps a reminder within ~9 s of its minute; the tests shorten it.
const REMINDER_TICK_MS = Math.max(50, +(process.env.REMINDER_TICK_MS || 10000));
const hhmmToMin = v => {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
// Minutes since the reminder's time on the user's clock; negative before it, NaN when either
// side does not parse. Same-day only — a 23:55 reminder is not owed at 00:05 the next day.
const minutesLate = (time, now) => hhmmToMin(now.hhmm) - hhmmToMin(time);
// The tick reads every subscribed user's state every 10 s. It used to hold a file-stat cache here
// (mtime/size keyed) because parsing a multi-MB JSON file off disk on every pass was the expensive
// part; a `SELECT state FROM user_state` does not pay that cost; Postgres, not this process, is
// what decides how a query the size doesn't change gets served twice in a row.
setInterval(async () => {
  // REMINDER_TICK_MS can be set well under the time listen() takes to connect, migrate and
  // backfill (tests do this deliberately, to keep the wait short) — this tick's own interval is
  // registered at module load, before any of that starts, so the first one or two firings can
  // land before `pool` exists at all.
  if (!pool) return;
  usersCache = await getAllUsers(pool);
  const withPush = await getUserIdsWithPush(pool);
  for (const user of usersCache) {
    if (!withPush.has(user.id)) continue;
    // One user's state is one user's problem: a shape this tick cannot read is logged and
    // skipped, not allowed to take the process — and everyone else's reminders — down with it.
    // PUT /api/data refuses the obvious shapes, but a document written before it did answers to
    // nobody.
    try {
      const S = await readState(user.id);
      if (!S?.reminder?.on) continue;
      const now = userNow(S.reminder.tz || 'UTC');
      if (!now) continue;
      const late = minutesLate(S.reminder.time, now);
      if (!(late >= 0 && late <= REMINDER_WINDOW_MIN)) continue;
      if (user.lastReminder === now.date) continue;
      if ((S.workouts || []).some(w => w?.d === now.date)) continue;
      const rid = effectiveRoutineId(S, now.date);
      if (!rid) continue; // rest day — nothing planned
      const routine = (S.routines || []).find(r => r?.id === rid);
      console.log('reminder firing', user.id, rid);
      user.lastReminder = now.date;
      await setLastReminder(pool, user.id, now.date);
      sendPush(user.id, dayReminderPush(S.lang, routine));
    } catch (e) {
      console.error('reminder tick', user.id, e);
    }
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, REMINDER_TICK_MS).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Structured signed cookies for the Google OAuth flow (ISO-1597) — the state/nonce/PKCE verifier
// a GET /api/auth/google/start hands back to itself via the browser, and the pending-signup
// ticket a callback with no matching account hands to POST /api/register/google. Same HMAC as a
// session cookie, over a JSON payload instead of the colon-joined session string, since these
// carry a handful of fields of varying shape rather than one fixed tuple.
function signJSON(obj) { return sign(Buffer.from(JSON.stringify(obj)).toString('base64url')); }
function verifyJSON(token) {
  const payload = verifySig(token);
  if (!payload) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}
// Session payload is `<uid>:<expiry>:<version>[:<sessionId>]`. `version` is the user's `sv`
// counter — bumping it (POST /api/logout/all) still invalidates every cookie for the account at
// once, the way it always did. `sessionId` (ISO-1403) is a `sessions` row, for POST /api/logout to
// revoke the one cookie that made the request instead of every one of the account's — see
// sessionOf below for the revocation check, and store.js for the table. Cookies minted before
// either field existed have fewer than four parts, and are read as version 0 / no session to
// revoke, matching what they always meant — they stay valid until they expire or `sv` moves, same
// as before this table existed. That includes every cookie a test forges directly against SECRET
// without going through a real login: nothing here requires a `sessions` row to exist.
const sessionVersion = user => user.sv || 0;
async function makeSession(user, userAgent) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const sid = await createSession(pool, { userId: user.id, expiresAt: exp, userAgent });
  return sign(`${user.id}:${exp}:${sessionVersion(user)}:${sid}`);
}
// With the __Host- prefix the *browser* guarantees the cookie is host-only (no Domain attribute
// is even allowed) — which is what stops a sibling subdomain, e.g. anything-else.example.com
// against gym.example.com, from planting a second session cookie for the shared parent domain
// and having it shadow the real one. The prefix also requires Secure, so it only works on an
// https ORIGIN; over plain http://localhost the old name stays, and localhost has no sibling
// subdomains to worry about. Both names are accepted on the way in, so upgrading an instance
// does not sign anybody out — they move onto the prefixed cookie at their next sign-in.
const COOKIE = SECURE ? '__Host-gymsid' : 'gymsid';
const LEGACY_COOKIE = 'gymsid';
// Every value for a given name, in the order the browser sent them. Not an object: reducing
// duplicates to one entry silently picks a winner, and picking the *last* one handed a shadowing
// cookie the session outright.
function cookieValues(req, name) {
  const out = [];
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (i < 0) continue;
    if (c.slice(0, i).trim() === name) out.push(c.slice(i + 1).trim());
  }
  return out;
}
// One specific cookie's value, refusing two different ones under the same name the same way
// cookieToken (the session cookie) does — nobody but this server ever sets gauth_oauth or
// gauth_signup, so two different values under that name means someone else tried to.
function singleCookie(req, name) {
  const vals = cookieValues(req, name);
  if (!vals.length) return null;
  if (vals.some(v => v !== vals[0])) return null;
  return vals[0];
}
function cookieToken(req) {
  for (const name of (COOKIE === LEGACY_COOKIE ? [COOKIE] : [COOKIE, LEGACY_COOKIE])) {
    const vals = cookieValues(req, name);
    if (!vals.length) continue;
    // Two different values under one name is not something a browser does on its own — it means
    // somebody else got to set one. There is no safe way to guess which is the real session, so
    // refuse both: a signed-out user signs back in, a shadowing attempt gets nothing.
    if (vals.some(v => v !== vals[0])) return null;
    return vals[0];
  }
  return null;
}
// The session behind a request: { user, exp, bearer } — `bearer` when it came in an Authorization
// header (a paired phone) rather than the cookie — or null for no valid session at all.
async function sessionOf(req) {
  // The paired mobile app has no cookie jar shared with the API's origin, so it carries the same
  // signed token in an Authorization header instead — same payload, same verification below.
  const auth = req.headers.authorization || '';
  const cookie = cookieToken(req);
  const tok = cookie || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : null);
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver, sid] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  // A fourth field is a real sessions row (ISO-1403) — revoked (POST /api/logout) or gone
  // (nothing prunes this table yet, but a wiped database would leave old cookies pointing at
  // nothing) makes the cookie invalid regardless of what `sv` says. No fourth field: nothing to
  // check here, same as before this table existed.
  if (sid) {
    const session = await getSession(pool, sid);
    if (!session || session.revoked || session.userId !== uid) return null;
  }
  const user = await getUserById(pool, uid);
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return { user, exp: +exp, bearer: !cookie, sid: sid || null };
}
async function readSession(req) {
  return (await sessionOf(req))?.user || null;
}
// Re-checks the session after some awaited work (a slow hash, a WebAuthn ceremony) that a request
// handler needs to know nobody else changed things out from under — a password change, "sign out
// everywhere" or an admin disable landing in between. Under the old in-memory db.json, `user` was
// a live reference into the same array every route read, so a straight `readSession(req) !== user`
// caught that: any of those mutated the very object `user` pointed at, in place. With PostgreSQL,
// every read is a fresh row — `user` is a snapshot, not a reference — so object identity can never
// match again and that comparison would reject every request. Comparing the account id and the
// session version — the same version `sessionOf` already re-validates the cookie's claim against —
// is what that check actually meant. `sv` defaults to `user`'s own, for the common case of "has
// anything happened to this account since we last looked"; a caller mid-ceremony (the passkey-add
// flow) passes the version stamped on the challenge instead, since that may predate `user` itself.
// Returns the fresh user on success, so a caller that wants the up-to-date row doesn't have to ask
// twice — null otherwise.
async function sessionStillValid(req, user, sv = sessionVersion(user)) {
  const fresh = await readSession(req);
  return fresh?.id === user.id && sessionVersion(fresh) === sv ? fresh : null;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
async function requireAdmin(req, res) {
  const user = await readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  // Only the 403 is recorded: a 401 is any unauthenticated bot poking /api/admin/*, and
  // logging those would bury the events an operator actually wants to see.
  if (!isAdmin(user)) { audit(req, 'admin.denied', { ok: false, user }); json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
const expireCookie = name => `${name}=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;
async function sessionCookie(user, userAgent) {
  const fresh = `${COOKIE}=${await makeSession(user, userAgent)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
  // Signing in also retires any pre-upgrade cookie, so nobody is left carrying an unprefixed one
  // (or a shadowing copy of it) alongside the new session.
  return COOKIE === LEGACY_COOKIE ? [fresh] : [fresh, expireCookie(LEGACY_COOKIE)];
}
const clearCookie = COOKIE === LEGACY_COOKIE
  ? [expireCookie(LEGACY_COOKIE)]
  : [expireCookie(COOKIE), expireCookie(LEGACY_COOKIE)];

/* ---------- CSRF ---------- */
// SameSite=Lax keeps the session cookie off a genuinely cross-*site* request. It does not keep it
// off a *sibling subdomain*: gym.example.com and anything-else.example.com are the same site, and
// that is the ordinary self-hosting layout — one domain, one reverse proxy, several apps. Nothing
// else in a request was being checked either; readBody() JSON.parse's the body whatever the
// Content-Type claims, so a hostile page could reach the state-changing routes with a form-style
// POST that needs no CORS preflight at all.
//
// So a state-changing request that came from a browser has to come from ORIGIN. The exemptions
// below are not holes: each of those routes carries its own credential in the body (a WebAuthn
// challenge id, a one-shot pairing code), none of them acts on the caller's existing session, and
// they have to keep working from the mobile WebView, whose origin is never ORIGIN.
//
// The password routes are deliberately NOT here. A name and a password are a credential too,
// but one a hostile page can know — its own — so an exempt POST /api/login/password would let
// any site sign a visitor into the attacker's account and collect what they log (login CSRF).
const CSRF_EXEMPT = new Set([
  'POST /api/register/options', 'POST /api/register/verify',
  'POST /api/login/options', 'POST /api/login/verify',
  'POST /api/pair/redeem',
  // Same reasoning as register/login: each carries its own one-time credential in the body (a
  // mailed token, or nothing at all for the neutral recover/request) rather than acting on the
  // caller's session, and the link that reaches account/email/verify or recover/redeem may open
  // in the mobile shell, whose origin is never ORIGIN.
  'POST /api/account/email/verify', 'POST /api/recover/request', 'POST /api/recover/redeem'
  // POST /api/client-event (ISO-1480) is deliberately NOT here: it only ever fires from
  // navigator.sendBeacon to this same page's own origin (lib/api.js beacon(); MOBILE never
  // calls it), so Sec-Fetch-Site: same-origin already clears it below — exempting it too would
  // let a cross-site page spam the audit log for free, for no caller that actually needs it.
  //
  // GET /api/auth/google/start and GET /api/auth/google/callback (ISO-1597) need no entry here
  // at all: csrfOk already answers every GET true, before this set is even consulted — which is
  // exactly right for a callback that is itself a cross-site GET navigation coming back from
  // accounts.google.com. Its own `state` parameter, checked against the signed cookie
  // GET /api/auth/google/start set, is this flow's actual CSRF defense. POST /api/register/google
  // and DELETE /api/account/google are deliberately NOT here, same reasoning as the password
  // routes above: register/google is how an account with a chosen password-equivalent (the
  // Google identity itself) comes to exist, so an exempt POST would be a login-CSRF hole; unlink
  // acts on the caller's own session the same as every other DELETE /api/account/*.
]);
const originsMatch = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
function csrfOk(req, key) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  if (CSRF_EXEMPT.has(key)) return true;
  // The paired mobile app authenticates with a Bearer token. A browser never attaches one on its
  // own, so there is no ambient authority for a hostile page to borrow and no origin to check.
  if ((req.headers.authorization || '').startsWith('Bearer ')) return true;
  // Sec-Fetch-Site is set by the browser itself and no page can forge it, and it states exactly
  // the property wanted here — more precisely than comparing origins can. 'same-origin' is the
  // app talking to its own backend; a hostile page reports 'cross-site'; a sibling subdomain,
  // the case SameSite=Lax misses entirely, reports 'same-site'. It is also what keeps the Vite
  // dev server working, where the page is on another port and its Origin is legitimately not
  // ORIGIN. Absent on older Safari and on proxies that strip it, hence the fallback below.
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  // No Origin header at all means no browser sent this — curl, a script, a monitoring check.
  // Browsers put an Origin on every state-changing request and a page cannot suppress it, so the
  // forgery this exists to stop always carries one.
  if (!origin) return true;
  return originsMatch(origin, ORIGIN);
}

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
// Every challenge says which ceremony it was handed out for (`kind`), and every route that takes
// one back accepts only its own kind. Four ceremonies share this store — signing up, signing in,
// adding a passkey in Settings and redeeming a device link (#95) — and the last two carry a `uid`
// exactly like a sign-up's. When /api/register/verify asked only for a uid, the challenge that
// POST /api/device-link/options hands to anyone holding a code finished a *sign-up* instead: a
// passkey on the owner's profile and a session for it, without using the code up, as often as
// wanted, and past "sign out everywhere".
const challenges = new Map(); // cid -> {kind, challenge, name?, uid?, exp}
function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

// ---------- device pairing (mobile app "connect to my server", no WebAuthn ceremony) ----------
// A passkey ceremony can't run inside the app's WebView (its origin never matches RP_ID), so the
// app authenticates by redeeming a short code minted from an already signed-in browser tab —
// same 5-min-TTL/one-shot shape as the WebAuthn challenge store above.
const pairings = new Map(); // code -> {uid, exp}
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — read off a screen
function makePairCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(8)).map(b => PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length]).join('');
  } while (pairings.has(code));
  return code;
}
setInterval(() => { for (const [k, v] of pairings) if (v.exp < Date.now()) pairings.delete(k); }, 60000).unref();

// Google "Confirm with Google" (intent=reauth, ISO-1597 addendum): proveOwner's third proof, for
// an account that only has a Google identity and so cannot confirm anything with a passkey or a
// password. A successful reauth callback mints one of these, bound to the account and to the
// exact session that started it (sid — or, for a pre-ISO-1403 cookie with none, no session row to
// tie it to, same fallback sessionOf's own revocation check uses); proveOwner below redeems it
// once, for whichever action the caller was in the middle of. 5 minutes, same ceremony-TTL
// reasoning as the WebAuthn challenge store above.
const reauthProofs = new Map(); // token -> { uid, sid, exp }
function putReauthProof(uid, sid) {
  const token = crypto.randomBytes(24).toString('base64url');
  reauthProofs.set(token, { uid, sid: sid || null, exp: Date.now() + 5 * 60000 });
  return token;
}
function takeReauthProof(token) {
  const p = reauthProofs.get(token);
  reauthProofs.delete(token); // single-use regardless of outcome
  if (!p || p.exp < Date.now()) return null;
  return p;
}
setInterval(() => { for (const [k, v] of reauthProofs) if (v.exp < Date.now()) reauthProofs.delete(k); }, 60000).unref();

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
// A request the caller got wrong. The catch-all at the bottom answers it with this status and
// message and does not log it: three of the routes below are reachable without a session, and a
// stack trace per malformed body would let anyone fill the container log with noise that looks
// like a crash. Anything else that escapes a handler is still a real 500 and still logged.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// Thrown inside withTransaction(pool, ...) by either registration route below to roll back a
// user row that was about to be created on top of an invite another request consumed first — see
// consumeInvite in store.js. Caught right outside the transaction, never anywhere else.
class InviteRaceError extends Error {}
// Same idea, for POST /api/device-link/verify: thrown when burnDeviceLink claims zero rows —
// another request already burned this code — to roll back before insertPasskey ever runs.
class DeviceLinkRaceError extends Error {}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (over) {
        // The 413 is already on its way. The rest of the upload is read and thrown away rather
        // than the socket destroyed under it: closing with unread bytes on the wire makes the
        // kernel send a reset, and a client (node's own http client included) that hits the
        // reset before it has parsed the answer reports a dropped connection instead of the
        // 413. A client that keeps streaming past twice the cap is not a mistaken one, and is
        // cut off.
        if (size > 2 * MAX_BODY) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        over = true; chunks.length = 0;
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve({});
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(new HttpError(400, 'invalid json')); }
      // Every handler reads fields off the result, so a JSON `null`, string, number or array is
      // as much a client mistake as unparseable text — refused once here rather than dereferenced
      // (and turned into a TypeError) in each route.
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'invalid json'));
      resolve(body);
    });
    // A browser hanging up mid-body — which is what pagehide does to an in-flight sync — is not
    // the caller getting a request wrong, it is nobody being left to answer. Marked so the
    // catch-all at the bottom says one line instead of a stack trace and a 500 into a dead socket.
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}
// Same shape as readBody, minus the JSON.parse: POST /api/billing/webhook is the one route that
// needs the exact bytes Stripe signed, not the object they parse to — stripe.webhooks.constructEvent
// verifies the signature against this Buffer itself, and parsing first (even just to re-stringify)
// risks disagreeing with Stripe's own serialization on whitespace or key order.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { req.destroy(); reject(new HttpError(413, 'body too large')); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}
// A caller-supplied field that is meant to be text. String() alone is not safe on a parsed body:
// `{"code":{"toString":1}}` is valid JSON and String() throws on it.
const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- audit log ---------- */
// Who signed in, who tried and failed, and what an admin changed. One JSON object per line in
// ./data/audit.log, appended and never rewritten in place. It deliberately does not live in
// PostgreSQL alongside everything else: the login/register handshakes are unauthenticated and
// unthrottled by design (see SECURITY.md; only the optional password routes are throttled,
// below), so an audit trail in a table there would turn one bogus request into a row nobody
// asked for. A line torn by a crash costs one event and is dropped on read.
//
// On by default. It records strictly less than the instance already holds — every account and
// every workout is already in the database, readable by any admin — and a security feature that
// ships switched off protects nobody. IP addresses are the exception: off unless you ask for
// them, because they are the one field here that says where somebody physically is.
const AUDIT_ON = !/^(0|false|no|off)$/i.test(process.env.AUDIT_LOG || '');
const AUDIT_MAX = Math.max(0, +(process.env.AUDIT_MAX || 5000) || 0);     // 0 = no count cap
const AUDIT_DAYS = Math.max(0, +(process.env.AUDIT_DAYS || 90) || 0);     // 0 = no age cap
const AUDIT_IP = /^full$/i.test(process.env.AUDIT_IP || '') ? 'full'
  : /^(1|true|yes|on|net)$/i.test(process.env.AUDIT_IP || '') ? 'net' : 'off';
const auditFile = path.join(DATA, 'audit.log');
let auditSeq = 0;      // never reset, not even by a clear — a wiped log leaves a visible id gap
let auditCount = 0;

// Which header holds the caller depends on what is in front of the API. CF-Connecting-IP comes
// first because a Cloudflare tunnel does NOT forward the client in X-Forwarded-For — that header
// then only carries the tunnel's own container, which looks like a valid answer and isn't. After
// that, the first entry of X-Forwarded-For is the client and everything behind it is our own hops.
// All three are only as trustworthy as the proxy in front: it has to overwrite them rather than
// pass a client-supplied one through. In 'net' mode only the network survives — enough to tell
// one source from another, not enough to point at a person.
function clientIp(req) {
  if (AUDIT_IP === 'off') return null;
  const raw = String(req.headers['cf-connecting-ip'] || '').trim()
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.headers['x-real-ip'] || '').trim()
    // Nothing in front at all: the socket peer is the client, and it cannot be forged. Behind
    // the bundled web container a header always wins before this is reached.
    || String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
  const ip = raw.replace(/^\[|\]$/g, '').slice(0, 45);
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;    // never store a header verbatim
  if (AUDIT_IP === 'full') return ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.0/24');
  const g = ip.split(':').filter(Boolean).slice(0, 3).join(':');
  return g ? g + '::/48' : null;
}

function auditLines() {
  let text;
  try { text = fs.readFileSync(auditFile, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && r.id && r.ev) rows.push(r); } catch { /* torn line */ }
  }
  return rows;
}
// Retention is a cap, not an archive: age first, then the newest AUDIT_MAX of what's left.
function auditKeep(rows) {
  let out = rows;
  if (AUDIT_DAYS) { const cut = Date.now() - AUDIT_DAYS * 86400000; out = out.filter(r => r.ts >= cut); }
  if (AUDIT_MAX && out.length > AUDIT_MAX) out = out.slice(out.length - AUDIT_MAX);
  return out;
}
function compactAudit() {
  const rows = auditLines();
  for (const r of rows) if (+r.id > auditSeq) auditSeq = +r.id;
  const keep = auditKeep(rows);
  auditCount = keep.length;
  if (keep.length === rows.length) return;
  try { atomicWrite(auditFile, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '')); }
  catch (e) { console.error('audit compact failed', e.message); }
}

// Never throws: a log that can't be written must not break signing in.
function audit(req, ev, f = {}) {
  if (!AUDIT_ON) return;
  const rec = { id: ++auditSeq, ts: Date.now(), ev, ok: f.ok !== false };
  if (f.user) { rec.uid = f.user.id; rec.name = String(f.user.name || '').slice(0, 40); }
  else {
    if (f.uid) rec.uid = f.uid;
    if (f.name) rec.name = String(f.name).slice(0, 40);
  }
  if (f.target) { rec.tgt = f.target.id; rec.tname = String(f.target.name || '').slice(0, 40); }
  if (f.msg) rec.msg = String(f.msg).slice(0, 120);
  // What a failed proof of ownership was guarding (proveOwner): 'email', 'passkey-add', …
  if (f.act) rec.act = String(f.act).slice(0, 40);
  const ip = clientIp(req);
  if (ip) rec.ip = ip;
  try { fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n'); }
  catch (e) { return console.error('audit write failed', e.message); }
  // Amortized: a 5000-event cap rewrites the file once per ~1250 events.
  if (AUDIT_MAX && ++auditCount > AUDIT_MAX * 1.25) compactAudit();
}
if (AUDIT_ON) {
  compactAudit();                                // prune on boot, seed auditSeq/auditCount
  setInterval(compactAudit, 3600000).unref();    // honour AUDIT_DAYS on an idle instance too
}

/* ---------- client-event beacon (ISO-1480) ---------- */
// Three sign-in/sign-up/recovery flows looked like "nothing happened" on an Android phone whose
// browser refused WebAuthn outright — a certificate it does not trust, no screen lock, no
// credential manager — because the frontend's own NotAllowedError/AbortError handling treated
// every such rejection as a tap-away (lib/webauthn-error.js fixes the frontend side). Anderson's
// own ask was "olhem os logs": this is what makes the next one show up in audit.log without
// needing a console pulled off the device. Never the error's own message text, a credential id,
// or anything else that could be a fingerprint — only the small enum the frontend's classifier
// already reduced it to.
const WEBAUTHN_FLOWS = new Set(['register', 'login', 'device-link', 'settings-add-passkey', 'password-confirm']);
const WEBAUTHN_KINDS = new Set(['cert-untrusted', 'insecure-context', 'instant-refusal', 'unsupported', 'other']);
// Coarse enough to say "real Chrome on Android" apart from an in-app WebView without keeping
// anything that identifies a device: WebView adds a "wv" token and a leading "Version/X.0" ahead
// of the Chrome version that a full browser never does.
function uaFamily(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  const webview = /; ?wv\)/.test(ua) || /\bVersion\/[\d.]+ Chrome\//.test(ua);
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS\//.test(ua) ? 'Chrome' : /Chrome\//.test(ua) ? (webview ? 'Chrome-WebView' : 'Chrome')
    : /Version\/.*Safari\//.test(ua) ? 'Safari' : 'unknown';
  return browser + '/' + os;
}

/* ---------- sign-in throttle ---------- */
// The password routes are counted (rate-limit.js) — only on an instance with PASSWORD_LOGIN on,
// since none of them exists otherwise — and so are the two that redeem a device link (#95).
// Passkey sign-in, passkey registration and phone pairing stay out of it, as they always were:
// nothing there is worth guessing (an assertion is a signature, an invite code 64 random bits, a
// pairing code lives five minutes), and behind a proxy that hands the API one address for every
// visitor a per-address count on them would let one stranger pause everybody's way in. A
// device-link code is 60 bits that live ten minutes, no more worth guessing than a pairing code,
// but it is counted the way a reset code is: every wrong one is a guess at a way into somebody's
// profile, and the pause it can start only ever stops link redemption, never a sign-in.
// Three counts:
//
//   AUTH_BURST   every request to a counted route, 60 a minute per address. Enough for a
//                household behind one proxy; not enough to run scrypt as fast as one client
//                can ask.
//   ADDR_FAILS   wrong answers per address and per kind (a password or reset code, an invite
//                code on password signup, a device-link code): 20 free, then a pause of 30 s
//                that doubles up to 15 min.
//   ACCOUNT_FAILS  wrong passwords per *account*, whoever sends them: 5 free, then 1 min
//                doubling up to 1 h, forgotten after a day without one or on the next success.
//                This is the one that protects a password — an address is cheap to change, an
//                account is not. It is keyed by the account the name or e-mail resolves to
//                (`acct:<id>`), so typing the e-mail after the name was paused meets the same
//                pause; an identifier that resolves to nobody is counted as typed (`id:<fold>`),
//                so a pause looks the same whether an account is there or not. The count of an
//                account with a password is never evicted to make room for others. Passkeys
//                are never paused by it.
//
// A password check is counted against the name and the address the moment it starts, not when
// its answer comes back (passwordAttempt below): scrypt takes a tenth of a second, and counting
// afterwards let a burst sent at once be checked in full under a single allowance.
//
// Behind a proxy every request can come from the same address (the bundled web container passes
// the real one on; a second proxy in front of it may not). Then the per-address counts act for
// the whole instance: one client can pause *password* sign-in for everybody for a while, and the
// per-name pause is what still protects each password.
const AUTH_BURST = createWindow({ max: 60, windowMs: 60000 });
const ADDR_FAILS = createBackoff({ free: 20, baseMs: 30000, maxMs: 15 * 60000, forgetMs: 3600000 });
const ACCOUNT_FAILS = createBackoff({
  free: 5, baseMs: 60000, maxMs: 3600000, forgetMs: 24 * 3600000,
  // At most one per profile with a password, so this cannot grow without bound.
  keep: k => k.startsWith('acct:') && hasPassword(usersCache.find(u => u.id === k.slice(5)))
});
setInterval(() => { AUTH_BURST.sweep(); ADDR_FAILS.sweep(); ACCOUNT_FAILS.sweep(); }, 60000).unref();

// Route -> the kind of failure it can count. Every route listed here also spends the burst
// budget; `null` spends only that.
const THROTTLED = {
  'POST /api/login/password': 'password', 'POST /api/login/password-reset': 'password',
  'POST /api/register/password': 'signup',
  'POST /api/account/password': 'password', 'DELETE /api/account/password': null,
  // Setting an e-mail only spends the budget and asks the address's e-mail pause; an address
  // already in use counts against it (see POST /api/account/email).
  'POST /api/account/email': 'email',
  // Redeeming a device link (#95). Adding or removing a passkey and making a link only spend the
  // budget: the password that may prove them counts its own failures (passwordAttempt).
  'POST /api/device-link/options': 'link', 'POST /api/device-link/verify': 'link',
  'POST /api/account/passkeys/options': null, 'POST /api/account/device-link': null,
  'DELETE /api/account/passkeys': null,
  // Self-deletion (ISO-1447): proveOwner guards it the same as every other DELETE /api/account/*
  // above, so a wrong passkey or password only spends the burst budget, not a `kind` of its own.
  'DELETE /api/account': null,
  // E-mail confirmation and recovery (ISO-1397). A wrong or replayed token is a guess at the
  // same kind of secret a device-link code is, so it shares that pause; "resend" spends the same
  // budget, since both are "how many times can you poke the confirmation link for one account".
  // recover/request is deliberately absent from this table, not merely `null`: being listed at
  // all — even with no `kind` — would still spend AUTH_BURST at the dispatcher and could answer
  // 429 past 60/min, breaking the one guarantee this route makes (always 200, so an address never
  // learns "you're being throttled" as a side-channel on top of "this account doesn't exist").
  // Its own per-address pause on a guess that resolves to nobody is handled entirely inside the
  // handler instead, silently, with no answer that differs because of it.
  'POST /api/account/email/verify': 'email-verify', 'POST /api/account/email/resend': 'email-verify',
  'POST /api/recover/redeem': 'recover',
  // Only the shared burst budget (ISO-1480): there is no secret here for a `kind` to guard, just
  // an audit-log beacon a misbehaving or hostile page could otherwise spam without limit.
  'POST /api/client-event': null,
  // Accepting the current terms (ISO-1390): nothing to guess, so only the shared burst budget.
  'POST /api/account/terms/accept': null,
  // Google sign-in (ISO-1597). The callback is where a forged `state`/`code` or a tampered ID
  // token would be guessed at, so it gets its own `kind`, struck on each such failure
  // (strikeAddress below) exactly like a wrong password or device-link code; the start routes
  // (GET, and the proof-gated POST that mints the same cookie for a Settings-initiated link) have
  // nothing to guess, only the shared burst budget. register/google's ticket lives in a signed,
  // HttpOnly cookie, not something a caller can present in bulk, but repeated attempts at a birth
  // date/Terms combination that keeps missing are still worth its own pause.
  'GET /api/auth/google/start': null, 'POST /api/account/google/start': null,
  'GET /api/auth/google/callback': 'google',
  'POST /api/register/google': 'google-signup',
  'DELETE /api/account/google': null
};

// Which address the throttle counts against. Unlike clientIp() above, which only labels a log
// line, this decides who is refused, so a header is believed only when TRUST_PROXY says the API
// sits behind a proxy that sets it. X-Forwarded-For is read from the right: the last entry is
// the one the trusted proxy added, anything before it is whatever the client claimed. An IPv6
// client is counted by its /64, which is what one household or one VPS is handed — counting the
// full address would give an attacker 2^64 fresh starts.
function limitAddress(req) {
  const sock = String(req.socket?.remoteAddress || '');
  let raw = sock;
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    raw = String(req.headers['cf-connecting-ip'] || '').trim() || xff[xff.length - 1]
      || String(req.headers['x-real-ip'] || '').trim() || sock;
  }
  raw = raw.replace(/^\[|\]$/g, '');
  const g = ipv6Groups(raw.toLowerCase());
  if (g) {
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : 'unknown';
}
function tooMany(res, secs) {
  json(res, 429, { error: 'too many attempts — try again later', code: 'locked', retryAfter: secs }, { 'Retry-After': String(secs) });
}
// Whether the caller's address is paused for `kind`, answering 429 when it is. A route asks this
// again right before the check it guards, with no await in between: the dispatcher asked before
// the body was read, and requests sent at once all pass that one together.
function addressPaused(req, res, kind) {
  const wait = ADDR_FAILS.retryAfter(kind + '|' + limitAddress(req));
  if (wait) tooMany(res, wait);
  return wait > 0;
}
// One wrong answer against the caller's address. The pause it starts, if any, is recorded once
// — not every refused request after it, which anyone could use to fill the log.
function strikeAddress(req, kind) {
  const lock = ADDR_FAILS.fail(kind + '|' + limitAddress(req));
  if (lock) audit(req, 'auth.throttled', { ok: false, msg: kind });
}

/* ---------- password sign-in (#118) ---------- */
// Optional, per instance (PASSWORD_LOGIN) and per profile: nobody has a password until they set
// one. Passkeys stay the default and the recommended way in. What a password needs that a
// passkey does not — hashing, a policy, the throttle above, a reset an admin can hand out — lives
// in password.js and rate-limit.js; the routes are here because they share the session, invite
// and audit machinery of the passkey routes.
//
// The name someone signs in with is their profile name, compared the way nameKey() folds it.
// Profile names were never unique, so the rule is narrower than that: no two profiles *with a
// password* may share a name. Setting one is refused while the name is taken that way, which is
// also re-checked after every await, where another request could have taken it meanwhile.
//
// An unused reset code holds its profile's name too. The reset has already removed the old
// password, and a name another profile took in the meantime would make the code impossible to
// redeem — there is no rename — and leave that profile locked out. Sign-in itself only ever
// looks at profiles that have a password (passwordHolder).
const hasPassword = u => !!(u && u.pw && typeof u.pw.h === 'string');
// A password that counts for anything: one the instance still lets people sign in with. With
// PASSWORD_LOGIN off, a password kept from when it was on neither signs in nor proves anything
// (proveOwner), and does not keep a profile's last passkey in place.
const passwordWayIn = u => PASSWORD_LOGIN && hasPassword(u);
async function passwordHolder(k) {
  const users = await getAllUsers(pool);
  return users.find(u => hasPassword(u) && nameKey(u.name) === k) || null;
}
const holdsName = u => hasPassword(u) || !!(u.pwReset && u.pwReset.exp > Date.now());
// An e-mail is a second name to sign in with (see "e-mail sign-in" below), so a name is also
// taken by another profile's e-mail — only ever relevant for a name with an "@" in it.
async function nameTaken(name, exceptId) {
  const k = nameKey(name);
  const users = await getAllUsers(pool);
  return users.some(u => u.id !== exceptId && ((holdsName(u) && nameKey(u.name) === k) || u.email === k));
}

/* ---------- e-mail sign-in (ISO-1596) ----------
   `u.email` is a single field, one per profile: the verified address ISO-1397 gave every profile
   (confirmed by a mailed link, the one way back in once every passkey is lost — see "verified
   e-mail + recovery" below). Before this pass, PASSWORD_LOGIN on made `POST /api/account/email`
   and this field mean something else instead — an unverified second name to type at password
   sign-in, never mailed to, colliding with the ISO-1397 address at the same column and the same
   route. That split is gone: with PASSWORD_LOGIN on or off, `u.email` is always the verified
   address, set the same way (POST /api/account/email in emailRoutes below, proof required, a
   confirmation mailed) and exposed the same way (GET /api/me). An address an old deploy saved
   while the split still existed is not lost — it reads back as this account's e-mail, simply unverified
   (email_verified_at was already nullable for exactly this case) until its owner confirms it or
   changes it.

   What password sign-in adds to that one field: it becomes a second identifier next to the
   profile name (loginTarget below looks up an "@" as an address first, then falls back to a
   name), and the current password is accepted as proof of owning it (proveOwner) the same as any
   other change to how the account is reached. Signing in with it needs no confirmation — the
   password is the proof — so an unconfirmed address still signs in; only the "confirm your
   e-mail" banner (GET /api/me's emailVerified) is affected. It is unique across every profile,
   and no profile's address may be another password-holding profile's name (nameTaken above says
   the same the other way round), so an identifier never points at two accounts. Wrong passwords
   count against the account the identifier resolves to, so switching between name and address
   does not reset the pause (see "What a password gives up" in SELF_HOSTING.md). */
async function emailHolder(e) {
  const users = await getAllUsers(pool);
  return users.find(u => hasPassword(u) && u.email === e) || null;
}
async function emailTaken(e, exceptId) {
  const users = await getAllUsers(pool);
  return users.some(u => u.id !== exceptId && (u.email === e || (holdsName(u) && nameKey(u.name) === e)));
}
const EMAIL_ERRORS = {
  invalid: { error: 'that is not an e-mail address', code: 'email-invalid' },
  taken: { error: 'another profile already uses this e-mail address', code: 'email-taken' }
};
// ISO-1390: a signup accepts the Terms of Use and the Privacy Policy, and the acceptance is bound
// to the text the person could actually read — the copy bundled with the app, whose version the
// app sends as `termsVersion`. The server records the version, so it has to be the one in force:
// anything else is refused rather than stored as an acceptance of a text nobody showed. Two codes,
// because the two cases want different words from the app: nothing at all (`terms-required`), a
// different version an app built before the texts changed (`terms-version-stale`). A current app
// never sends nothing — its forms will not submit unticked — so `terms-required` here only reaches
// a bundle from before ISO-1390, which shows the message as it stands: an update is its way
// forward too, and the words say so rather than ask it to tick a box it does not have.
function termsVersionProblem(body) {
  const v = body.termsVersion;
  if (v === LEGAL_VERSION) return null;
  if (typeof v !== 'string' || !v.trim()) return { status: 400, error: 'update the app to accept the terms', code: 'terms-required' };
  return { status: 400, error: 'these terms are not the current ones — update the app', code: 'terms-version-stale' };
}
// A birth date as the signup form sends it: plain YYYY-MM-DD, not in the future, not absurdly old
// (130 years catches a fat-fingered year without hard-coding the under-18 rule below, which is
// its own, separate check). Rejects anything the round trip through Date doesn't echo back
// exactly (an out-of-range day like 2024-02-30), rather than letting JS's date math quietly roll
// it over.
function parseBirthDate(raw) {
  const s = text(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  if (d.getTime() > Date.now() || Date.now() - d.getTime() > 130 * 365.25 * 86400000) return null;
  return s;
}
// Whole years as of right now, from a date parseBirthDate has already validated — same rule as
// frontend/src/lib/age.js's ageFromBirthDate (UTC calendar dates, "already had the birthday this
// year or not"), kept in parallel rather than imported since api/ and frontend/ are separate
// packages (CLAUDE.md's dependency-light constraint; see that file's own header comment for the
// other half of this cross-reference).
function ageFromBirthDate(birthDate) {
  const [y, mo, d] = birthDate.split('-').map(Number);
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const hadBirthdayThisYear = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) >= Date.UTC(now.getUTCFullYear(), mo - 1, d);
  if (!hadBirthdayThisYear) age--;
  return age;
}
// ISO-1521 (Decision 18/10/2026, ISO-1390): replaces ISO-1386/1398's "ask, never block" — a birth
// date is now required at signup, and under 18 is refused outright. Checked right after the terms
// in both /api/register/options and /api/register/password, before anything that spends an
// address- or invite-guess budget (addressPaused/strikeAddress, the invite check): a signup that
// can never go through should not get to spend either, the same reasoning as termsVersionProblem
// above. Existing accounts are untouched — this is signup-time only. Returns null on success.
function birthDateProblem(body) {
  const hasBirthDate = body.birthDate != null && text(body.birthDate).trim() !== '';
  if (!hasBirthDate) return { status: 400, error: 'a birth date is required', code: 'birth-date-required' };
  const birthDate = parseBirthDate(body.birthDate);
  if (!birthDate) return { status: 400, error: 'that is not a date', code: 'birth-date-invalid' };
  if (ageFromBirthDate(birthDate) < 18) return { status: 400, error: 'Brilhart Fitness is for people 18 and older', code: 'underage' };
  return null;
}
// Who a sign-in body names: `identifier` (what the app sends), `name` (what it sent before, and
// what older clients still send — an address typed there works too) or `email` (only an address).
// `key` is what wrong passwords are counted against: the account when there is one, otherwise the
// identifier as folded, so an unknown one is paused exactly like a known one.
async function loginTarget(body) {
  const onlyEmail = body.identifier === undefined && body.name === undefined;
  const k = nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
  if (!k) return null;
  const resolve = async () => (k.includes('@') ? await emailHolder(k) : null) || (onlyEmail ? null : await passwordHolder(k));
  const user = await resolve();
  return { k, user, resolve, email: k.includes('@'), key: user ? acctKey(user) : 'id:' + k };
}
const acctKey = u => 'acct:' + u.id;
const passkeyCount = u => countPasskeys(pool, u.id);
const publicUser = u => ({ id: u.id, name: u.name, admin: isAdmin(u) });
const POLICY_ERRORS = {
  'too-short': `the password needs at least ${MIN_LENGTH} characters`,
  'too-long': `the password can have at most ${MAX_LENGTH} characters`,
  'too-common': 'this password is too easy to guess'
};
const policyError = (res, problem) => json(res, 400, { error: POLICY_ERRORS[problem], code: problem });
const WRONG = { error: 'wrong e-mail or password', code: 'bad-credentials' };

// A new password ends every other session of the account, the way "sign out everywhere" does,
// pending pairing codes and device links included; the caller's own is re-issued by the route.
// Always a new record, never an edit of the old one: a check still running against the old one
// tells the two apart by that (see POST /api/login/password). Named apart from store.js's
// setPassword, which this calls — that one is just the users-table write, this is everything a
// route setting a new password needs done. Mutates `user` in place (for the rest of the caller's
// handler — publicUser(user), sessionCookie(user) — to see the new state without a re-fetch) the
// same way the file-backed version did, even though `user` is a snapshot now, not a live
// reference: nothing else holds this particular object.
async function changePassword(user, h) {
  const set = new Date().toISOString();
  await setPassword(pool, user.id, { h, set });
  user.pw = { h, set };
  delete user.pwReset;
  user.sv = await bumpSessionVersion(pool, user.id);
  for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
  await dropDeviceLinks(pool, user.id);
}

// A passkey assertion made just now by the signed-in account itself — how someone who has no
// password yet proves it is them before setting one. A session alone is not enough for that:
// it may be a cookie someone walked off with, and a password would turn it into a way in that
// outlives "sign out everywhere". Same ceremony as /api/login/verify, and the credential has
// to belong to this account.
async function passkeyStepUp(user, body) {
  const c = takeChallenge(body.cid);
  const cred = c?.kind === 'login' && await getPasskeyById(pool, body.credential?.id);
  if (!cred || cred.userId !== user.id) return false;
  try {
    const v = await verifyAuthenticationResponse({
      response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: { id: cred.id, publicKey: b64uToBuf(cred.publicKey), counter: cred.counter, transports: cred.transports }
    });
    if (!v.verified) return false;
    await touchPasskeyUse(pool, cred.id, v.authenticationInfo.newCounter);
    return true;
  } catch { return false; }
}

// One password check against the account key `k` (loginTarget), counted as a failure for it and for the caller's
// address before it runs, so that checks sent side by side cannot all start under the same
// allowance (see the throttle above). Answers 429 itself and returns null when either is paused.
// The caller settles it once: failed() for a wrong password, ok() for a right one, void() when the
// answer says nothing against the password — the queue was full, the account is disabled, or the
// password changed while it was being checked.
function passwordAttempt(req, res, k) {
  const addr = 'password|' + limitAddress(req);
  const wait = ACCOUNT_FAILS.retryAfter(k) || ADDR_FAILS.retryAfter(addr);
  if (wait) { tooMany(res, wait); return null; }
  const byName = ACCOUNT_FAILS.attempt(k);
  const byAddr = ADDR_FAILS.attempt(addr);
  const settle = () => { byName.undo(); byAddr.undo(); };
  return {
    // Every slot and the queue behind them taken (BusyError) is not a wrong password.
    async verify(pw, stored) {
      // Longer than any password that can be set: wrong, without hashing a megabyte to find out.
      try { return passwordLength(pw) <= MAX_LENGTH && await verifyPassword(pw, stored); }
      catch (e) { settle(); throw e; }
    },
    // The audit line names the account only when there is one — what someone typed into the
    // name field is sometimes their password. `ev`/`act` are for a password that was not a
    // sign-in at all: the current one, proving a change (proveOwner) is logged as that change.
    failed(user, msg, unknown = 'unknown-name', { ev = 'auth.password.fail', act } = {}) {
      audit(req, ev, user ? { ok: false, user, msg, act } : { ok: false, msg: unknown, act });
      if (byName.lock) audit(req, 'auth.password.locked', user ? { ok: false, user } : { ok: false, msg: unknown });
      if (byAddr.lock) audit(req, 'auth.throttled', { ok: false, msg: 'password' });
    },
    // A right password starts the name over; the address keeps whatever else it has run up.
    ok() { ACCOUNT_FAILS.clear(k); byAddr.undo(); },
    void: settle
  };
}

// Proof that whoever holds this session is the account's owner right now, for the changes that
// add or take away a lasting way in — setting a password, adding a passkey, making a device link,
// removing a passkey or the password. A session on its own is not enough for those: it may be a
// cookie someone walked off with. An addition would outlive "sign out everywhere"; a removal
// would let whoever holds the cookie choose which of the owner's ways in is left — an old
// security key rather than the phone the owner carries — or take away the password that signs
// them in where passkeys do not work.
//
// Either a passkey assertion made for this request (`cid` from /api/login/options, `credential`
// signed by one of this account's passkeys), or the current password — only while the instance
// offers password sign-in. With PASSWORD_LOGIN off, a password kept from when it was on is a
// secret nothing else checks any more, possibly an old or reused one, so it proves nothing either:
// a stolen cookie and a guessed password must not add a passkey on an instance that switched
// passwords off. A profile that only ever had a password is moved onto a passkey while the flag
// is still on (docs/SELF_HOSTING.md). Answers the refusal itself and returns null, or says which
// proof it was ('passkey' | 'password'). Wrong passwords count toward the sign-in pause.
// `act` names the change being confirmed ('email', 'password-set', 'passkey-remove', …): a failed
// proof is logged as `auth.proof.fail` for that change, not as a failed sign-in — the owner was
// signed in all along, and "Password sign-in failed" sent an admin looking for the wrong thing.
async function proveOwner(req, res, user, body, act) {
  if (body.credential) {
    if (await passkeyStepUp(user, body)) return 'passkey';
    audit(req, 'auth.proof.fail', { ok: false, user, msg: 'step-up-failed', act });
    json(res, 403, { error: 'the passkey could not be verified', code: 'passkey' });
    return null;
  }
  // The third proof (ISO-1597 addendum): a one-time token GET /api/auth/google/callback minted
  // after an intent=reauth round trip confirmed the same Google identity already linked to this
  // account. Bound to the account *and* the exact session that started the reauth (sid) — a proof
  // made for one browser tab must not confirm an action typed into a different, stolen session.
  if (typeof body.googleProof === 'string' && body.googleProof) {
    const s = await sessionOf(req);
    const p = takeReauthProof(body.googleProof);
    if (!p || !s || p.uid !== user.id || p.sid !== s.sid) {
      audit(req, 'auth.proof.fail', { ok: false, user, msg: 'google-proof-invalid', act });
      json(res, 403, { error: 'reauthenticate with Google first', code: 'google-proof-invalid' });
      return null;
    }
    return 'google';
  }
  if (!passwordWayIn(user)) {
    json(res, 403, { error: 'confirm with your passkey first', code: 'passkey-required' });
    return null;
  }
  const current = typeof body.current === 'string' ? body.current : '';
  const wrongCurrent = () => { json(res, 403, { error: 'your current password is not right', code: 'current-wrong' }); return null; };
  if (!current) {
    json(res, 403, { error: 'enter your current password', code: 'current-required' });
    return null;
  }
  const check = passwordAttempt(req, res, acctKey(user));
  if (!check) return null;
  const rec = user.pw;
  if (!(await check.verify(current, rec.h))) {
    check.failed(user, 'bad-current', undefined, { ev: 'auth.proof.fail', act });
    return wrongCurrent();
  }
  // Changed or removed while it was being checked: it is no longer the current password.
  if (user.pw !== rec) { check.void(); return wrongCurrent(); }
  check.ok();
  return 'password';
}

if (PASSWORD_LOGIN) warmUp();

const passwordRoutes = {
  'POST /api/login/password': async (req, res) => {
    const body = await readBody(req);
    const target = await loginTarget(body);
    const pw = typeof body.password === 'string' ? body.password : '';
    if (!target || !pw) return json(res, 400, { error: 'name and password required', code: 'missing' });
    const check = passwordAttempt(req, res, target.key);
    if (!check) return;
    const { user } = target;
    const rec = user?.pw;
    if (!(await check.verify(pw, rec?.h))) {
      check.failed(user, 'bad-password', target.email ? 'unknown-email' : 'unknown-name');
      return json(res, 401, WRONG);
    }
    // Right for the password read before the await — which a change, an admin reset or a removal
    // may have replaced since (each puts a new record in user.pw or none; only a rehash edits it
    // in place). A session signed now would carry the account's *new* session version and outlive
    // the "signed out everywhere" that came with it, so the old password gets nothing; it is not
    // counted as a wrong one either. Resolves to the fresh row rather than a boolean, so the rest
    // of the handler reads `disabled` and everything else off data from after the await too — under
    // db.json `user` was a live reference and picked up a concurrent disable/change on its own;
    // every read here is its own row now, so nothing past this point may still use the stale `user`.
    const stillHas = async h => {
      const fresh = await target.resolve();
      return fresh?.id === user.id && hasPassword(fresh) && fresh.pw.h === h ? fresh : null;
    };
    let fresh = await stillHas(rec.h);
    if (!fresh) {
      check.void();
      return json(res, 401, WRONG);
    }
    if (fresh.disabled) {
      check.void();
      audit(req, 'auth.password.fail', { ok: false, user: fresh, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
    }
    check.ok();
    // A hash made with older parameters is replaced now, while the password is at hand.
    if (needsRehash(rec.h)) {
      let h;
      try {
        h = await hashPassword(pw);
        if (await stillHas(rec.h)) await rehashPassword(pool, user.id, h);
      } catch (e) { if (!(e instanceof BusyError)) throw e; }
      // The same question again: the password may have changed while the new hash was made. If
      // the rehash write above never happened (stillHas(rec.h) was already false, or hashPassword
      // itself threw BusyError), the stored hash is still rec.h, not h (possibly still undefined),
      // and this correctly fails the same way either way.
      fresh = h ? await stillHas(h) : null;
      if (!fresh) return json(res, 401, WRONG);
    }
    audit(req, 'auth.password.ok', { user: fresh });
    json(res, 200, { user: publicUser(fresh) }, { 'Set-Cookie': await sessionCookie(fresh, req.headers['user-agent']) });
  },

  // For browsers that cannot make a passkey at all: plain http on a LAN address, some Firefox
  // setups. Same invite rules as /api/register/*, checked again and burned after the hash.
  'POST /api/register/password': async (req, res) => {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required', code: 'missing' });
    // ISO-1390: same rule and same place as /api/register/options — before the invite check and
    // the hash, so an outdated app is told so without spending either.
    const termsProblem = termsVersionProblem(body);
    if (termsProblem) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: termsProblem.code });
      return json(res, termsProblem.status, { error: termsProblem.error, code: termsProblem.code });
    }
    // ISO-1521: same rule and same place as /api/register/options — right after the terms,
    // before the invite-guess budget below gets spent on a signup that could never go through.
    const birthProblem = birthDateProblem(body);
    if (birthProblem) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: birthProblem.code });
      return json(res, birthProblem.status, { error: birthProblem.error, code: birthProblem.code });
    }
    const birthDate = parseBirthDate(body.birthDate);
    const code = text(body.code).trim().toUpperCase();
    if (INVITE_ONLY && addressPaused(req, res, 'signup')) return;
    if (INVITE_ONLY && !(await inviteIsValid(pool, code))) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      strikeAddress(req, 'signup');
      return json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
    }
    const problem = passwordProblem(body.password, name);
    if (problem) return policyError(res, problem);
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (await nameTaken(name)) return taken();
    // ISO-1596: a password signup needs a valid, unique e-mail too now — the same requirement
    // register/options has had for passkey signup since ISO-1397, confirmed by the same mailed
    // link. Checked after the invite gate, same place the optional address used to be checked, so
    // on an invite-only instance a guess with no valid code still learns nothing about addresses.
    const email = normalizeEmail(body.email);
    if (!email) return json(res, 400, EMAIL_ERRORS.invalid);
    const emailRefused = () => {
      strikeAddress(req, 'email');
      audit(req, 'auth.register.fail', { ok: false, name, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    };
    if (addressPaused(req, res, 'email')) return;
    if (await emailTaken(email)) return emailRefused();
    const h = await hashPassword(body.password);
    // Re-checked once more right before the insert: everything since the first nameTaken/
    // emailTaken awaited (the invite check, the hash), and a second request could have landed.
    if (INVITE_ONLY && !(await inviteIsValid(pool, code))) {
      audit(req, 'auth.register.fail', { ok: false, name, msg: 'invite-invalid' });
      return json(res, 403, { error: 'invite code is no longer valid — ask for a new one', code: 'invite' });
    }
    if (await nameTaken(name)) return taken();
    if (await emailTaken(email)) return emailRefused();
    const created = new Date().toISOString();
    const user = {
      id: crypto.randomBytes(12).toString('base64url'), name, created, pw: { h, set: created }, email, birthDate,
      // ISO-1390: termsVersionProblem() above already pinned body.termsVersion to LEGAL_VERSION.
      termsAcceptedVersion: LEGAL_VERSION, termsAcceptedAt: created
    };
    if (INVITE_ONLY) user.invitedBy = code;
    // ISO-1397/ISO-1596: a confirmation token is minted in the same transaction as the account,
    // same reasoning as POST /api/register/verify (see that route) — a password signup never
    // exists without one to confirm either. The mail itself goes out after commit, below.
    const verifyToken = makeEmailToken();
    // createUser, consumeInvite and the token all commit or fail together: an invite consumed by
    // a request whose user row then never landed (the unique-name/e-mail race below) would be
    // burned for nothing, and a user row created on top of an invite another request consumed
    // first (InviteRaceError) has to be undone, not left behind with no invite to show for it.
    // createUser's own UNIQUE constraint on email is the actual backstop if two requests still
    // land together on that.
    try {
      await withTransaction(pool, async client => {
        await createUser(client, user);
        if (INVITE_ONLY && !(await consumeInvite(client, code, user.id))) throw new InviteRaceError();
        await createEmailToken(client, user.id, 'verify', hashEmailToken(verifyToken), VERIFY_TTL_MS);
      });
    } catch (e) {
      if (e instanceof InviteRaceError) {
        audit(req, 'auth.register.fail', { ok: false, name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid — ask for a new one', code: 'invite' });
      }
      if (e.code === '23505') return emailRefused(); // unique_violation
      throw e;
    }
    audit(req, 'auth.register.ok', { user, msg: INVITE_ONLY ? code + ' · password' : 'password' });
    await mailVerification(user, verifyToken);
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': await sessionCookie(user, req.headers['user-agent']) });
  },

  // What Settings shows: whether a password is set, and whether it could be removed.
  'GET /api/account/password': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, {
      set: hasPassword(user), setAt: user.pw?.set || null, passkeys: await passkeyCount(user),
      name: user.name, nameTaken: await nameTaken(user.name, user.id),
      // Only the owner's own session is ever handed their address.
      email: user.email || null
    });
  },

  // Set or change. Proof first: the current password when there is one, or a passkey assertion
  // made for this request (which is also how a forgotten password is replaced by its owner).
  'POST /api/account/password': async (req, res) => {
    const s = await sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const body = await readBody(req);
    const problem = passwordProblem(body.next, user.name);
    if (problem) return policyError(res, problem);
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (await nameTaken(user.name, user.id)) return taken();
    const proof = await proveOwner(req, res, user, body, 'password');
    if (!proof) return;
    const h = await hashPassword(body.next);
    // Everything above awaited: an admin reset, a disable or "sign out everywhere" may have ended
    // this session in the meantime, and a password set now would outlive that.
    if (!(await sessionStillValid(req, user))) return json(res, 401, { error: 'not signed in' });
    if (await nameTaken(user.name, user.id)) return taken();
    const first = !hasPassword(user);
    await changePassword(user, h);
    // Whatever pause wrong guesses put on this account was about a password that no longer exists.
    ACCOUNT_FAILS.clear(acctKey(user));
    audit(req, first ? 'auth.password.set' : 'auth.password.change', { user, msg: proof });
    // This session carries on under the new version: a new cookie, or a new token for a phone.
    if (s.bearer) return json(res, 200, { ok: true, token: await makeSession(user, req.headers['user-agent']) });
    json(res, 200, { ok: true }, { 'Set-Cookie': await sessionCookie(user, req.headers['user-agent']) });
  },

  // Never the last way in: a profile with no passkey keeps its password, because nothing else
  // could sign it in again. Same proof as setting one (proveOwner) — the password itself, or a
  // passkey assertion made for this request — asked only once the removal could go ahead, so a
  // refusal the profile's state already decides spends no passkey prompt and no password check.
  // Existing sessions are left alone; "sign out everywhere" ends them.
  'DELETE /api/account/password': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const lastWayIn = () => json(res, 409, { error: 'the password is the only way into this profile', code: 'last-way-in' });
    if (!hasPassword(user)) return json(res, 200, { ok: true });
    if (!(await passkeyCount(user)) && !(await hasGoogle(user))) return lastWayIn();
    const proof = await proveOwner(req, res, user, body, 'password-remove');
    if (!proof) return;
    // Everything above awaited: the session may have ended, and the profile's last passkey (or
    // its Google identity) may have been removed by a request that ran alongside this one.
    // sessionStillValid re-checks the session itself; removePasswordUnlessLast re-checks (and acts
    // on) the password/passkey/Google count atomically, under the same per-account lock a
    // concurrent passkey or Google removal takes (ISO-1592, extended ISO-1597) — the two checks
    // above are only a cheap pre-proof filter, not the real decision.
    const fresh = await sessionStillValid(req, user);
    if (!fresh) return json(res, 401, { error: 'not signed in' });
    const r = await removePasswordUnlessLast(pool, fresh.id, GOOGLE_LOGIN);
    if (r.error) return lastWayIn();
    audit(req, 'auth.password.remove', { user: fresh });
    json(res, 200, { ok: true });
  },

  // An admin hands out a one-time code; the person redeems it below with a password of their
  // choosing. Issuing it ends the old password and every session of the account at once: a
  // reset is asked for when access is lost or in doubt, and a password someone else may know
  // should not keep working for the day the code is valid. Passkeys are left alone. The code is
  // shown once and stored only as a hash. Admin accounts are refused, as they are by disable —
  // one admin must not be able to take over another's login.
  'POST /api/admin/user/password-reset': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = await getUserById(pool, body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'an admin sets their own password in Settings' });
    if (await nameTaken(u.name, u.id)) return json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    const code = makeResetCode();
    const exp = Date.now() + RESET_TTL_MS;
    await setPasswordReset(pool, u.id, { h: hashResetCode(code), exp, by: admin.id });
    u.sv = await bumpSessionVersion(pool, u.id);
    for (const [k, v] of pairings) if (v.uid === u.id) pairings.delete(k);
    await dropDeviceLinks(pool, u.id);
    presence.delete(u.id);
    audit(req, 'admin.password.reset', { user: admin, target: u });
    json(res, 200, { ok: true, name: u.name, code, expires: exp });
  },

  'POST /api/login/password-reset': async (req, res) => {
    const body = await readBody(req);
    // The name or the e-mail, in the same fields sign-in takes them (loginTarget).
    const k = nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
    const code = text(body.code).slice(0, 64);
    if (!k || !code) return json(res, 400, { error: 'name and code required', code: 'missing' });
    // Wrong codes count against the address only. A per-name pause would add nothing against a
    // 60-bit code that lives a day, and would let anyone who knows the name keep the real code
    // refused for that whole day — after the reset has already removed the old password.
    if (addressPaused(req, res, 'password')) return;
    const find = async () => {
      const users = await getAllUsers(pool);
      return users.find(u => u.pwReset && (nameKey(u.name) === k || u.email === k) && resetCodeMatches(code, u.pwReset)) || null;
    };
    const user = await find();
    const invalid = () => json(res, 400, { error: 'that reset code is wrong or has expired', code: 'reset-invalid' });
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (!user) {
      strikeAddress(req, 'password');
      audit(req, 'auth.password.reset', { ok: false, msg: 'reset-invalid' });
      return invalid();
    }
    if (user.disabled) {
      audit(req, 'auth.password.reset', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
    }
    // The code is good and stays good until a password is actually set with it.
    const problem = passwordProblem(body.next, user.name);
    if (problem) return policyError(res, problem);
    if (await nameTaken(user.name, user.id)) return taken();
    const h = await hashPassword(body.next);
    // Single use: a second request that raced this one through the hash finds the code gone.
    if ((await find())?.id !== user.id) return invalid();
    if (await nameTaken(user.name, user.id)) return taken();
    await changePassword(user, h);
    ACCOUNT_FAILS.clear(acctKey(user));
    audit(req, 'auth.password.reset', { user });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': await sessionCookie(user, req.headers['user-agent']) });
  }
};

/* ---------- more than one passkey, and one-time device links (#95) ---------- */
// A passkey lives where it was made — Windows Hello on one PC, one phone's keychain, one security
// key — so a profile that only had the passkey it was created with could not be reached from a
// second device, and "Create profile" there made a new, empty one. Two ways to add another:
//
//   Settings → Passkeys → Add: a registration ceremony in the signed-in browser, for any other
//   authenticator it can reach — a security key, a password manager, a phone through the
//   browser's own QR prompt.
//
//   A device link: the signed-in device shows a one-time code (device-link.js), and the other
//   device redeems it by creating a passkey of its own, which is what then signs it in. The code
//   never opens a session by itself: whoever redeems it leaves a passkey on the profile, listed
//   in Settings where the owner sees it and can remove it.
//
// Either way the new passkey is a way into the profile that outlives "sign out everywhere", so
// both ask for the proof a first password does (proveOwner). So does removing one: a stolen
// cookie must not choose which of the owner's passkeys is left. Removing one never leaves a
// profile without a way in: its last passkey stays unless a password can sign in instead.
//
// Sessions are not tied to the passkey that opened them — a session is `uid:expiry:version`,
// nothing more — so removing a passkey stops it signing in again but does not end a session it
// already opened. "Sign out everywhere" does that, and Settings says so where a passkey is removed.
// Whether GOOGLE_LOGIN is on and this account currently has a linked Google identity — the
// Google-counts-as-a-way-in half of passwordWayIn's own rule (ISO-1597): a server setting
// (GOOGLE_LOGIN) the caller may read from before any await, account data (the identity row) read
// fresh at the call site, same split passwordWayIn/hasLivePassword keep.
async function hasGoogle(user) {
  return GOOGLE_LOGIN && !!(await findOAuthIdentityByUser(pool, 'google', user.id));
}
const passkeyState = async u => {
  const passkeys = await listPasskeys(pool, u.id);
  // `password`: whether the password can confirm an addition or a removal (proveOwner) — only
  // while password sign-in is on. `lastWayIn`: whether removing any one passkey would be refused.
  const otherWayIn = passwordWayIn(u) || await hasGoogle(u);
  return { passkeys, password: passwordWayIn(u), lastWayIn: passkeys.length + (otherWayIn ? 1 : 0) <= 1 };
};
const LIMIT = { error: `a profile can have at most ${MAX_PASSKEYS} passkeys`, code: 'passkey-limit' };
const LINK_INVALID = { error: 'that code is wrong, used or expired', code: 'link-invalid' };
const notSignedIn = res => json(res, 401, { error: 'not signed in' });

// Creation options for another passkey of `user`. The user handle is the profile's id, exactly as
// at sign-up, so an authenticator files the new passkey under the same account; the passkeys the
// profile has already are excluded, so an authenticator that holds one of them says so instead of
// making a second.
const moreOptions = async user => {
  const mine = await listPasskeys(pool, user.id);
  return generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID,
    userID: Buffer.from(user.id), userName: user.name, userDisplayName: user.name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: mine.map(c => ({ id: c.id, transports: c.transports || [] }))
  });
};

// The second half of either ceremony: the new passkey as a candidate row (not yet inserted), or
// null once the refusal has been answered and audited as `ev`.
async function newPasskey(req, res, c, body, ev, user) {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      requireUserVerification: false
    });
  } catch (e) {
    // e.message can echo attacker-supplied response fields, so only the reason code is kept.
    audit(req, ev, { ok: false, user, msg: 'verify-error' });
    json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
    return null;
  }
  if (!verification.verified) {
    audit(req, ev, { ok: false, user, msg: 'not-verified' });
    json(res, 400, { error: 'not verified' });
    return null;
  }
  const { credential } = verification.registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter || 0,
    transports: body.credential?.response?.transports,
    name: body.name
  };
}

const passkeyRoutes = {
  'GET /api/account/passkeys': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    json(res, 200, await passkeyState(user));
  },

  // Adding one from Settings, step one: the proof, then the options. The proof is spent here; the
  // challenge that comes back is good for five minutes, for this profile, under this session
  // version — "sign out everywhere" in between ends the ceremony with everything else.
  'POST /api/account/passkeys/options': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if ((await passkeyCount(user)) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const proof = await proveOwner(req, res, user, body, 'passkey-add');
    if (!proof) return;
    // Awaited: a sign-out everywhere, a disable or an admin reset may have ended this session.
    if (!(await sessionStillValid(req, user))) return notSignedIn(res);
    const options = await moreOptions(user);
    const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'add', sv: sessionVersion(user), proof });
    json(res, 200, { cid, options });
  },

  'POST /api/account/passkeys/verify': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const c = takeChallenge(text(body.cid));
    if (!c || c.kind !== 'add' || c.uid !== user.id) {
      audit(req, 'auth.passkey.fail', { ok: false, user, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    const cred = await newPasskey(req, res, c, body, 'auth.passkey.fail', user);
    if (!cred) return;
    if (!(await sessionStillValid(req, user, c.sv))) return notSignedIn(res);
    const added = await insertPasskey(pool, user.id, cred);
    if (added.error) {
      audit(req, 'auth.passkey.fail', { ok: false, user, msg: added.code });
      return json(res, 409, { error: added.error, code: added.code });
    }
    audit(req, 'auth.passkey.add', { user, msg: c.proof });
    json(res, 200, { ok: true, ...(await passkeyState(user)) });
  },

  'POST /api/account/passkeys/rename': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const r = await renamePasskey(pool, user.id, text(body.id), body.name);
    if (r.error) return json(res, 404, { error: r.error, code: r.code });
    json(res, 200, { ok: true, ...(await passkeyState(user)) });
  },

  // `?id=` — the credential id from the list; the body carries the same proof adding one takes
  // (proveOwner), asked only once the removal could go ahead, so a refusal the list already
  // decides spends no passkey prompt and no password check — passwordWayIn(user) here is only
  // that cheap pre-proof filter, safe to read from the pre-proof snapshot since a stale answer
  // costs at most an unnecessary prompt. The last one is never removed: removePasskey decides
  // again after the proof, atomically and against live data (PASSWORD_LOGIN is config, not
  // account data, so it's passed straight through; whether a password currently exists is read
  // fresh inside the lock) — a request running alongside may have removed the password or another
  // passkey meanwhile (ISO-1592), and passing passwordWayIn(user)'s pre-proof answer in here
  // instead was exactly that bug: a snapshot taken before proveOwner's await, which can run long
  // enough for a concurrent password removal to land in the gap. An unused device code goes with
  // it: a passkey is removed because it is lost or not trusted, and a code made with it just
  // before — by whoever holds it — would otherwise add a fresh one right after.
  'DELETE /api/account/passkeys': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const body = await readBody(req);
    const refuse = r => json(res, r.code === 'last-way-in' ? 409 : 404, { error: r.error, code: r.code });
    const otherWays = (passwordWayIn(user) ? 1 : 0) + (await hasGoogle(user) ? 1 : 0);
    const refused = await passkeyRemovalRefused(pool, user.id, id, otherWays);
    if (refused) return refuse(refused);
    const proof = await proveOwner(req, res, user, body, 'passkey-remove');
    if (!proof) return;
    const fresh = await sessionStillValid(req, user);
    if (!fresh) return notSignedIn(res);
    const r = await removePasskey(pool, fresh.id, id, PASSWORD_LOGIN, GOOGLE_LOGIN);
    if (r.error) return refuse(r);
    await dropDeviceLinks(pool, fresh.id);
    audit(req, 'auth.passkey.remove', { user: fresh, msg: r.row.name || null });
    json(res, 200, { ok: true, ...(await passkeyState(fresh)) });
  },

  // Makes the code another device redeems below. Same proof as adding a passkey here, because the
  // code is how a passkey gets added there.
  'POST /api/account/device-link': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if ((await passkeyCount(user)) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const proof = await proveOwner(req, res, user, body, 'device-link');
    if (!proof) return;
    if (!(await sessionStillValid(req, user))) return notSignedIn(res);
    const { code, link } = await createDeviceLink(pool, user.id);
    audit(req, 'auth.link.create', { user, msg: proof });
    json(res, 200, { code, expires: link.exp });
  },

  // Redeeming, from the other device, which has no session: the code is the credential. Step one
  // checks it and hands back creation options for the profile it belongs to, and that profile's
  // name and id, so the screen can say where this device is being added — and tell it apart from
  // the profile this browser is signed in as by the id, since names are not unique and whoever
  // sends a code chooses the name of theirs. The id is the options' user handle anyway, so it
  // tells the holder of the code nothing new. It does not use the code up —
  // a passkey prompt dismissed by mistake can be tried again — and wrong codes pause the address.
  // Not CSRF-exempt: only the app's own origin can create a passkey for it anyway, and a code
  // redeemed from anywhere else is not one the owner meant to hand over.
  'POST /api/device-link/options': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'link')) return;
    const link = await findDeviceLink(pool, text(body.code));
    if (!link) {
      strikeAddress(req, 'link');
      audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    const user = await getUserById(pool, link.userId);
    if (!user || user.disabled) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'user-unavailable' });
      return json(res, 400, LINK_INVALID);
    }
    if ((await passkeyCount(user)) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const options = await moreOptions(user);
    const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'link', lh: link.h });
    json(res, 200, { cid, options, id: user.id, name: user.name });
  },

  // Step two: the new passkey is stored, the code is burned, and this device is signed in by the
  // passkey it just made — the same cookie a passkey sign-in sets. Of two requests racing with
  // one code, only the one whose DELETE inside the transaction below actually claims the row
  // ever reaches insertPasskey; the other is told the code is gone before it creates anything.
  'POST /api/device-link/verify': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'link')) return;
    const code = text(body.code);
    const c = takeChallenge(text(body.cid));
    const link = await findDeviceLink(pool, code);
    if (!link) {
      strikeAddress(req, 'link');
      audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    if (!c || c.kind !== 'link' || c.lh !== link.h || c.uid !== link.userId) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    const owner = await getUserById(pool, link.userId);
    const cred = await newPasskey(req, res, c, body, 'auth.link.fail', owner || { id: link.userId });
    if (!cred) return;
    // Everything above awaited: the profile may be gone or locked since (a sign-out everywhere,
    // a new password, a disable) — checked fresh, not against `owner` from before the ceremony.
    const user = await getUserById(pool, link.userId);
    if (!user || user.disabled) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    // Redeeming the link is itself a first use, same as the credential this profile signed up
    // with — created and lastUsed together, not left unset until a later sign-in.
    //
    // The burn and the insert commit together, burn first: burning without a passkey to show
    // for it would strand the owner with no code left to retry, so a failed insertPasskey (a
    // colliding credential id) rolls the burn back too, leaving the code usable again. Burning
    // first, rather than after, is what makes the burn the actual single-use gate — a second
    // request racing the same code finds nothing left to claim and never reaches insertPasskey
    // at all, rather than both requests re-checking the link is "still there" (true of both,
    // right up until whichever of them runs its own DELETE second) and both getting in.
    const now = new Date().toISOString();
    let added;
    try {
      await withTransaction(pool, async client => {
        if (!(await burnDeviceLink(client, link.h))) throw new DeviceLinkRaceError();
        added = await insertPasskey(client, user.id, { ...cred, created: now, lastUsed: now });
        if (added.error) throw new HttpError(409, added.error);
      });
    } catch (e) {
      if (e instanceof DeviceLinkRaceError) {
        audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'link-invalid' });
        return json(res, 400, LINK_INVALID);
      }
      if (e instanceof HttpError) {
        audit(req, 'auth.link.fail', { ok: false, user, msg: added.code });
        return json(res, e.status, { error: e.message, code: added.code });
      }
      throw e;
    }
    audit(req, 'auth.link.ok', { user, msg: added.row.name || null });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': await sessionCookie(user, req.headers['user-agent']) });
  }
};

/* ---------- verified e-mail + recovery (ISO-1397, password reset added ISO-1596) ----------
   The HashRouter paths a confirmation or recovery link opens in the app; the API never renders
   either screen, only mints and checks the token. Recovery itself stayed password-less (a fresh
   passkey via the device-link ceremony) until ISO-1596 gave it a second shape, redeemed with a
   password instead — recover/redeem below picks between the two. */
const verifyLink = token => `${APP_URL}/#/verificar-email?token=${encodeURIComponent(token)}`;
const recoverLink = token => `${APP_URL}/#/recuperar?token=${encodeURIComponent(token)}`;

// Sends only — the token itself is already a row by the time either of these runs (register/
// verify creates it inside its own transaction; issueVerification/issueRecovery below create it
// first for every other caller). Never thrown out of a route: a provider outage must cost a
// missing e-mail, not a 500 on an action (a signup, a profile finally getting one) that already
// succeeded on its own.
async function mailVerification(user, token) {
  const { subject, text: body, html } = renderVerifyEmail({ name: user.name, link: verifyLink(token), appUrl: APP_URL });
  try { await sendMail({ to: user.email, subject, text: body, html }); }
  catch (e) { console.error('mail: could not send verification e-mail', e.message); }
}
async function mailRecovery(user, token) {
  const { subject, text: body, html } = renderRecoverEmail({ name: user.name, link: recoverLink(token), appUrl: APP_URL });
  try { await sendMail({ to: user.email, subject, text: body, html }); }
  catch (e) { console.error('mail: could not send recovery e-mail', e.message); }
}
// Mints a fresh 'verify' token (invalidating whichever one was still live) and mails it — "resend"
// and an old account's first POST /api/account/email both just need this, with no transaction of
// their own to fold it into.
async function issueVerification(user) {
  const token = makeEmailToken();
  await createEmailToken(pool, user.id, 'verify', hashEmailToken(token), VERIFY_TTL_MS);
  await mailVerification(user, token);
}

const emailRoutes = {
  // No session: a confirmation link is opened from the mail client, on whatever device that
  // happens to be. The token is the only credential, single-use and 24h — see consumeEmailToken.
  'POST /api/account/email/verify': async (req, res) => {
    const body = await readBody(req);
    const token = text(body.token).trim();
    const invalid = { error: 'that link is invalid or expired', code: 'token-invalid' };
    if (!token) return json(res, 400, invalid);
    if (addressPaused(req, res, 'email-verify')) return;
    const userId = await consumeEmailToken(pool, hashEmailToken(token), 'verify');
    if (!userId) {
      strikeAddress(req, 'email-verify');
      audit(req, 'auth.email.verify.fail', { ok: false, msg: 'token-invalid' });
      return json(res, 400, invalid);
    }
    await markEmailVerified(pool, userId);
    const user = await getUserById(pool, userId);
    audit(req, 'auth.email.verify.ok', { user });
    json(res, 200, { ok: true });
  },

  // The owner, signed in, asking for a new link because the first one expired or never arrived.
  // Shares the 'email-verify' pause with the verify route above: both are "how many times can you
  // poke the confirmation system for this account", from whichever address is doing the poking.
  'POST /api/account/email/resend': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    if (!user.email) return json(res, 400, { error: 'this profile has no e-mail yet', code: 'no-email' });
    if (user.emailVerifiedAt) return json(res, 200, { ok: true, alreadyVerified: true });
    if (addressPaused(req, res, 'email-verify')) return;
    await issueVerification(user);
    audit(req, 'auth.email.resend', { user });
    json(res, 200, { ok: true });
  },

  // An account that never accepted the current terms (imported from db.json, or signed up before
  // the texts changed) accepts them here, signed in (ISO-1390). Same version rule as signup: only
  // the server's LEGAL_VERSION, so an app showing an older text cannot record it as accepted.
  // Idempotent — a second call (a double tap, a retry after a lost response) answers the stored
  // acceptance without rewriting its date or auditing again, so terms_accepted_at stays the moment
  // the person first agreed.
  'POST /api/account/terms/accept': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const termsProblem = termsVersionProblem({ termsVersion: body.version });
    if (termsProblem) return json(res, termsProblem.status, { error: termsProblem.error, code: termsProblem.code });
    if (user.termsAcceptedVersion !== LEGAL_VERSION) {
      await setTermsAccepted(pool, user.id, LEGAL_VERSION, new Date().toISOString());
      audit(req, 'account.terms.accept', { user, msg: LEGAL_VERSION });
    }
    // Read back rather than echo our own timestamp: the answer is what the row actually holds.
    const fresh = await getUserById(pool, user.id);
    json(res, 200, { ok: true, termsVersion: fresh.termsAcceptedVersion, termsAcceptedAt: fresh.termsAcceptedAt });
  },

  // The neutral half of recovery: always 200, with the same body, whether or not `email` names a
  // real account — the one guarantee the issue asks for ("não revela se a conta existe"). Unlike
  // every other guarded route here, a paused address is not told so with a 429 (that would itself
  // be a tell, just a slower one) — it is answered exactly like a miss, below.
  'POST /api/recover/request': async (req, res) => {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const addr = 'recover|' + limitAddress(req);
    if (email && !ADDR_FAILS.retryAfter(addr)) {
      const users = await getAllUsers(pool);
      const user = users.find(u => u.email === email);
      if (user && !user.disabled) {
        const token = makeEmailToken();
        await createEmailToken(pool, user.id, 'recover', hashEmailToken(token), RECOVER_TTL_MS);
        await mailRecovery(user, token);
        audit(req, 'auth.recover.request', { user });
      } else {
        // A guess at an address with no account still counts, the same way an unknown sign-in
        // identifier does (loginTarget) — the pause it can start only ever slows further guessing
        // from this address, and is never what this response says.
        ADDR_FAILS.fail(addr);
        audit(req, 'auth.recover.request', { ok: false, msg: 'unknown-email' });
      }
    }
    json(res, 200, { ok: true });
  },

  // Burns the recovery token and, by default, hands back a device-link code — the same shape
  // POST /api/account/device-link returns — so the client finishes with the device-link pair it
  // already has (device-link.js, /api/device-link/options → /verify) instead of a parallel
  // passkey ceremony of its own.
  //
  // ISO-1596: with PASSWORD_LOGIN on and a `password` in the body, the link sets that password
  // directly instead — "forgot my password, no admin" without a one-time code to hand over. The
  // policy is checked before the token is consumed, so a password this instance refuses never
  // burns an otherwise-good link; the token is still single-use for an actual redemption, same as
  // the device-link path. Ending every other session (changePassword) is the same rule a password
  // change always follows — a reset is asked for when access is in doubt, so an old session is
  // exactly what should not survive it.
  'POST /api/recover/redeem': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'recover')) return;
    const token = text(body.token).trim();
    const invalid = { error: 'that link is invalid or expired', code: 'token-invalid' };
    if (!token) {
      strikeAddress(req, 'recover');
      return json(res, 400, invalid);
    }
    const asPassword = PASSWORD_LOGIN && typeof body.password === 'string' && body.password !== '';
    if (asPassword) {
      const problem = passwordProblem(body.password);
      if (problem) return policyError(res, problem);
    }
    const userId = await consumeEmailToken(pool, hashEmailToken(token), 'recover');
    if (!userId) {
      strikeAddress(req, 'recover');
      audit(req, 'auth.recover.fail', { ok: false, msg: 'token-invalid' });
      return json(res, 400, invalid);
    }
    const user = await getUserById(pool, userId);
    if (!user || user.disabled) {
      audit(req, 'auth.recover.fail', { ok: false, uid: userId, msg: 'user-unavailable' });
      return json(res, 400, invalid);
    }
    if (asPassword) {
      const h = await hashPassword(body.password);
      await changePassword(user, h);
      ACCOUNT_FAILS.clear(acctKey(user));
      audit(req, 'auth.recover.password', { user });
      return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': await sessionCookie(user, req.headers['user-agent']) });
    }
    const { code, link } = await createDeviceLink(pool, user.id);
    audit(req, 'auth.recover.ok', { user });
    json(res, 200, { code, expires: link.exp });
  },

  // Set or change the account's one e-mail — always this handler now, PASSWORD_LOGIN on or off
  // (ISO-1596; see "e-mail sign-in" above for why there used to be two). An account from before
  // ISO-1397 adding the address it never had goes through here exactly like a password-login
  // account changing one: the field, the proof and the mailed confirmation are the same either
  // way. Proof first, same as every other change to how this account may be reached (adding a
  // passkey, a device link): a copied session must not be enough to redirect where recovery
  // goes, or — now that a password can prove it too — to point password sign-in somewhere its
  // owner did not type.
  'POST /api/account/email': async (req, res) => {
    const s = await sessionOf(req);
    if (!s) return notSignedIn(res);
    const { user } = s;
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    if (!email) return json(res, 400, EMAIL_ERRORS.invalid);
    if (email === user.email) return json(res, 200, { ok: true, email, emailVerified: !!user.emailVerifiedAt });
    if (addressPaused(req, res, 'email')) return;
    const proof = await proveOwner(req, res, user, body, 'email');
    if (!proof) return;
    if (!(await sessionStillValid(req, user))) return notSignedIn(res);
    if (addressPaused(req, res, 'email')) return;
    const refuseTaken = () => {
      strikeAddress(req, 'email');
      audit(req, 'auth.email.fail', { ok: false, user, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    };
    if (await emailTaken(email, user.id)) return refuseTaken();
    const first = !user.email;
    try {
      await setEmail(pool, user.id, email);
    } catch (e) {
      if (e.code === '23505') return refuseTaken(); // unique_violation — lost a race to another request
      throw e;
    }
    user.email = email;
    delete user.emailVerifiedAt;
    audit(req, first ? 'auth.email.set' : 'auth.email.change', { user, msg: proof + ' · ' + maskEmail(email) });
    await issueVerification(user);
    json(res, 200, { ok: true, email });
  }
};

/* ---------- "Sign in with Google" (OpenID Connect, ISO-1597) ----------
 * Authorization code + PKCE (S256), `state` and `nonce` — oauth-google.js (discovery, JWKS
 * caching, ID token verification) holds the OIDC mechanics; everything account-shaped is here,
 * same split as password.js/device-link.js keep for their own flows.
 *
 * Two signed, HttpOnly cookies, path-scoped so neither is ever confused with the session cookie:
 *   gauth_oauth   state/nonce/PKCE verifier/intent/uid, 10 min, set by whichever /start mints it,
 *                 read once by the callback and always cleared there (success or failure).
 *   gauth_signup  the pending-signup ticket (sub/email/name), 15 min, set by the callback when no
 *                 account matches, read once by POST /api/register/google. Never the ID token
 *                 itself — exactly what the issue asks for ("não vaze o ID token").
 *
 * `intent` decides who may ask and what the callback does with a verified identity:
 *   login/signup  no session needed; identical handling either way (the only difference is which
 *                 screen the person started from) — an existing, Google-linked account signs in;
 *                 one found by e-mail links and signs in, but only if that e-mail is already
 *                 *verified* on this account (ISO-1397) — the whole point being that a stranger
 *                 who merely shares an e-mail string with a real account can never ride in on it
 *                 by owning a Google account with the same address but unverified "proof";
 *                 nobody matches → a signup ticket.
 *   link          GOOGLE_OAUTH_COOKIE minted by POST /api/account/google/start (not the plain GET
 *                 start below), which asks proveOwner's usual proof — the same one adding a
 *                 passkey asks — before it ever redirects. Links to the session's own account
 *                 regardless of whether the Google e-mail matches anything about it.
 *   reauth        requires a session and an existing Google link; confirms the *same* identity is
 *                 behind the wheel right now and mints proveOwner's third proof (above) — the
 *                 only way an account with no password and no passkey (one created by #signup
 *                 below) can ever confirm anything of its own.
 *
 * Result codes in `#/entrar?google=<code>` (login/signup) or `#/configuracoes?google=<code>`
 * (link/reauth) — the exact set closed in ISO-1595's `ux` document §4: `ok`, `linked`,
 * `email-unverified`, `signup` (ticket pending — see gauth_signup above), `disabled`,
 * `already-linked` (link only), `cancelled` (Google's own `error=access_denied`), `reauth-ok`
 * (reauth only, carries `proof`), `reauth-mismatch` (reauth only), and `error` for anything else —
 * a network failure, a malformed response, an id-token that fails any one of its checks. */
const GOOGLE_OAUTH_COOKIE = 'gauth_oauth';
const GOOGLE_SIGNUP_COOKIE = 'gauth_signup';
const GOOGLE_OAUTH_CLEAR = `${GOOGLE_OAUTH_COOKIE}=; Path=/api/auth/google; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;
const GOOGLE_SIGNUP_CLEAR = `${GOOGLE_SIGNUP_COOKIE}=; Path=/api/register/google; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

// The HashRouter path a Google round trip returns to, with its result as a query string after
// the hash (`#/entrar?google=ok`) — same idea as verifyLink/recoverLink, just with a route and
// params that vary per result instead of carrying a single mailed token.
function hashRedirect(routePath, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return `${APP_URL}/#${routePath}${qs ? '?' + qs : ''}`;
}

// Everything both /start routes need: a discovery round trip (cached by oauth-google.js after
// the first), a fresh PKCE/state/nonce triple, and the signed cookie the callback will check
// itself against. `uid` is null for login/signup, the session's own id for link/reauth.
async function googleAuthRequest(intent, uid) {
  const discovery = await oauthGoogle.discover();
  const { verifier, challenge } = oauthGoogle.makePkce();
  const state = oauthGoogle.makeState();
  const nonce = oauthGoogle.makeNonce();
  const cookie = `${GOOGLE_OAUTH_COOKIE}=${signJSON({ state, nonce, verifier, intent, uid, iat: Date.now() })}; Path=/api/auth/google; Max-Age=600; HttpOnly;${SECURE} SameSite=Lax`;
  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI, response_type: 'code',
    scope: 'openid email profile', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
  }).toString();
  return { url: authUrl.toString(), cookie };
}
const googleUnavailable = res => json(res, 503, { error: 'google is unavailable right now' });

const googleRoutes = {
  // No session for login/signup. reauth needs one, and an existing link to reauthenticate —
  // there would be nothing for Google to confirm against otherwise. link is deliberately NOT
  // handled here — see POST /api/account/google/start below for why it needs a POST.
  'GET /api/auth/google/start': async (req, res) => {
    const intent = new URL(req.url, 'http://x').searchParams.get('intent');
    if (!['login', 'signup', 'reauth'].includes(intent)) return json(res, 400, { error: 'invalid intent' });
    let uid = null;
    if (intent === 'reauth') {
      const user = await readSession(req);
      if (!user) return notSignedIn(res);
      if (!(await findOAuthIdentityByUser(pool, 'google', user.id))) {
        return json(res, 400, { error: 'no Google account linked yet', code: 'not-linked' });
      }
      uid = user.id;
    }
    let built;
    try { built = await googleAuthRequest(intent, uid); }
    catch (e) { console.error('google: discovery failed', e.message); return googleUnavailable(res); }
    res.writeHead(302, { Location: built.url, 'Set-Cookie': built.cookie });
    res.end();
  },

  // Linking from Settings asks the same proof adding a passkey does (proveOwner) — and asks it
  // here, before ever redirecting, which is the one thing a bare GET (no body to carry a password
  // or a passkey assertion in) cannot do itself. The browser still ends up on a full-page redirect
  // to Google exactly like the GET routes above — this just hands back the URL to navigate to,
  // rather than sending the 302 itself, so the proof can be checked first.
  'POST /api/account/google/start': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if (await findOAuthIdentityByUser(pool, 'google', user.id)) {
      return json(res, 409, { error: 'this profile is already linked to a Google account', code: 'already-linked' });
    }
    const proof = await proveOwner(req, res, user, body, 'google-link');
    if (!proof) return;
    // Awaited: a sign-out everywhere, a disable or an admin reset may have ended this session.
    if (!(await sessionStillValid(req, user))) return notSignedIn(res);
    let built;
    try { built = await googleAuthRequest('link', user.id); }
    catch (e) { console.error('google: discovery failed', e.message); return googleUnavailable(res); }
    audit(req, 'auth.google.start', { user, msg: proof });
    json(res, 200, { url: built.url }, { 'Set-Cookie': built.cookie });
  },

  'GET /api/auth/google/callback': async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const cookieRaw = singleCookie(req, GOOGLE_OAUTH_COOKIE);
    const cookie = cookieRaw ? verifyJSON(cookieRaw) : null;
    const expired = !cookie || Date.now() - (cookie.iat || 0) > 10 * 60000;
    const base = cookie && (cookie.intent === 'link' || cookie.intent === 'reauth') ? '/configuracoes' : '/entrar';
    // Every path out of this handler clears the state cookie — it is good for one round trip,
    // success or failure, never replayed.
    const done = (code, params = {}, extraCookies = []) => {
      res.writeHead(302, { Location: hashRedirect(base, { google: code, ...params }), 'Set-Cookie': [GOOGLE_OAUTH_CLEAR, ...extraCookies] });
      res.end();
    };
    // A wrong state, a code that fails to exchange, or an id-token that fails any one of its
    // checks are all the same kind of thing this flow's own throttle (THROTTLED's 'google' kind)
    // exists for: a guess at forging the round trip. `reason` is never shown to anyone — only
    // audited — so it is free to be specific.
    const fail = (reason, code = 'error') => {
      strikeAddress(req, 'google');
      audit(req, 'auth.google.fail', { ok: false, uid: cookie?.uid || null, msg: reason });
      done(code);
    };

    if (q.get('error')) {
      if (q.get('error') === 'access_denied') {
        // Not a failure — a real "never mind", the same philosophy webauthnOutcome already
        // applies to a dismissed passkey prompt (ISO-1595 §4.6). Not struck, not `auth.google.fail`.
        audit(req, 'auth.google.refused', { ok: false, uid: cookie?.uid || null, msg: 'cancelled' });
        return done('cancelled');
      }
      return fail('provider:' + text(q.get('error')).slice(0, 40));
    }
    if (!cookie || expired) return fail('state-cookie-invalid');
    // Constant-time: a byte-by-byte early-exit comparison would let an attacker learn the state
    // one byte at a time from response timing, same reasoning as verifySig's HMAC check above.
    const gotState = Buffer.from(text(q.get('state')));
    const wantState = Buffer.from(String(cookie.state || ''));
    const stateOk = gotState.length === wantState.length && crypto.timingSafeEqual(gotState, wantState);
    if (!stateOk) return fail('state-mismatch');
    if (addressPaused(req, res, 'google')) return;
    const code = text(q.get('code'));
    if (!code) return fail('missing-code');

    let discovery, tokenSet;
    try {
      discovery = await oauthGoogle.discover();
      tokenSet = await oauthGoogle.exchangeCode({
        tokenEndpoint: discovery.token_endpoint, code, redirectUri: GOOGLE_REDIRECT_URI,
        clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, codeVerifier: cookie.verifier
      });
    } catch (e) {
      return fail('token-exchange:' + e.message.slice(0, 60));
    }

    let claims;
    try {
      claims = await oauthGoogle.verifyGoogleIdToken(tokenSet.id_token, {
        jwksUri: discovery.jwks_uri, clientId: GOOGLE_CLIENT_ID, nonce: cookie.nonce
      });
    } catch (e) {
      return fail('id-token:' + (e.reason || 'invalid'));
    }
    // users.email is stored through normalizeEmail (lower-cased via nameKey); fold the Google
    // claim through the same function once, here, so every lookup/insert/ticket below compares
    // and stores the same form — a Workspace account returning `Ana.Silva@empresa.com.br` must
    // still find the account that verified `ana.silva@empresa.com.br`, not open a second one.
    claims.email = normalizeEmail(claims.email);
    if (!claims.email) return fail('id-token:malformed');

    if (cookie.intent === 'reauth') {
      const s = await sessionOf(req);
      if (!s || s.user.id !== cookie.uid) return fail('session-lost');
      const identity = await findOAuthIdentityByUser(pool, 'google', cookie.uid);
      if (!identity || identity.subject !== claims.sub) {
        audit(req, 'auth.google.refused', { ok: false, user: s.user, msg: 'reauth-mismatch' });
        return done('reauth-mismatch');
      }
      await touchOAuthIdentityUse(pool, 'google', claims.sub);
      const proof = putReauthProof(s.user.id, s.sid);
      audit(req, 'auth.google.ok', { user: s.user, msg: 'reauth' });
      return done('reauth-ok', { proof });
    }

    if (cookie.intent === 'link') {
      const user = await getUserById(pool, cookie.uid);
      if (!user || user.disabled) return fail('session-lost');
      const existing = await findOAuthIdentityBySubject(pool, 'google', claims.sub);
      if (existing && existing.userId !== user.id) {
        audit(req, 'auth.google.refused', { ok: false, user, msg: 'already-linked' });
        return done('already-linked');
      }
      if (existing) { // already linked to this very account — an idempotent replay, not an error
        await touchOAuthIdentityUse(pool, 'google', claims.sub);
        return done('linked');
      }
      const added = await insertOAuthIdentity(pool, { provider: 'google', subject: claims.sub, userId: user.id, email: claims.email });
      if (added.error) { // raced a concurrent link of this same Google account to someone else
        audit(req, 'auth.google.refused', { ok: false, user, msg: 'already-linked' });
        return done('already-linked');
      }
      audit(req, 'auth.google.link', { user, msg: maskEmail(claims.email) });
      return done('linked');
    }

    // login or signup: identical handling either way — only `base` above (always /entrar for
    // both) would ever have told them apart, and it doesn't need to.
    const bySubject = await findOAuthIdentityBySubject(pool, 'google', claims.sub);
    if (bySubject) {
      const user = await getUserById(pool, bySubject.userId);
      if (!user) return fail('user-missing');
      if (user.disabled) {
        audit(req, 'auth.google.refused', { ok: false, user, msg: 'disabled' });
        return done('disabled');
      }
      await touchOAuthIdentityUse(pool, 'google', claims.sub);
      audit(req, 'auth.google.ok', { user });
      return done('ok', {}, await sessionCookie(user, req.headers['user-agent']));
    }
    // No identity yet — does the e-mail match an existing account? Only a *verified* one may be
    // linked here: Google proved the e-mail is this person's, but if the Brilhart Fitness account
    // using it has never confirmed that same address, trusting Google's word over it would let
    // anyone who merely knows (or once owned) that address ride into someone else's profile —
    // exactly the account-hijack ISO-1397's confirmation step exists to close.
    const holder = (await getAllUsers(pool)).find(u => u.email === claims.email);
    if (holder) {
      if (holder.disabled) {
        audit(req, 'auth.google.refused', { ok: false, user: holder, msg: 'disabled' });
        return done('disabled');
      }
      if (!holder.emailVerifiedAt) {
        audit(req, 'auth.google.refused', { ok: false, user: holder, msg: 'email-unverified' });
        return done('email-unverified');
      }
      const added = await insertOAuthIdentity(pool, { provider: 'google', subject: claims.sub, userId: holder.id, email: claims.email });
      if (added.error) return fail('link-race'); // raced a concurrent link/signup for this same Google account
      audit(req, 'auth.google.link', { user: holder, msg: maskEmail(claims.email) });
      return done('linked', {}, await sessionCookie(holder, req.headers['user-agent']));
    }
    // Nobody — a pending signup, finished by POST /api/register/google within 15 minutes. The
    // ticket is the ID token's claims the account actually needs, signed into its own cookie —
    // never the ID token itself, which this never exposes past this one request.
    const signupCookie = `${GOOGLE_SIGNUP_COOKIE}=${signJSON({ sub: claims.sub, email: claims.email, name: claims.name, iat: Date.now() })}; Path=/api/register/google; Max-Age=900; HttpOnly;${SECURE} SameSite=Lax`;
    audit(req, 'auth.google.ok', { msg: 'pending-signup · ' + maskEmail(claims.email) });
    return done('signup', { name: claims.name, email: claims.email }, [signupCookie]);
  },

  // Finishes the signup the callback above started: Google already proved the e-mail, so this
  // never mails a confirmation — email_verified_at is set in the same breath the row is created.
  // Same Terms/birth-date/invite rules as every other signup route, same single transaction
  // shape as POST /api/register/password (createUser, the invite, the identity all commit or
  // fail together) — just reading its identity from the ticket cookie instead of a WebAuthn
  // challenge or a typed password.
  'POST /api/register/google': async (req, res) => {
    const body = await readBody(req);
    const ticketRaw = singleCookie(req, GOOGLE_SIGNUP_COOKIE);
    const ticket = ticketRaw ? verifyJSON(ticketRaw) : null;
    const invalid = () => json(res, 400, { error: 'that Google sign-up has expired — start again', code: 'ticket-invalid' });
    if (!ticket || Date.now() - (ticket.iat || 0) > 15 * 60000) {
      strikeAddress(req, 'google-signup');
      return invalid();
    }
    const termsProblem = termsVersionProblem(body);
    if (termsProblem) {
      audit(req, 'auth.register.denied', { ok: false, msg: termsProblem.code });
      return json(res, termsProblem.status, { error: termsProblem.error, code: termsProblem.code });
    }
    const birthProblem = birthDateProblem(body);
    if (birthProblem) {
      audit(req, 'auth.register.denied', { ok: false, msg: birthProblem.code });
      return json(res, birthProblem.status, { error: birthProblem.error, code: birthProblem.code });
    }
    const birthDate = parseBirthDate(body.birthDate);
    const name = (text(body.name).trim() || text(ticket.name).trim() || ticket.email.split('@')[0]).slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required', code: 'missing' });
    const code = text(body.code).trim().toUpperCase();
    if (INVITE_ONLY && addressPaused(req, res, 'signup')) return;
    if (INVITE_ONLY && !(await inviteIsValid(pool, code))) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      strikeAddress(req, 'signup');
      return json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
    }
    if (await nameTaken(name)) return json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (await emailTaken(ticket.email)) {
      audit(req, 'auth.register.fail', { ok: false, name, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    }
    const created = new Date().toISOString();
    const user = {
      id: crypto.randomBytes(12).toString('base64url'), name, created, email: ticket.email, birthDate,
      termsAcceptedVersion: LEGAL_VERSION, termsAcceptedAt: created
    };
    if (INVITE_ONLY) user.invitedBy = code;
    let added;
    try {
      await withTransaction(pool, async client => {
        await createUser(client, user);
        await markEmailVerified(client, user.id); // Google already proved this address
        if (INVITE_ONLY && !(await consumeInvite(client, code, user.id))) throw new InviteRaceError();
        added = await insertOAuthIdentity(client, { provider: 'google', subject: ticket.sub, userId: user.id, email: ticket.email });
        if (added.error) throw new HttpError(409, added.error);
      });
    } catch (e) {
      if (e instanceof InviteRaceError) {
        audit(req, 'auth.register.fail', { ok: false, name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid — ask for a new one', code: 'invite' });
      }
      if (e instanceof HttpError) {
        audit(req, 'auth.register.fail', { ok: false, name, msg: added.code });
        return json(res, e.status, { error: e.message, code: added.code });
      }
      if (e.code === '23505') { // unique_violation — the e-mail was taken in the gap above
        audit(req, 'auth.register.fail', { ok: false, name, msg: 'email-taken' });
        return json(res, 409, EMAIL_ERRORS.taken);
      }
      throw e;
    }
    audit(req, 'auth.google.signup', { user, msg: INVITE_ONLY ? code : null });
    json(res, 200, { user: publicUser(user) }, {
      'Set-Cookie': [...(await sessionCookie(user, req.headers['user-agent'])), GOOGLE_SIGNUP_CLEAR]
    });
  },

  // Never the last way in, same rule as removing the password (DELETE /api/account/password) or
  // a passkey — and the same proof as either of those: proveOwner now also accepts a fresh
  // Google reauth (above) for an account with nothing else to confirm with.
  'DELETE /api/account/google': async (req, res) => {
    const user = await readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const lastWayIn = () => json(res, 409, { error: 'connecting with Google is the only way into this profile', code: 'last-way-in' });
    if (!(await findOAuthIdentityByUser(pool, 'google', user.id))) return json(res, 200, { ok: true });
    if ((await passkeyCount(user)) + (passwordWayIn(user) ? 1 : 0) < 1) return lastWayIn();
    const proof = await proveOwner(req, res, user, body, 'google-remove');
    if (!proof) return;
    const fresh = await sessionStillValid(req, user);
    if (!fresh) return notSignedIn(res);
    const r = await removeOAuthIdentityUnlessLast(pool, fresh.id, 'google', PASSWORD_LOGIN);
    if (r.error) return lastWayIn();
    audit(req, 'auth.google.unlink', { user: fresh });
    json(res, 200, { ok: true });
  }
};

/* ---------- photos & videos of custom exercises (api/media.js) ---------- */
// One photo, GIF or short video per custom exercise, stored per profile and named by its sha256.
// The state only ever carries a small ref; the bytes arrive and leave through the routes below.
// MEDIA_UPLOADS=0 takes the routes and the /api/config block away, but the store is created
// either way: an admin deleting a profile must still remove files uploaded while it was on.
const MEDIA_LIMITS = mediaLimits(process.env);
const MEDIA_ON = MEDIA_LIMITS.enabled;
const MEDIA = createMediaStore({ dir: path.join(DATA, 'uploads'), limits: MEDIA_LIMITS, readState });
// Leftovers of uploads the previous process was receiving when it stopped.
try { MEDIA.cleanTmp(); } catch (e) { console.error('media: boot cleanup failed', e.message); }
// Per profile, not per address: every upload is signed in, and behind a proxy one address can be
// a whole household. The hourly budget is generous (an import of a backup re-uploads everything
// at once); the two-in-flight cap in media.js is what keeps one phone from holding many sockets.
const MEDIA_BURST = createWindow({ max: MEDIA_LIMITS.uploadsPerHour, windowMs: 3600000 });
// Deleting everything unreferenced is what "Reset everything" does; ten an hour is plenty.
const MEDIA_SWEEPS = createWindow({ max: 10, windowMs: 3600000 });
// Uid -> until when its throttle has already been recorded, so a client hammering a closed
// window writes one audit line per window, not one per request.
const mediaThrottleNoted = new Map();
setInterval(() => {
  MEDIA_BURST.sweep(); MEDIA_SWEEPS.sweep();
  for (const [k, until] of mediaThrottleNoted) if (until < Date.now()) mediaThrottleNoted.delete(k);
}, 600000).unref();
function mediaThrottle(req, user, win) {
  const wait = win.take(user.id);
  if (!wait) return;
  if ((mediaThrottleNoted.get(user.id) || 0) < Date.now()) {
    mediaThrottleNoted.set(user.id, Date.now() + wait * 1000);
    audit(req, 'media.throttled', { ok: false, user, msg: win === MEDIA_SWEEPS ? 'sweep' : 'upload' });
  }
  throw new MediaError(429, 'locked', { retryAfter: wait }, { 'Retry-After': String(wait) });
}
// Removes files that no profile's readable state has referenced for MEDIA_GC_GRACE_DAYS. Only
// profiles with a users row are swept, and only when their state parses (see media.js for why a
// missing anything never means "delete"). First pass a few minutes after boot, so an instance
// that is redeployed more often than hourly still gets one.
async function mediaSweepAll() {
  try {
    const r = await MEDIA.sweepAll({ uids: (await getAllUsers(pool)).map(u => u.id) });
    if (r.removed || r.tmp) console.log(`media: swept ${r.removed} unreferenced file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB, ${r.tmp} stale upload(s)`);
  } catch (e) { console.error('media: sweep failed', e); }
}
if (MEDIA_ON) {
  setInterval(mediaSweepAll, 3600000).unref();
  setTimeout(mediaSweepAll, 5 * 60000).unref();
}

/* ---------- program covers (ISO-1485) ----------
 * A flat namespace of its own, DATA_DIR/program-covers/<sha256>.<ext> — deliberately outside
 * api/media.js's uploads/<uid>/ store, whose GC collects anything not referenced by that one
 * profile's own state (a Program cover belongs to no profile at all, and would be collected the
 * first time that GC ran). Magic-number validation (sniffMedia) and the size cap are reused from
 * media.js; the streaming/quota/per-profile machinery is not — a cover is admin-only, small
 * (PROGRAM_COVER_MAX_MB, default 5) and infrequent enough that reading the whole body into memory
 * (readRawBody, already capped at MAX_BODY) is simpler and exactly as safe.
 */
const PROGRAM_CFG = programConfig(process.env);
const PROGRAM_COVER_DIR = path.join(DATA, 'program-covers');
try { fs.mkdirSync(PROGRAM_COVER_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(PROGRAM_COVER_DIR, 0o700); }
catch (e) { console.error('program-covers: could not create directory', e.message); }
const programCoverPath = file => path.join(PROGRAM_COVER_DIR, file);
const PROGRAM_COVER_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// store.js's programs.* functions answer `{ error, code, current? }` on a refusal rather than
// throwing — this is every route's one place to turn that into the right HTTP status.
const PROGRAM_ERROR_STATUS = {
  'not-found': 404, 'in-trash': 409, stale: 409, 'title-taken': 409,
  'not-in-trash': 409, 'confirm-mismatch': 400, 'no-cover': 400
};
function programError(res, result) {
  const status = PROGRAM_ERROR_STATUS[result.code] || 400;
  json(res, status, { error: result.error, code: result.code, ...(result.current ? { current: result.current } : {}) });
}

// Best-effort: a failed unlink leaves an orphan for the sweep below to collect later, never a
// reason to fail the request that already committed the row change it followed.
function unlinkProgramCover(file) {
  if (!file) return;
  try { fs.unlinkSync(programCoverPath(file)); }
  catch (e) { if (e.code !== 'ENOENT') console.error('program-covers: could not remove', file, e.message); }
}

// Files on disk nothing in `programs` (active or trashed) references any more, and old enough
// (ORPHAN_GRACE_MS) that a cover mid-upload when this runs is never caught mid-write — setProgramCover
// only reaches the DB write after the bytes are already on disk, so a brand-new file with no row
// yet is either about to get one (a save in flight) or already failed its own request and will be
// swept on a later pass once it ages past the grace period.
const PROGRAM_COVER_ORPHAN_GRACE_MS = 3600000;
async function programCoverSweep() {
  let files;
  try { files = fs.readdirSync(PROGRAM_COVER_DIR); } catch { return; }
  if (!files.length) return;
  let referenced;
  try { referenced = await getAllCoverFiles(pool); } catch (e) { return console.error('program-covers: sweep could not read references', e.message); }
  const now = Date.now();
  let removed = 0;
  for (const file of files) {
    if (referenced.has(file)) continue;
    const full = programCoverPath(file);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (now - stat.mtimeMs < PROGRAM_COVER_ORPHAN_GRACE_MS) continue;
    try { fs.unlinkSync(full); removed++; } catch (e) { console.error('program-covers: sweep could not remove', file, e.message); }
  }
  if (removed) console.log(`program-covers: swept ${removed} orphaned file(s)`);
}
setInterval(programCoverSweep, 3600000).unref();
setTimeout(programCoverSweep, 5 * 60000).unref();

// The retention clock (plan §2.3): a program in the trash longer than PROGRAM_TRASH_DAYS is
// deleted for good, same as a human doing it through POST /api/admin/program/purge, logged the
// same way (`program_events.action = 'purge_auto'`) but with no admin behind it — `audit()`'s
// `f.uid` is left unset, same convention as any other system-initiated event. 0 days means never
// (checked inside purgeExpiredPrograms too; re-checked here isn't required but costs nothing).
// audit(req, ...) only ever reads req.headers/req.socket — this tick has neither, so it passes a
// minimal stand-in rather than widening audit()'s own signature for the one caller with no request.
const NO_REQ = { headers: {}, socket: {} };
async function programTrashSweep() {
  if (!PROGRAM_CFG.trashDays) return;
  let purged;
  try { purged = await purgeExpiredPrograms(pool, PROGRAM_CFG.trashDays); }
  catch (e) { return console.error('programs: auto-purge failed', e.message); }
  for (const p of purged) {
    if (p.coverFile && !p.coverStillReferenced) unlinkProgramCover(p.coverFile);
    audit(NO_REQ, 'program.purge.auto', { msg: p.title });
  }
  if (purged.length) console.log(`programs: auto-purged ${purged.length} program(s) past ${PROGRAM_CFG.trashDays}-day retention`);
}
setInterval(programTrashSweep, 3600000).unref();
setTimeout(programTrashSweep, 5 * 60000).unref();

// A stored file, streamed. The headers are the point: the bytes were chosen by a user, so the
// answer must never be something a browser would run. The Content-Type comes from the sniffed
// extension (never text/* or SVG), nosniff stops a browser second-guessing it, the sandbox CSP
// neuters it even if opened as a page, CORP keeps other sites from embedding it, and no-store
// keeps a copy out of the HTTP cache — the app's own media store is the only client cache, and
// an HTTP-cache copy would outlive the sign-out purge. No Range and no ETag: nothing asks.
async function sendMediaFile(res, f, hash) {
  let fd;
  try { fd = fs.openSync(f.path, 'r'); }
  catch { throw new MediaError(404, 'media-missing'); }   // swept between the lookup and here
  const size = fs.fstatSync(fd).size;
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `inline; filename="${hash}.${f.ext}"`,
    'X-Robots-Tag': 'noindex',
    // The paired phone reads the length before the body to refuse an oversized answer; it is
    // CORS-safelisted already, this only spells it out for older WebViews.
    'Access-Control-Expose-Headers': 'Content-Length'
  });
  try { await pipeline(fs.createReadStream(null, { fd }), res); }
  catch { res.destroy(); }   // the client went away mid-download; nothing left to answer
}

const mediaRoutes = {
  // The raw bytes of one file, named by the sha256 the client computed. media.js checks the
  // hash, the magic bytes, the caps, the quota and the free disk; this route only adds the
  // session and the hourly budget.
  'PUT /api/media/{hash}': async (req, res) => {
    const user = await readSession(req);
    if (!user) { MEDIA.discard(req); return json(res, 401, { error: 'not signed in' }); }
    try { mediaThrottle(req, user, MEDIA_BURST); } catch (e) { MEDIA.discard(req); throw e; }
    req.allowSlowBody?.();   // a signed-in upload within its budget may take the half hour
    const r = await MEDIA.receive(user.id, req.mediaHash, req);
    json(res, r.status, r.body);
  },
  'GET /api/media/{hash}': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    // Only ever the caller's own folder: another profile's file is exactly as missing as one
    // that was never uploaded.
    const f = MEDIA.file(user.id, req.mediaHash);
    if (!f) throw new MediaError(404, 'media-missing');
    await sendMediaFile(res, f, req.mediaHash);
  },
  // Which of these the server does not have, so a device uploads only those. Answered from the
  // in-memory list of the caller's own folder.
  'POST /api/media/missing': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const hashes = body.hashes;
    if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every(h => typeof h === 'string' && HASH_RE.test(h))) {
      throw new MediaError(400, 'bad-request', { error: 'hashes must be a list of at most 1000 lowercase sha256 hex strings' });
    }
    json(res, 200, MEDIA.missing(user.id, hashes));
  },
  // "Reset everything": every file the caller's current state does not reference goes now,
  // without the grace. A state that cannot be read removes nothing.
  'POST /api/media/sweep': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await readBody(req);
    mediaThrottle(req, user, MEDIA_SWEEPS);
    const r = await MEDIA.sweep(user.id, { graceMs: 0 });
    audit(req, 'media.sweep', { user, msg: `${r.removed} file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB${r.skipped ? ', state unreadable' : ''}` });
    json(res, 200, { removed: r.removed, freedBytes: r.freedBytes, usage: MEDIA.usage(user.id) });
  }
};

/* ---------- account deletion (ISO-1447, Phase 4 — LGPD) ----------
 * One path for both ways an account goes: an admin removing someone else (POST
 * /api/admin/user/delete) and someone removing themselves (DELETE /api/account). Everything the
 * row's own cascade already takes (user_state/training data, passkeys, push_subscriptions,
 * device_links, sessions, email_tokens, subscriptions) needs nothing here; this is everything that
 * does not cascade — Stripe (queued in the same transaction as the delete, never a reason it half-
 * applies — see billing.js's attemptStripeCleanup), the Coach's per-profile file and credential,
 * uploaded media, and whatever only ever lived in this process's memory (presence, a pending
 * pairing code, a scheduled rest-timer push). `invites.used_by` is deliberately left burned — see
 * migrations/003_invites_used_by_no_fk.sql — so it is never touched here. The guards that decide
 * whether a deletion may happen at all (the last admin, deleting yourself through the admin route)
 * are each route's own, asked before this runs.
 */
async function deleteAccount(target) {
  presence.delete(target.id);
  for (const [k, v] of pairings) if (v.uid === target.id) pairings.delete(k);
  cancelRestTimer(target.id);
  let cleanup = null;
  await withTransaction(pool, async client => {
    if (target.stripeCustomerId) {
      const { rows } = await client.query(
        "SELECT id FROM subscriptions WHERE user_id = $1 AND data->>'status' IN ('active', 'past_due')",
        [target.id]
      );
      cleanup = await insertStripeCleanup(client, { customerId: target.stripeCustomerId, subscriptionIds: rows.map(r => r.id) });
    }
    // Cascades to user_state, passkeys, push_subscriptions, device_links, sessions and
    // subscriptions (`ON DELETE CASCADE`) — everything else this helper does by hand is what
    // doesn't.
    await deleteUser(client, target.id);
  });
  try { coachConfig.clearProfileAuth(target.id); } catch { /* nothing stored */ }
  try { coachJobs.purgeUser(target.id); } catch (e) { console.error('coach: could not purge', target.id, e.message); }
  try { MEDIA.removeUser(target.id); } catch (e) { console.error('media: could not remove uploads of', target.id, e.message); }
  // Tried once, right now, outside the transaction above (which has already committed — the
  // account is gone locally either way): success clears the row on the spot, a failure (Stripe
  // down, a transient error) just leaves it for the periodic retry below.
  if (cleanup) {
    try { await attemptStripeCleanup(pool, cleanup); }
    catch (e) { console.error('billing: stripe cleanup failed for customer', cleanup.customerId, e.message); }
  }
}
if (BILLING_ON) setInterval(() => {
  tickStripeCleanup(pool).catch(e => console.error('billing: stripe cleanup tick failed', e));
}, 15 * 60000).unref();

/* ---------- routes ---------- */
// Public, unauthenticated, and polled by an external uptime monitor (ISO-1400) — so it stays
// cheap (a bare SELECT 1, bounded by HEALTH_DB_TIMEOUT_MS) and never reports the account count
// the old response did; a health probe is not a place to leak how many users an instance has.
const HEALTH_DB_TIMEOUT_MS = 2000;
const routes = {
  'GET /api/health': async (req, res) => {
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('db ping timed out')), HEALTH_DB_TIMEOUT_MS))
      ]);
      json(res, 200, { ok: true, db: 'ok' });
    } catch (e) {
      console.error('health: db ping failed', e.message);
      json(res, 503, { ok: false, db: 'down' });
    }
  },

  // Public config the login screen needs before anyone is signed in. `coach` is absent unless
  // the instance has both switched the Coach on and successfully connected a provider — the
  // single flag every piece of Coach UI hangs off, so an unconfigured instance is byte-for-byte
  // the app it was before the feature existed.
  'GET /api/config': async (req, res) => {
    // The Coach block names the provider this instance is wired to — the same fact
    // /api/coach/disclosure refuses to hand out without a session, and for the same reason: on an
    // invite-only instance, which model this box talks to is nobody's business who has not been
    // let in. The two flags above it are what the login screen and the pre-login boot read
    // (invite code field, "continue without account"), so those stay public.
    //
    // Every Coach consumer on the client side already requires a signed-in user before it looks
    // at this block (lib/coach.js coachAvailable), so nothing that could render loses anything.
    //
    // A signed-in caller always gets the key, even on an instance with no Coach, where it is
    // null. The client caches this answer for the page load and has to know whether the copy it
    // holds was made for a session: without the key it cannot tell "no Coach here" from "you
    // were not signed in when you asked", and would re-ask on every sign-in on every instance
    // that has no Coach. The key's absence is that answer.
    json(res, 200, {
      invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST,
      // ISO-1390: public like the two flags above — the signup screen links the texts of this
      // version before anyone is signed in, and an app whose bundle carries another one knows to
      // ask for an update instead of collecting an acceptance the server would refuse.
      legal_version: LEGAL_VERSION,
      // Only when on, so an instance without passwords answers exactly as it did before (#118).
      ...(PASSWORD_LOGIN ? { password_login: true } : {}),
      // Only when both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set (ISO-1597) — otherwise
      // every /api/auth/google/* route is absent (404) and this answers exactly as before.
      ...(GOOGLE_LOGIN ? { google_login: true } : {}),
      // Public: the sign-in screen is the first thing that reads it.
      ...(DEFAULT_LANG ? { default_lang: DEFAULT_LANG } : {}),
      // Public like the two flags above: the caps are not a secret, and the absence of the
      // block is how the app knows this server does not take photos and videos at all.
      ...(MEDIA_ON ? { media: mediaConfig(MEDIA_LIMITS) } : {}),
      ...((await readSession(req)) ? { coach: coachConfig.publicConfig() } : {})
    });
  },

  // ISO-1480: a classified WebAuthn ceremony failure from the frontend's three sign-in-shaped
  // flows (lib/webauthn-error.js). Reachable with no session — register and login both are — so
  // every field is clamped or dropped to an allowlisted enum before it reaches audit(); nothing
  // free-text, and nothing that could identify a device, goes in the log. `null`/204 either way:
  // a dropped beacon must never surface as an error the UI has to handle on top of its own.
  'POST /api/client-event': async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const flow = WEBAUTHN_FLOWS.has(body?.flow) ? body.flow : 'unknown';
    const step = typeof body?.step === 'string' ? body.step.slice(0, 24).replace(/[^a-z0-9-]/gi, '') || 'unknown' : 'unknown';
    const kind = WEBAUTHN_KINDS.has(body?.kind) ? body.kind : 'other';
    const elapsedMs = Number.isFinite(body?.elapsedMs) ? Math.max(0, Math.min(60000, Math.round(body.elapsedMs))) : null;
    const secure = body?.isSecureContext !== false;
    audit(req, 'auth.webauthn.fail', { ok: false, act: flow + ':' + step, msg: kind + ' elapsedMs=' + (elapsedMs ?? '?') + ' secure=' + secure + ' ua=' + uaFamily(req) });
    json(res, 200, {});
  },

  // A paired phone's token was minted once, at pairing, and nothing ever renewed it: after
  // SESSION_DAYS the server refused a phone that had been in use every day. The phone asks this
  // on every start, so once its token is past half its life the answer carries a new one
  // (`token`), which the phone saves in place of the old. makeSession() writes the account's
  // current session version into it, so "sign out everywhere" ends a renewed token exactly as it
  // ended the old one — and a revoked token never gets this far. A browser's cookie is left
  // alone: signing in renews it, as before.
  'GET /api/me': async (req, res) => {
    const s = await sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const renew = s.bearer && s.exp - Date.now() < SESSION_DAYS * 86400000 / 2;
    // ISO-1597: whether this profile has a linked Google identity, and since when — read
    // regardless of whether GOOGLE_LOGIN is currently on, same as `email`/`termsVersion` below are
    // always present: an instance that switches Google off again must not make a profile's own
    // Settings screen forget it still has one (DELETE /api/account/google would 404 there too, by
    // the same "the whole feature is absent" rule — nothing here promises it can be *removed*
    // while off, only that Settings still shows it honestly).
    const google = await findOAuthIdentityByUser(pool, 'google', user.id);
    json(res, 200, {
      user: { id: user.id, name: user.name, admin: isAdmin(user) },
      // ISO-1397/ISO-1596: what the app needs to show "confirm your e-mail" or ask for one at
      // all — an account from before ISO-1397 has neither field until its owner sets one. Always
      // present now, PASSWORD_LOGIN or not: `email` is the one verified address every account has
      // (see "e-mail sign-in" above), not the older, unrelated #118 sign-in address this used to
      // mean while the flag was on — that field is gone, so nothing collides here any more.
      email: user.email || null, emailVerified: !!user.emailVerifiedAt, needsEmail: !user.email,
      // ISO-1390: what the app needs to put the "we updated our terms" sheet in front of an
      // account — one imported from before this phase has accepted nothing, one that accepted an
      // older version has to accept again. Always present, PASSWORD_LOGIN or not: unlike `email`
      // above, nothing here collides with an older field.
      termsVersion: user.termsAcceptedVersion || null,
      termsAcceptedAt: user.termsAcceptedAt || null,
      needsTerms: user.termsAcceptedVersion !== LEGAL_VERSION,
      google: google ? { email: google.email || null, linkedAt: google.created } : null,
      ...(renew ? { token: await makeSession(user, req.headers['user-agent']) } : {})
    });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    // ISO-1390: checked before the e-mail, so an outdated app or an unticked box never spends the
    // caller's e-mail-guess budget (addressPaused/strikeAddress below) on a signup that could not
    // have gone through anyway. The version travels in the challenge to /verify, which records it.
    const termsProblem = termsVersionProblem(body);
    if (termsProblem) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: termsProblem.code });
      return json(res, termsProblem.status, { error: termsProblem.error, code: termsProblem.code });
    }
    const termsVersion = body.termsVersion;
    // ISO-1521: right after the terms, before the e-mail-guess budget below gets spent on a
    // signup that could never go through anyway.
    const birthProblem = birthDateProblem(body);
    if (birthProblem) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: birthProblem.code });
      return json(res, birthProblem.status, { error: birthProblem.error, code: birthProblem.code });
    }
    const birthDate = parseBirthDate(body.birthDate);
    // ISO-1397: every signup from here on needs a valid, unique e-mail — checked here, before the
    // WebAuthn ceremony, so a taken or malformed address fails fast rather than after a Face ID/
    // fingerprint prompt. "Taken" is a guess worth throttling the same way it already is at
    // /api/account/email and /api/register/password: addressPaused/strikeAddress share that
    // budget with both of those routes, a kind no passkey ceremony was ever counted against before.
    const email = normalizeEmail(body.email);
    if (!email) return json(res, 400, EMAIL_ERRORS.invalid);
    if (addressPaused(req, res, 'email')) return;
    if (await emailTaken(email)) {
      strikeAddress(req, 'email');
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    }
    const code = text(body.code).trim().toUpperCase();
    if (INVITE_ONLY && !(await inviteIsValid(pool, code))) {
      // The rejected code itself is never recorded — a near-miss guess in the log is a liability.
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      return json(res, 403, { error: 'a valid invite code is required' });
    }
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = putChallenge({ kind: 'register', challenge: options.challenge, name, uid, code, email, birthDate, termsVersion });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || c.kind !== 'register' || !c.uid) {
      audit(req, 'auth.register.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) {
      // e.message can echo attacker-supplied response fields, so only the reason code is kept.
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'verify-error' });
      return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
    }
    if (!verification.verified) {
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    const { credential } = verification.registrationInfo;
    if (await getPasskeyById(pool, credential.id)) {
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'credential-exists' });
      return json(res, 409, { error: 'credential already registered' });
    }
    // Re-check the invite at the last moment (it may have been used/revoked since options).
    if (INVITE_ONLY && !(await inviteIsValid(pool, c.code))) {
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'invite-invalid' });
      return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    // Re-checked too: the address options validated may have been taken by another signup that
    // finished its own ceremony first.
    if (await emailTaken(c.email)) {
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString(), email: c.email, birthDate: c.birthDate };
    // ISO-1390: the version /options checked, accepted at the moment the account comes to exist.
    user.termsAcceptedVersion = c.termsVersion;
    user.termsAcceptedAt = user.created;
    if (INVITE_ONLY) user.invitedBy = c.code;
    const cred = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || [],
      // What Settings → Passkeys shows (#95); a passkey from before then has neither.
      created: user.created, lastUsed: user.created
    };
    // ISO-1397: a confirmation token is minted in the same transaction as the account — so a
    // signup never exists without one to confirm, and a failed transaction never leaves an
    // orphaned token referencing a user row that was rolled back. The mail itself is sent after
    // commit (below): an outgoing HTTP call has no business inside a database transaction, and a
    // provider outage must not turn a successful signup into a 500.
    const verifyToken = makeEmailToken();
    // createUser, consumeInvite, the passkey and the token all commit or fail together now that
    // every one of them is Postgres — see POST /api/register/password for why (same
    // InviteRaceError, same shape); getPasskeyById above is the cheap pre-check that skips the
    // whole transaction (and the invite it would burn) for the common case of an already-
    // registered credential, but the insert's own unique constraint is still the real backstop
    // against two requests racing here.
    let added;
    try {
      await withTransaction(pool, async client => {
        await createUser(client, user);
        if (INVITE_ONLY && !(await consumeInvite(client, c.code, user.id))) throw new InviteRaceError();
        added = await insertPasskey(client, user.id, cred);
        if (added.error) throw new HttpError(409, added.error);
        await createEmailToken(client, user.id, 'verify', hashEmailToken(verifyToken), VERIFY_TTL_MS);
      });
    } catch (e) {
      if (e instanceof InviteRaceError) {
        audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
      }
      if (e instanceof HttpError) {
        audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: added.code });
        return json(res, e.status, { error: e.message });
      }
      // The e-mail's own unique index is the final backstop against two signups racing the same
      // address past the emailTaken checks above.
      if (e.code === '23505') {
        audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'email-taken' });
        return json(res, 409, EMAIL_ERRORS.taken);
      }
      throw e;
    }
    audit(req, 'auth.register.ok', { user, msg: INVITE_ONLY ? c.code : null });
    await mailVerification(user, verifyToken);
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': await sessionCookie(user, req.headers['user-agent']) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ kind: 'login', challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (c?.kind !== 'login') {
      audit(req, 'auth.login.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    const cred = await getPasskeyById(pool, body.credential?.id);
    if (!cred) {
      // No credential id goes in the log: it is a stable handle for one passkey, and recording it
      // would let an admin correlate an unknown device across attempts. Nothing here identifies
      // the caller beyond the timestamp (and the network, if AUDIT_IP is on).
      audit(req, 'auth.login.fail', { ok: false, msg: 'unknown-credential' });
      return json(res, 404, { error: 'unknown passkey — create a profile first' });
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) {
      audit(req, 'auth.login.fail', { ok: false, user: await getUserById(pool, cred.userId), uid: cred.userId, msg: 'verify-error' });
      return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
    }
    if (!verification.verified) {
      audit(req, 'auth.login.fail', { ok: false, user: await getUserById(pool, cred.userId), uid: cred.userId, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    await touchPasskeyUse(pool, cred.id, verification.authenticationInfo.newCounter);
    const user = await getUserById(pool, cred.userId);
    if (!user) {
      audit(req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'user-missing' });
      return json(res, 500, { error: 'user missing' });
    }
    if (user.disabled) {
      audit(req, 'auth.login.fail', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled' });
    }
    audit(req, 'auth.login.ok', { user });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': await sessionCookie(user, req.headers['user-agent']) });
  },

  // Revokes the session row this cookie names (ISO-1403) — a real logout, not just clearing the
  // cookie client-side: the same token replayed after this is refused by sessionOf's revocation
  // check, same as if it had expired. A cookie with no session row to revoke (minted before this
  // table existed) still just gets cleared, as logout always did before. A logout with no valid
  // session at all is a no-op and isn't worth an audit entry.
  'POST /api/logout': async (req, res) => {
    const s = await sessionOf(req);
    if (s) {
      audit(req, 'auth.logout', { user: s.user });
      if (s.sid) await revokeSession(pool, s.sid);
    }
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = await bumpSessionVersion(pool, user.id);
    // An unredeemed pairing code is a session-in-waiting for this account; it goes too, and so
    // does an unused device link.
    for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
    await dropDeviceLinks(pool, user.id);
    audit(req, 'auth.logout.all', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // Mobile app pairing: called from an already signed-in browser tab (Settings → "Pair the
  // mobile app") to mint a short code the phone can redeem below.
  'POST /api/pair/create': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const code = makePairCode();
    pairings.set(code, { uid: user.id, exp: Date.now() + 5 * 60000 });
    audit(req, 'auth.pair.create', { user });
    json(res, 200, { code });
  },

  // Called from the mobile app itself with the code shown in the browser. No session required —
  // the code IS the credential, one-shot and 5-minute-lived like a WebAuthn challenge.
  'POST /api/pair/redeem': async (req, res) => {
    const body = await readBody(req);
    const code = text(body.code).trim().toUpperCase();
    const p = pairings.get(code);
    if (p) pairings.delete(code);
    if (!p || p.exp < Date.now()) {
      audit(req, 'auth.pair.fail', { ok: false, msg: 'code-invalid' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    const user = await getUserById(pool, p.uid);
    if (!user || user.disabled) {
      audit(req, 'auth.pair.fail', { ok: false, uid: p.uid, msg: 'user-unavailable' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    audit(req, 'auth.pair.ok', { user });
    json(res, 200, { token: await makeSession(user, req.headers['user-agent']), user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  // Absent entirely while PASSWORD_LOGIN is off, so each of them is a plain 404.
  ...(PASSWORD_LOGIN ? passwordRoutes : {}),

  // Verified e-mail + recovery (ISO-1397). Always there — not gated by PASSWORD_LOGIN, since
  // none of it is about signing in with a password: it is the address every new profile now has,
  // confirmed by a link mailed to it, and the one way back in once every passkey is lost.
  // POST /api/account/email is the one handler for that route either way now (ISO-1596) — see
  // its own comment for why there used to be two.
  ...emailRoutes,

  // Always there: more passkeys and device links need nothing an instance has to switch on.
  ...passkeyRoutes,

  // Absent entirely without both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (ISO-1597) — every
  // /api/auth/google/*, /api/account/google/* and /api/register/google route a plain 404, same
  // shape as PASSWORD_LOGIN above.
  ...(GOOGLE_LOGIN ? googleRoutes : {}),

  // `rev` is the server's own count of writes to this profile (also stored inside the document as
  // `_rev`, so every other reader — reminder tick, admin, Coach, MCP — is unaffected). A client
  // pushes it back as `baseRev`, and a write over a document it never saw is refused.
  'GET /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const { state, rev } = await getUserState(pool, user.id);
    await notePull(user);
    json(res, 200, { state, rev });
  },
  // Just the revision: the client asks this every half minute while it is open and on every
  // return to the foreground, and fetches the document only when the number moved — a signed-in
  // device is meant to show what the server has, and this is what keeps that cheap. A narrow
  // `SELECT rev` never touches the (possibly multi-MB) state column, so this needs no cache of
  // its own the way the file-stat one used to.
  'GET /api/data/rev': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { rev: await getUserStateRev(pool, user.id) });
  },

  'PUT /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    // Billing gate (ISO-1393): read and export stay open either way (GET /api/data, and the
    // client's own export, never call this route) — only a new write is refused, and nothing
    // already stored is touched. Off entirely when BILLING_ON is off, same as every other
    // env-gated piece: an instance that never set the Stripe variables writes exactly as before.
    if (BILLING_ON && !(await hasActiveAccess(pool, user.id))) {
      return json(res, 402, { error: 'an active subscription is required to save changes', code: 'billing' });
    }
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    // An object with nothing of the profile in it empties the document with the counter left
    // intact: what lands on disk is `{"_rev":n+1}`, every routine, workout and weigh-in gone, and
    // the next poll reports a revision the client accepts as its own. `_rev` and `_ts` do not
    // count towards "something of the profile" — both are bookkeeping this route writes or echoes
    // itself, so `{}` and `{"_rev":5}` are the same push and get the same refusal. Nothing
    // shipped sends either: the web and mobile clients push a state built on DEF
    // (frontend/src/store/useStore.js), which always carries its keys. An array is a document
    // loss of its own and is left to the `invalid state` check below, which already refuses it.
    if (!Array.isArray(body.state) && !Object.keys(body.state).some(k => k !== '_rev' && k !== '_ts')) {
      return json(res, 400, { error: 'state required' });
    }
    // The reminder tick and the admin routes iterate these two on the server's side, so a truthy
    // non-array would throw there on every pass for as long as it was stored. Absent or null is
    // fine — every client fills its own defaults. An array is `typeof 'object'` but no document:
    // `_rev` set on it is dropped by JSON.stringify, so it would read back as rev 0 while the
    // response claimed the next revision.
    const list = v => v == null || Array.isArray(v);
    if (Array.isArray(body.state) || !list(body.state.workouts) || !list(body.state.routines)) return json(res, 400, { error: 'invalid state' });
    // The same readers walk every entry (`w.d`, `w.name`). They skip what is not an entry now
    // (`records` above), but nothing should be storing one. Dropped, not refused:
    // such an entry carries nothing worth keeping, whereas a 400 would strand a client whose own
    // copy is already malformed — it keeps re-sending the same document and never syncs again.
    for (const k of ['workouts', 'routines']) if (Array.isArray(body.state[k])) body.state[k] = records(body.state[k]);
    // Conditional write: a `baseRev` that is not the current revision means this client last read
    // an older document — another device has written since — and the copy it is about to push
    // would silently drop that write. The current document travels back with the 409, so the
    // client can merge and try again without a second request. No `baseRev` (a client from before
    // revisions, or a deliberate replace such as a backup import) overwrites, as before.
    // putUserState (store.js) is the compare-and-set: it reads the row, hands it to `decide`
    // below, and only writes if `rev` still matches what `decide` saw — a concurrent write from
    // another device between the read and the write is retried against the fresh row rather than
    // silently lost, which a plain read-then-write across an await could otherwise allow here in
    // a way the old synchronous file version never could.
    const result = await putUserState(pool, user.id, (cur, curRev) => {
      if (body.baseRev != null && body.baseRev !== curRev) return { conflict: true };
      const next = { ...body.state };
      delete next.active;                  // in-progress workouts stay device-local
      // "Reset everything" stamps the profile (`resetAt`, with `resetIds`: what it wiped). The
      // stamp only moves forward: a write without it, or with an older one — a client from before
      // it, a backup restored over the profile — keeps the stored stamp. Otherwise every device
      // that saw the reset would take that copy for one older than the reset, and wipe it again
      // on its next merge (frontend/src/lib/sync-merge.js).
      const storedReset = Number(cur?.resetAt) || 0;
      if (storedReset > (Number(next.resetAt) || 0)) {
        next.resetAt = cur.resetAt;
        if (cur.resetIds && typeof cur.resetIds === 'object') next.resetIds = cur.resetIds;
        else delete next.resetIds;
      }
      next._rev = curRev + 1;              // server-owned; whatever the client sent is ignored
      return { state: next };
    });
    if (result.conflict) return json(res, 409, { error: 'conflict', rev: result.rev, state: result.state });
    // Starts (or stops) the grace clock of every stored file this write stopped (or started)
    // referencing. Bookkeeping only: the state is already saved, so nothing here may turn a
    // successful write into an error.
    if (MEDIA_ON) {
      try { MEDIA.noteState(user.id, result.state); } catch (e) { console.error('media noteState', e); }
    }
    json(res, 200, { ok: true, ts: result.state._ts || null, rev: result.rev });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    const bad = pushEndpointError(sub.endpoint);
    if (bad) return json(res, 400, { error: bad });
    // Only the two keys the push protocol needs are kept: `sub` is caller-supplied and would
    // otherwise put arbitrary fields into the row, which every admin route reads back out.
    const keys = { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) };
    const deviceId = deviceIdOf(body.deviceId);
    // An upsert: the client re-sends its subscription on every boot (lib/push.js) so a row this
    // instance lost — pruned after a dead send — comes back without anyone touching Settings.
    // The same endpoint sent again keeps its original `created` (upsertSub's ON CONFLICT never
    // touches created_at).
    await upsertSub(pool, { userId: user.id, endpoint: sub.endpoint, keys, deviceId });
    // A browser holds one subscription per device, so this cap is far above real use. Without
    // it a single account could pile up endpoints without limit — every one of them a target
    // sendPush() would then contact.
    await capUserSubs(pool, user.id, MAX_SUBS_PER_USER);
    json(res, 200, { ok: true });
  },

  // Whether this instance still holds the caller's subscription for `endpoint`. The browser's
  // side (PushManager.getSubscription) says nothing about ours — a row pruned after a dead send
  // leaves the browser subscribed to nowhere — so Settings asks here before it shows "on".
  'GET /api/push/status': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const endpoint = new URL(req.url, 'http://x').searchParams.get('endpoint') || '';
    json(res, 200, { subscribed: await subStatus(pool, user.id, endpoint) });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    await unsubscribe(pool, user.id, body.endpoint);
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, testPush((await readState(user.id))?.lang));
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    // Validated before it is clamped: the clamp used to run first, which turned a missing or
    // unusable value into a 1-second push and made the 400 below unreachable. `Number()` only
    // on a number or a string — on an object it can throw.
    const raw = body.seconds;
    const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!(n >= 1)) return json(res, 400, { error: 'seconds required' });
    const sec = Math.min(3600, Math.round(n));
    scheduleRestTimer(user.id, deviceIdOf(body.deviceId), sec, (await readState(user.id))?.lang);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    cancelRestTimer(user.id, deviceIdOf(body.deviceId));
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: text(body.name).slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (one user_state query each, in
  // parallel — Postgres, not a directory of files, is what's paying for these now).
  //
  // ISO-1447 (item 2 of ISO-1394, LGPD): an admin runs the instance, not its users' training —
  // nothing here answers with a workout count, a last-workout date, or (via `live`, below) which
  // routine or how many sets someone is mid-way through right now. `lastSync` stays: it is an
  // operational signal ("is this account even in use"), not a training fact.
  'GET /api/admin/users': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const users = await Promise.all((await getAllUsers(pool)).map(async u => {
      const S = (await readState(u.id)) || {};
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        lastSync: lastSyncOf(u, S),
        hasPush: await hasPush(pool, u.id),
        // Was: the live routine name and set-by-set progress (livePresence(u.id)). Whether a
        // workout is in progress at all is still worth an admin seeing (FR-… "training now"); its
        // content is not.
        online: !!livePresence(u.id),
        // `password`/`email` here are about password sign-in specifically (whether to offer a
        // reset code, which address a reset is redeemed with) — unchanged by ISO-1596 unifying
        // `email` itself; still only worth showing on an instance that takes passwords at all.
        ...(PASSWORD_LOGIN ? { password: hasPassword(u), email: u.email || null } : {})
      };
    }));
    json(res, 200, { users, invite_only: INVITE_ONLY, ...(PASSWORD_LOGIN ? { password_login: true } : {}), now: Date.now() });
  },

  // Drill-down: account + billing only (ISO-1447) — no routines, bodyweight, workouts or unit.
  // Before this, this route doubled as the dashboard's "export before you delete" offer; that
  // training-history export is a separate concern now (the app side of ISO-1394, not this route).
  'GET /api/admin/user': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = await getUserById(pool, id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = (await readState(u.id)) || {};
    json(res, 200, {
      user: {
        id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        // Only on an instance with password sign-in: whether they have one, the address a reset
        // code is redeemed with, and until when an unused reset code is good.
        ...(PASSWORD_LOGIN ? { password: hasPassword(u), email: u.email || null, resetUntil: u.pwReset?.exp > Date.now() ? u.pwReset.exp : null } : {})
      },
      lastSync: lastSyncOf(u, S),
      // status/plan/dates — billingStatus is the exact same contract GET /api/billing/status
      // gives the account itself, reused rather than re-derived here.
      subscription: BILLING_ON ? await billingStatus(pool, u.id) : null
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = await getUserById(pool, body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    await setDisabled(pool, u.id, u.disabled);
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    // A device link made before the lock would otherwise still be waiting when it is lifted.
    if (u.disabled) await dropDeviceLinks(pool, u.id);
    audit(req, u.disabled ? 'admin.user.disable' : 'admin.user.enable', { user: admin, target: u });
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  // Disable locks an account out; this removes it. The one destructive action in the app, so the
  // client asks twice and this end refuses the two cases that cannot be undone from the UI
  // afterwards: an admin deleting themselves (DELETE /api/account, below, is how someone removes
  // their own account), and the last admin standing (issue #107). The invite code that let them in
  // stays burned — it was used, and freeing it would quietly widen an invite-only instance.
  'POST /api/admin/user/delete': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = await getUserById(pool, body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.id === admin.id) return json(res, 400, { error: 'you cannot delete your own account' });
    if (isAdmin(u) && (await getAllUsers(pool)).filter(isAdmin).length <= 1) return json(res, 400, { error: 'cannot delete the last admin' });
    const name = u.name;
    await deleteAccount(u);
    // Logged with the name, because the id is about to mean nothing to anyone reading this back —
    // the admin themselves (who did it) is still just `user: admin`, their own id and name.
    audit(req, 'admin.user.delete', { user: admin, msg: name });
    json(res, 200, { ok: true, id: u.id });
  },

  // Self-service (ISO-1447): the same deletion admin/user/delete does, for your own account. A
  // session alone is not proof enough — see proveOwner's own comment — so a stolen cookie cannot
  // delete the account out from under its owner; `code: 'last-admin'` is this route's own half of
  // the last-admin rule (the other half, an admin targeting someone else, is that route's own
  // check right above). Audited with the id alone, never the name — see proveOwner's `act` and
  // audit()'s own `f.uid`/`f.user` split.
  'DELETE /api/account': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (isAdmin(user) && (await getAllUsers(pool)).filter(isAdmin).length <= 1) {
      return json(res, 400, { error: 'you are the last admin — make someone else admin first', code: 'last-admin' });
    }
    const proof = await proveOwner(req, res, user, body, 'account-delete');
    if (!proof) return;
    // Everything above awaited: a concurrent "sign out everywhere" or admin action may have ended
    // this session, and a concurrent admin/user/delete of the one other admin may have made this
    // account the last one in the meantime.
    const fresh = await sessionStillValid(req, user);
    if (!fresh) return json(res, 401, { error: 'not signed in' });
    if (isAdmin(fresh) && (await getAllUsers(pool)).filter(isAdmin).length <= 1) {
      return json(res, 400, { error: 'you are the last admin — make someone else admin first', code: 'last-admin' });
    }
    await deleteAccount(fresh);
    audit(req, 'account.delete', { uid: fresh.id });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    // resolve usedBy uid → name for display
    const [users, invites] = await Promise.all([getAllUsers(pool), getAllInvites(pool)]);
    const withNames = invites.map(i => ({
      ...i, usedByName: i.usedBy ? (users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites: withNames, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. Passkey signup has no rate limiting by
    // design (that's the reverse proxy's job) and /api/register/options tells a caller whether a
    // code is good, so the code itself has to be the thing that isn't worth guessing. Codes already
    // issued keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (await codeExists(pool, code));
    const note = text(body.note).slice(0, 60);
    await createInvite(pool, { code, note, createdBy: admin.id });
    audit(req, 'admin.invite.create', { user: admin, msg: code });
    json(res, 200, { invite: { code, ...(note ? { note } : {}), createdBy: admin.id, created: new Date().toISOString() } });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const code = text(body.code).toUpperCase();
    if (await revokeInvite(pool, code)) {
      audit(req, 'admin.invite.revoke', { user: admin, msg: code });
      return json(res, 200, { ok: true });
    }
    // revokeInvite doesn't distinguish "no such code" from "already used" — both are 0 rows
    // deleted — so a cheap follow-up read picks the right answer. A code used between the delete
    // attempt and this read is exactly "already used": the response is still correct.
    const stillThere = await codeExists(pool, code);
    return json(res, stillThere ? 400 : 404, stillThere ? { error: 'already used — cannot revoke' } : { error: 'no such code' });
  },

  /* ---------- admin: training program catalog (ISO-1485) ----------
   * Admin-only end to end — every route below starts with requireAdmin, same guard and same
   * 403 + admin.denied as the rest of /api/admin/*. "Program" is the one name this entity goes
   * by (docs/ADMIN_PROGRAMS.md §1): never "training", which collides with Workout/Routine
   * already meaning something else in this codebase.
   */
  'GET /api/admin/programs': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const trash = /^(1|true)$/i.test(q.get('trash') || '');
    const category = q.get('category') || '';
    const difficulty = q.get('difficulty') || '';
    const status = q.get('status') || '';
    if (category && !PROGRAM_CATEGORIES.includes(category)) return json(res, 400, { error: 'invalid category filter', field: 'category' });
    if (difficulty && !PROGRAM_DIFFICULTIES.includes(difficulty)) return json(res, 400, { error: 'invalid difficulty filter', field: 'difficulty' });
    if (status && !['draft', 'published'].includes(status)) return json(res, 400, { error: 'invalid status filter', field: 'status' });
    const [rows, users, trashCountRow] = await Promise.all([
      listPrograms(pool, { q: q.get('q') || '', category, difficulty, status, trash }),
      getAllUsers(pool),
      pool.query('SELECT count(*)::int AS n FROM programs WHERE deleted_at IS NOT NULL')
    ]);
    const nameOf = id => id ? (users.find(u => u.id === id) || {}).name || null : null;
    const programs = rows.map(p => ({
      ...p,
      ...(p.createdBy ? { createdByName: nameOf(p.createdBy) } : {}),
      ...(p.updatedBy ? { updatedByName: nameOf(p.updatedBy) } : {}),
      ...(p.deletedBy ? { deletedByName: nameOf(p.deletedBy) } : {})
    }));
    json(res, 200, { programs, trashCount: trashCountRow.rows[0].n });
  },

  // Enum values + labels, field limits and the two configurable knobs — everything the form needs
  // to validate client-side before it ever POSTs, and everything the lists need to render chips.
  'GET /api/admin/programs/meta': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    json(res, 200, {
      categories: PROGRAM_CATEGORIES.map(value => ({ value, label: PROGRAM_CATEGORY_LABELS[value] })),
      difficulties: PROGRAM_DIFFICULTIES.map(value => ({ value, label: PROGRAM_DIFFICULTY_LABELS[value] })),
      limits: {
        title: { min: PROGRAM_TITLE_MIN, max: PROGRAM_TITLE_MAX },
        description: { max: PROGRAM_DESCRIPTION_MAX },
        sessionMinutes: { min: SESSION_MINUTES_MIN, max: SESSION_MINUTES_MAX },
        coverAlt: { min: COVER_ALT_MIN, max: COVER_ALT_MAX },
        coverDims: { minWidth: COVER_WIDTH_MIN, minHeight: COVER_HEIGHT_MIN, max: COVER_DIM_MAX }
      },
      trashDays: PROGRAM_CFG.trashDays,
      coverMaxMB: PROGRAM_CFG.coverMaxMB
    });
  },

  'GET /api/admin/program': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const [program, events] = await Promise.all([getProgram(pool, id), listProgramEvents(pool, id, 50)]);
    if (!program) return json(res, 404, { error: 'no such program' });
    const users = await getAllUsers(pool);
    const nameOf = uid => uid ? (users.find(u => u.id === uid) || {}).name || null : null;
    json(res, 200, {
      program: {
        ...program,
        ...(program.createdBy ? { createdByName: nameOf(program.createdBy) } : {}),
        ...(program.updatedBy ? { updatedByName: nameOf(program.updatedBy) } : {}),
        ...(program.deletedBy ? { deletedByName: nameOf(program.deletedBy) } : {})
      },
      history: events
    });
  },

  'POST /api/admin/programs/new': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const v = validateProgram(body, { partial: false });
    if (!v.ok) return json(res, 400, { error: v.error, field: v.field });
    const result = await createProgram(pool, v.value, { id: admin.id, name: admin.name });
    if (result.error) return programError(res, result);
    audit(req, 'admin.program.create', { user: admin, target: { id: result.row.id, name: result.row.title } });
    json(res, 200, { program: result.row });
  },

  'POST /api/admin/program/update': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = text(body.id);
    const rev = Number(body.rev);
    if (!id || !Number.isInteger(rev)) return json(res, 400, { error: 'id and rev are required' });
    const v = validateProgram(body, { partial: true });
    if (!v.ok) return json(res, 400, { error: v.error, field: v.field });
    const result = await updateProgram(pool, id, rev, v.value, { id: admin.id, name: admin.name });
    if (result.error) return programError(res, result);
    // Explicit literals, not string concatenation: frontend/src/lib/audit.test.js statically
    // scans this file for audit() calls whose event name is a plain quoted string, to make sure
    // every event the server can emit has a human sentence — a name built up at runtime is
    // invisible to that scan.
    const action = { update: 'admin.program.update', publish: 'admin.program.publish', unpublish: 'admin.program.unpublish' }[result.action];
    if (action) audit(req, action, { user: admin, target: { id: result.row.id, name: result.row.title } });
    json(res, 200, { program: result.row });
  },

  'POST /api/admin/program/trash': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = text(body.id);
    const rev = Number(body.rev);
    if (!id || !Number.isInteger(rev)) return json(res, 400, { error: 'id and rev are required' });
    const result = await trashProgram(pool, id, rev, { id: admin.id, name: admin.name });
    if (result.error) return programError(res, result);
    audit(req, 'admin.program.trash', { user: admin, target: { id: result.row.id, name: result.row.title } });
    json(res, 200, { program: result.row });
  },

  'POST /api/admin/program/restore': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = text(body.id);
    if (!id) return json(res, 400, { error: 'id is required' });
    const result = await restoreProgram(pool, id, { id: admin.id, name: admin.name });
    if (result.error) return programError(res, result);
    audit(req, 'admin.program.restore', { user: admin, target: { id: result.row.id, name: result.row.title } });
    json(res, 200, { program: result.row });
  },

  // Only from the trash, and only with the title typed back exactly — purgeProgram re-checks the
  // match itself (never trusting the client's own gate), and the row is gone before this answers.
  'POST /api/admin/program/purge': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = text(body.id);
    if (!id) return json(res, 400, { error: 'id is required' });
    const result = await purgeProgram(pool, id, text(body.confirmTitle), { id: admin.id, name: admin.name });
    if (result.error) return programError(res, result);
    if (result.coverFile && !result.coverStillReferenced) unlinkProgramCover(result.coverFile);
    audit(req, 'admin.program.purge', { user: admin, msg: result.title });
    json(res, 200, { ok: true });
  },

  // Raw image bytes in the body, like PUT /api/media/{hash} — but admin-only, capped much smaller
  // (PROGRAM_COVER_MAX_MB) and read whole into memory rather than streamed: a personal catalog's
  // cover art is rare and small enough that the simplicity is worth more than media.js's incremental
  // hashing. `w`/`h`/`alt` ride the query string since the body is the file itself.
  'PUT /api/admin/program/cover': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const id = q.get('id') || '';
    const rev = Number(q.get('rev'));
    if (!id || !Number.isInteger(rev)) { await readRawBody(req); return json(res, 400, { error: 'id and rev are required' }); }
    const dims = validateCoverDims(Number(q.get('w')), Number(q.get('h')));
    if (!dims.ok) { await readRawBody(req); return json(res, 400, { error: dims.error, field: dims.field }); }
    const program = await getProgram(pool, id);
    const alt = validateCoverAlt(q.get('alt') || '', program?.title);
    if (!alt.ok) { await readRawBody(req); return json(res, 400, { error: alt.error, field: alt.field }); }
    const buf = await readRawBody(req);
    const maxBytes = Math.round(PROGRAM_CFG.coverMaxMB * 1024 * 1024);
    if (buf.length > maxBytes) return json(res, 413, { error: 'that file is too large', maxMB: PROGRAM_CFG.coverMaxMB });
    const sniffed = sniffMedia(buf.subarray(0, 64));
    const ext = sniffed && PROGRAM_COVER_EXT[sniffed.mime];
    if (!ext) return json(res, 415, { error: 'cover must be a JPEG, PNG or WebP image' });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const file = `${sha}.${ext}`;
    try { fs.writeFileSync(programCoverPath(file), buf, { mode: 0o600 }); }
    catch (e) { console.error('program-covers: could not write', file, e.message); return json(res, 500, { error: 'server error' }); }
    const result = await setProgramCover(pool, id, rev, {
      file, mime: sniffed.mime, width: dims.value.width, height: dims.value.height, bytes: buf.length, alt: alt.value
    }, { id: admin.id, name: admin.name });
    if (result.error) { unlinkProgramCover(file); return programError(res, result); }
    if (result.oldFile && !result.oldStillReferenced) unlinkProgramCover(result.oldFile);
    audit(req, 'admin.program.cover.set', { user: admin, target: { id: result.row.id, name: result.row.title } });
    json(res, 200, { program: result.row });
  },

  'POST /api/admin/program/cover/remove': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = text(body.id);
    const rev = Number(body.rev);
    if (!id || !Number.isInteger(rev)) return json(res, 400, { error: 'id and rev are required' });
    const result = await clearProgramCover(pool, id, rev, { id: admin.id, name: admin.name });
    if (result.error) return programError(res, result);
    if (result.oldFile && !result.oldStillReferenced) unlinkProgramCover(result.oldFile);
    audit(req, 'admin.program.cover.remove', { user: admin, target: { id: result.row.id, name: result.row.title } });
    json(res, 200, { program: result.row });
  },

  // Streamed like sendMediaFile, minus the per-profile access check (the directory check there
  // has no equivalent here — a Program has no owner — requireAdmin is the whole access check).
  // Immutable cache: the filename is the content's own hash, so a changed cover is always a new
  // URL, never a cache invalidation problem.
  'GET /api/admin/program/cover': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const program = await getProgram(pool, id);
    if (!program || !program.coverFile) return json(res, 404, { error: 'no such cover' });
    let fd;
    try { fd = fs.openSync(programCoverPath(program.coverFile), 'r'); }
    catch { return json(res, 404, { error: 'no such cover' }); }
    const size = fs.fstatSync(fd).size;
    res.writeHead(200, {
      'Content-Type': program.coverMime,
      'Content-Length': String(size),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff'
    });
    try { await pipeline(fs.createReadStream(null, { fd }), res); }
    catch { res.destroy(); }
  },

  /* ---------- activity log ---------- */
  // Newest first, paged by id. Not by offset: the log grows at the front of this view, so an
  // offset cursor would repeat a row whenever an event lands between two pages; and not by
  // timestamp, because two events can share a millisecond. auditKeep() runs on read as well as
  // on the hourly compaction, so nothing past its retention is ever served.
  'GET /api/admin/audit': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Math.min(200, +q.get('limit') || 100));
    const before = +q.get('before') || Infinity;
    const cat = q.get('cat') || '';
    let rows = auditKeep(auditLines()).reverse();
    if (cat === 'fail') rows = rows.filter(r => !r.ok);
    else if (cat) rows = rows.filter(r => String(r.ev).startsWith(cat + '.'));
    const page = rows.filter(r => r.id < before).slice(0, limit);
    json(res, 200, {
      events: page,
      total: rows.length,
      nextBefore: page.length === limit ? page[page.length - 1].id : null,
      enabled: AUDIT_ON, ip_mode: AUDIT_IP,
      retention: { max: AUDIT_MAX, days: AUDIT_DAYS },
      now: Date.now()
    });
  },

  // Deleting the log is itself logged, and auditSeq is not reset — so a clear always leaves a
  // visible gap in the ids and can't be used to quietly erase a trace. There is no export route:
  // ./data/audit.log already is the export, in a format jq reads directly.
  'POST /api/admin/audit/clear': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    try { fs.unlinkSync(auditFile); } catch { /* nothing logged yet */ }
    auditCount = 0;
    audit(req, 'admin.audit.clear', { user: admin });
    json(res, 200, { ok: true });
  },

  /* ---------- AI Coach ---------- */
  // Routes live in coach/routes.js and are handed the helpers above rather than importing
  // them: they are closures over `pool` and SECRET, and passing them in keeps that module free
  // of a cycle. Every one of them is inert while the feature is unconfigured.
  ...coachRoutes({ json, readBody, readSession, requireAdmin }),

  /* ---------- billing (Stripe, Phase 3 — ISO-1393) ---------- */
  // Every route here is a 404 while BILLING_ON is off (no STRIPE_API_KEY/STRIPE_WEBHOOK_SECRET
  // set) — same shape as the Coach and media routes: an instance that never configures Stripe is
  // byte-for-byte the self-hosted app it was before this phase. GET /api/billing/status is the one
  // exception, answering `{enabled:false}` instead, so a signed-in client can tell "no billing on
  // this instance" apart from "no subscription yet" without a 404 on every poll.
  'GET /api/billing/status': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (!BILLING_ON) return json(res, 200, { enabled: false });
    json(res, 200, await billingStatus(pool, user.id));
  },
  'POST /api/billing/checkout': async (req, res) => {
    if (!BILLING_ON) return json(res, 404, { error: 'billing not configured' });
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    // ISO-1390: no subscription for an account that has not accepted the current terms — they are
    // the contract the payment is made under. Checked before the e-mail on purpose: when both are
    // missing, the terms sheet is the blocking one the app should show first.
    if (user.termsAcceptedVersion !== LEGAL_VERSION) {
      return json(res, 403, { error: 'accept the current terms first', code: 'terms-required' });
    }
    // Issue rule: checkout requires a verified e-mail (Phase 2) — the trial_will_end and renewal
    // notices this phase sends have nowhere to go otherwise.
    if (!user.emailVerifiedAt) return json(res, 403, { error: 'e-mail not verified', code: 'email-unverified' });
    const body = await readBody(req);
    const result = await createCheckoutSession(pool, user, text(body.plan), {
      successUrl: `${APP_URL}/#/configuracoes?billing=sucesso`,
      cancelUrl: `${APP_URL}/#/configuracoes?billing=cancelado`
    });
    if (result.error) return json(res, 400, { error: result.error, code: 'invalid-plan' });
    audit(req, 'billing.checkout', { user, msg: text(body.plan) });
    json(res, 200, { url: result.url });
  },
  'POST /api/billing/portal': async (req, res) => {
    if (!BILLING_ON) return json(res, 404, { error: 'billing not configured' });
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const result = await createPortalSession(pool, user, { returnUrl: `${APP_URL}/#/configuracoes` });
    if (result.error) return json(res, 400, { error: result.error, code: 'no-customer' });
    json(res, 200, { url: result.url });
  },
  // No session and no CSRF check: Stripe's own server-to-server POST carries no cookie and no
  // Origin header, which csrfOk already treats the same way curl or a monitoring check would (not
  // a browser, so nothing to protect against). The signature check below is this route's real
  // authentication. Raw body, not readBody — see readRawBody's own comment for why.
  'POST /api/billing/webhook': async (req, res) => {
    if (!BILLING_ON) return json(res, 404, { error: 'billing not configured' });
    const sig = req.headers['stripe-signature'];
    const raw = await readRawBody(req);
    let event;
    try { event = getStripe().webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch (e) { return json(res, 400, { error: 'invalid signature' }); }
    // claimStripeEvent is the atomic single-use claim (store.js) — a Stripe retry or `stripe
    // listen` redelivering the same event finds its id already a row and applyStripeEvent never
    // runs twice for it. But the claim landing is not the same as the event's effect actually
    // having happened: applyStripeEvent's 'customer.subscription.created' case can call out to
    // Stripe itself (converting a first-ever subscription into a Subscription Schedule), and that
    // is the one thing in this whole route that can fail for a reason that has nothing to do with
    // our own data. A claim left in place after that throws would mean this exact event.id reads
    // back as "already handled" forever — Stripe's own retry would find nothing left to do and the
    // account would be stuck paying the R$1,99 Price every cycle, with no automatic way out. So an
    // apply that throws undoes its own claim before the error reaches the catch-all below (which
    // answers 500, and a 500 is what tells Stripe to retry this delivery) — the next attempt gets a
    // genuine second try, not a no-op.
    const claimed = await claimStripeEvent(pool, { id: event.id, type: event.type, data: event.data.object });
    if (claimed) {
      try { await applyStripeEvent(pool, event); }
      catch (e) {
        await unclaimStripeEvent(pool, event.id).catch(e2 => console.error('billing: could not unclaim', event.id, e2.message));
        throw e;
      }
    }
    json(res, 200, { ok: true, duplicate: !claimed });
  },

  /* ---------- photos & videos ---------- */
  // Absent, not refusing, when MEDIA_UPLOADS=0: a 404 is what a server from before the feature
  // answers, and the client already treats that as "this server does not store them".
  ...(MEDIA_ON ? mediaRoutes : {})
};

/* ---------- Coach: boot recovery, notifications, scheduled reviews ---------- */
// A job that was running when the process died is not coming back; say so rather than leaving
// a spinner that never resolves.
coachJobs.recoverOnBoot();
// A ready proposal is the one Coach event worth a notification. Failures and "nothing to
// change" stay silent on purpose (FR-38/E4).
coachJobs.setProposalHook((uid, pending) => {
  const n = (pending?.changes || []).length;
  if (!n) return;
  sendPush(uid, {
    title: 'Your Coach has been reading',
    body: n === 1 ? '1 suggestion after this week' : `${n} suggestions after this week`,
    tag: 'coach-proposal', url: '#/coach'
  });
});
startCadence({ users: () => usersCache, userNow });
startWarmup();

/* ---------- billing: first-period-ending notice (ISO-1393) ---------- */
// There is no Stripe trial in this design (ISO-1392: the R$1,99 month is a sub-state of `active`,
// never `trialing`), so there is no `trial_will_end` webhook to hook the warning e-mail off —
// tickFirstPeriodNotices (billing.js) checks on our own clock instead, hourly, which is plenty
// granular against a 3-day window. Off entirely when BILLING_ON is off: an instance that never
// configured Stripe can never have a subscription row for this to find anyway.
// renderPreChargeNotice is ISO-1397's own catalog entry, written for exactly this moment ("nothing
// calls this yet ... Phase 3 is what sends it") — reused rather than duplicated.
setFirstPeriodNoticeHook(async (uid, sub) => {
  const user = await getUserById(pool, uid);
  if (!user?.email) return; // nothing mailed an account with no address to mail
  const cents = nextChargeAmountCents(sub);
  const amount = cents != null
    ? (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'o valor do seu plano';
  const d = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const billingDate = d
    ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
    : 'em breve';
  const { subject, text: body, html } = renderPreChargeNotice({ name: user.name, amount, billingDate, appUrl: APP_URL });
  try { await sendMail({ to: user.email, subject, text: body, html }); }
  catch (e) { console.error('mail: could not send pre-charge notice e-mail', e.message); }
});
if (BILLING_ON) setInterval(() => {
  tickFirstPeriodNotices(pool).catch(e => console.error('billing: first-period notice tick failed', e));
}, 60 * 60000).unref();

// node's requestTimeout is one number for every route, and it is half an hour (below) for the
// sake of one: a video uploaded over a slow uplink. Every other request keeps node's old five
// minutes to finish sending its body — readBody has no timer of its own, and a trickled body on
// any route, the unauthenticated CSRF-exempt POSTs included, would otherwise hold its socket six
// times as long. The upload route lifts it (req.allowSlowBody) only once the session and the
// hourly budget have let the upload in; from there media.js's own idle timer takes over. The
// tests shorten it, as they do REMINDER_TICK_MS.
const BODY_TIMEOUT_MS = Math.max(50, +(process.env.BODY_TIMEOUT_MS || 300000) || 300000);
function bodyDeadline(req) {
  if (req.complete) return;
  // The socket itself, not req: a route that answered without reading the body has finished its
  // response, and node has already closed req (a no-op to destroy again) while the body trickles
  // on. Only 'end' clears it — 'close' also fires at that early answer.
  const socket = req.socket;
  const timer = setTimeout(() => { if (!req.complete) socket.destroy(); }, BODY_TIMEOUT_MS);
  timer.unref();
  const clear = () => clearTimeout(timer);
  req.once('end', clear);
  req.allowSlowBody = clear;
}

const server = http.createServer(async (req, res) => {
  bodyDeadline(req);
  // Same-origin (the deployed nginx-proxied web app) never triggers CORS, so this only matters
  // for the paired mobile app calling in from its own WebView origin. It carries no cookie
  // (auth is the Authorization header instead), so Allow-Credentials is deliberately never set —
  // reflecting the origin here can't expose the cookie session to anyone.
  const origin = req.headers.origin;
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  // A target that does not parse (`//`, `//api%2Fhealth`) is a bad request, not a server error —
  // and the try below only covers the route handler, so it is refused here.
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return json(res, 400, { error: 'bad request' }); }
  let key = req.method + ' ' + url.pathname;
  // The one route with a parameter in its path. Mapped onto its template key here so the table
  // above stays a plain lookup, and so csrfOk and the catch-all see one name for every file.
  const mm = /^\/api\/media\/([0-9a-f]{64})$/.exec(url.pathname);
  if (mm) { key = req.method + ' /api/media/{hash}'; req.mediaHash = mm[1]; }
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  if (!csrfOk(req, key)) {
    // Logged, not audited: this is reachable without a session, and an audit entry per attempt
    // would let anyone fill the log. An operator who has genuinely mis-set ORIGIN needs to see
    // the mismatch, and the container log is where they will look.
    console.warn('refused cross-origin', key, 'origin=' + req.headers.origin, 'expected=' + ORIGIN);
    return json(res, 403, { error: 'cross-origin request refused' });
  }
  // After the origin check, so a forged request spends nobody's budget. The password routes only
  // (see the sign-in throttle above).
  if (key in THROTTLED) {
    const addr = limitAddress(req);
    const kind = THROTTLED[key];
    const wait = AUTH_BURST.take(addr) || (kind ? ADDR_FAILS.retryAfter(kind + '|' + addr) : 0);
    if (wait) return tooMany(res, wait);
  }
  try { await handler(req, res); }
  catch (e) {
    if (e?.clientGone) { console.warn(key, 'client went away mid-body:', e.message); return; }
    if (e instanceof HttpError) {
      if (!res.headersSent) json(res, e.status, { error: e.message });
      return;
    }
    // A refused upload or a missing file: the caller's to act on, never a logged 500.
    if (e instanceof MediaError) {
      if (!res.headersSent) json(res, e.status, { error: e.message, code: e.code, ...e.extra }, e.headers);
      return;
    }
    // Every scrypt slot and the short queue behind them are taken (password.js).
    if (e instanceof BusyError) {
      if (!res.headersSent) json(res, 503, { error: 'the server is busy — try again in a moment', code: 'busy' }, { 'Retry-After': '2' });
      return;
    }
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});
// Node's default of 300 s for a whole request would answer 408 to a 40 MB video on a ~1 Mbit/s
// uplink. Half an hour covers that; a stalled upload is cut much sooner by its own 60 s idle
// timer in media.js, a client that never finishes its headers still meets headersTimeout, and
// every other route's body still has to arrive within five minutes (bodyDeadline above).
server.requestTimeout = 30 * 60000;
server.headersTimeout = 60000;

// Connect and migrate before accepting any request. A failure here — unreachable database or a
// broken migration — is a boot failure, not something callers should ever see as a 500.
async function listen() {
  try {
    const r = await connectAndMigrate(DATABASE_URL);
    pool = r.pool;
    // jobs.js's own readState/listUserIds (used by cohort.js and cadence.js too) need this —
    // same idea as setProposalHook above: a setter, since jobs.js is imported (and its own
    // setInterval-driven callers may already be ticking) before any pool exists.
    coachJobs.setPool(pool);
    console.log(`postgres ready (${r.count} migration${r.count === 1 ? '' : 's'} applied)`);
  } catch (e) {
    console.error('postgres connection/migration failed:', e.message);
    process.exit(1);
  }
  // One-time migration of whatever db.json still holds from before this boot (an instance
  // upgrading from a pre-1403 build, or a test fixture that seeds db.json directly) — every
  // collection it ever held, into PostgreSQL. Read once into a local `db`, not the module-level
  // global the issue asked to remove: nothing after boot needs it again, since every read/write
  // from here on is a table.
  const db = readBootDb();
  // Users: two passes, same shape as scripts/import-json.js and for the same reason:
  // password_reset_by is self-referential and db.json's users array has no guaranteed order, so
  // the admin who issued a pending reset may not have a row yet on the first pass. Sequential, not
  // Promise.all: a personal instance has few enough users that boot time is not the concern, and
  // a boot failure here should point at one clear id.
  for (const u of db.users) {
    try { await upsertUser(pool, u); } catch (e) { console.error('could not migrate user into postgres', u.id, e.message); process.exit(1); }
  }
  for (const u of db.users) {
    try { await backfillPasswordResetBy(pool, u.id, u.pwReset?.by); } catch (e) { console.error('could not backfill password_reset_by for', u.id, e.message); process.exit(1); }
  }
  usersCache = await getAllUsers(pool);
  // Invites — after the users pass above, so created_by/used_by (both foreign keys on users(id))
  // have something to reference. A `.revoked` invite is skipped rather than imported: the live
  // routes only ever revoke by deleting the row (there is no `revoked` column — see
  // migrations/001), so a code already flagged that way in old db.json is gone, the same as if it
  // had been revoked through the app itself.
  for (const i of db.invites) {
    if (i.revoked) continue;
    try { await upsertInvite(pool, i); } catch (e) { console.error('could not migrate invite into postgres', i.code, e.message); process.exit(1); }
  }
  // Push subscriptions — not fatal on failure, unlike users/invites above: a subscription this
  // fails to carry over (a dangling userId nobody has, a malformed db.json entry) is not data
  // anyone can lose in a way that matters, since the client re-sends its subscription itself on
  // its next boot (lib/push.js).
  for (const s of db.subs) {
    try { await upsertSub(pool, s); } catch (e) { console.error('could not migrate push subscription into postgres', s.endpoint, e.message); }
  }
  // Device links — also not fatal: an unmigrated one just means whoever was mid-pairing has to
  // make a new code, the same as if it had simply expired.
  for (const l of db.deviceLinks) {
    try { await upsertDeviceLink(pool, l); } catch (e) { console.error('could not migrate device link into postgres', e.message); }
  }
  // Passkeys — the last db.json collection. Not fatal either: a credential this fails to carry
  // over means whoever owns it adds a new one, the same recovery as a lost security key always
  // needed.
  for (const c of db.creds) {
    try { await upsertPasskey(pool, c); } catch (e) { console.error('could not migrate passkey into postgres', c.id, e.message); }
  }
  // The port is read back off the listener rather than echoed from PORT, so the line states the
  // port that was actually bound: with PORT=0 the OS picks one, and a caller that did not choose
  // it (the tests spawn the server that way, and so does anyone running two instances on one
  // box) has no other way to learn it.
  server.listen(PORT, () => console.log(`gym-api on :${server.address().port} (rpID=${RP_ID}, origin=${ORIGIN})`));
}
listen();
