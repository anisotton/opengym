/* "Sign in with Google" (ISO-1597) — the OpenID Connect mechanics only: PKCE, discovery, JWKS
 * caching and ID token verification. No new dependency (CONTRIBUTING.md) — `fetch` and
 * `node:crypto` only, same constraint the rest of api/ already keeps to.
 *
 * Deliberately does real OIDC discovery (GET the provider's `.well-known/openid-configuration`
 * for its authorization/token/jwks endpoints) rather than hard-coding Google's own three URLs.
 * That costs one extra fetch per process lifetime, paid back by needing exactly one seam for
 * tests: GOOGLE_OAUTH_TEST_DISCOVERY_URL (read once, below) points discovery at an in-process
 * fake server; whatever endpoints *that* document advertises — token, jwks — are then whatever
 * the fake server says, with no second or third override needed. Production never sets it, and
 * it is not documented in .env.example on purpose: it exists for api/test/*, not for a self-
 * hoster to point this at some other identity provider (Google is the one this was built and
 * reviewed against; a generic OIDC login is a different, larger feature).
 */
import crypto from 'node:crypto';

const GOOGLE_DISCOVERY_URL = process.env.GOOGLE_OAUTH_TEST_DISCOVERY_URL
  || 'https://accounts.google.com/.well-known/openid-configuration';
export const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
// ID tokens are valid for roughly an hour; this only bounds how far this clock and Google's may
// disagree, same reasoning as every other "a few minutes either way" skew allowance.
const CLOCK_SKEW_MS = 5 * 60000;

export class IdTokenError extends Error {
  constructor(reason, message) { super(message || reason); this.reason = reason; }
}

export function makeState() { return crypto.randomBytes(16).toString('base64url'); }
export function makeNonce() { return crypto.randomBytes(16).toString('base64url'); }
// S256 PKCE: a 32-byte verifier (256 bits, well inside the 43-128 char spec range once base64url-
// encoded) and the challenge the authorization request carries instead of it.
export function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Discovery is fetched once and kept for the life of the process — Google's own document changes
// essentially never, and a self-hosted instance restarts far more often than that document would.
// `force` is for the tests, where a fresh fake server needs discovery re-read from a clean cache.
let discoveryCache = null;
export async function discover({ force = false } = {}) {
  if (discoveryCache && !force) return discoveryCache;
  const res = await fetch(GOOGLE_DISCOVERY_URL);
  if (!res.ok) throw new Error(`google discovery failed: HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('google discovery document is missing a required endpoint');
  }
  discoveryCache = doc;
  return doc;
}
// Test-only: a fake discovery server torn down between cases must not leave this module serving
// a stale document (or stale JWKS, below) to the next one.
export function resetCaches() { discoveryCache = null; jwksCache = null; }

// Parses `Cache-Control: max-age=N` (ignoring every other directive) for the JWKS refetch
// interval the issue asks for; a response with no such header, or one that doesn't parse, is
// treated as "cache nothing" (max-age 0) — safe, if more chatty, since a real JWKS response from
// Google always carries one.
function maxAgeMs(headers) {
  const m = /max-age=(\d+)/i.exec(headers.get('cache-control') || '');
  return m ? Number(m[1]) * 1000 : 0;
}

let jwksCache = null; // { keys, fetchedAt, goodUntil, uri }
async function fetchJwks(jwksUri) {
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error(`google jwks fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  const now = Date.now();
  jwksCache = { keys: body.keys || [], fetchedAt: now, goodUntil: now + maxAgeMs(res.headers), uri: jwksUri };
  return jwksCache;
}
// The key for `kid`, fetching fresh when the cache has expired or simply never heard of this kid
// — a rotation can introduce a new one between a long-lived cache's refreshes, and that is the
// one case worth one extra round trip rather than failing a real sign-in. A `kid` still unknown
// after that refetch is not retried again: that is a wrong or forged token, not a timing issue.
async function jwkFor(jwksUri, kid) {
  let cache = jwksCache;
  if (!cache || cache.uri !== jwksUri || cache.goodUntil <= Date.now()) cache = await fetchJwks(jwksUri);
  let key = cache.keys.find(k => k.kid === kid);
  if (!key) {
    cache = await fetchJwks(jwksUri);
    key = cache.keys.find(k => k.kid === kid);
  }
  return key || null;
}

const fromB64u = s => Buffer.from(s, 'base64url');

// Verifies a Google ID token end to end: signature (RS256 only, by the JWKS Google itself
// publishes — no algorithm the token claims for itself is ever trusted), issuer, audience, expiry/
// issued-at within CLOCK_SKEW_MS, the nonce this authorization request minted, and that Google
// itself reports the e-mail as verified. Throws IdTokenError with a stable `.reason` on any
// failure — server.js maps that to an audit line and a result code, never the raw message (which
// can echo token-controlled text).
export async function verifyGoogleIdToken(idToken, { jwksUri, clientId, nonce }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new IdTokenError('malformed', 'not a JWT');
  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try { header = JSON.parse(fromB64u(headerB64).toString('utf8')); }
  catch { throw new IdTokenError('malformed', 'bad header'); }
  try { payload = JSON.parse(fromB64u(payloadB64).toString('utf8')); }
  catch { throw new IdTokenError('malformed', 'bad payload'); }
  // Only ever RS256 — the attacker-controlled `alg: none` / HS256-with-the-public-key-as-secret
  // substitution attacks both rely on the verifier trusting whatever the token itself claims.
  if (header.alg !== 'RS256') throw new IdTokenError('bad-alg', `unexpected alg ${header.alg}`);
  const jwk = await jwkFor(jwksUri, header.kid);
  if (!jwk) throw new IdTokenError('unknown-kid', 'no matching JWKS key');
  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { throw new IdTokenError('bad-key', 'could not import JWKS key'); }
  const signingInput = `${headerB64}.${payloadB64}`;
  const verified = crypto.verify('RSA-SHA256', Buffer.from(signingInput), publicKey, fromB64u(sigB64));
  if (!verified) throw new IdTokenError('bad-signature', 'signature does not verify');
  if (!ISSUERS.has(payload.iss)) throw new IdTokenError('bad-iss', `unexpected iss ${payload.iss}`);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(clientId)) throw new IdTokenError('bad-aud', 'aud does not name this client');
  if (auds.length > 1 && payload.azp !== clientId) throw new IdTokenError('bad-aud', 'azp does not name this client');
  const now = Date.now();
  if (typeof payload.exp !== 'number' || now > payload.exp * 1000 + CLOCK_SKEW_MS) throw new IdTokenError('expired', 'token expired');
  if (typeof payload.iat !== 'number' || payload.iat * 1000 > now + CLOCK_SKEW_MS) throw new IdTokenError('bad-iat', 'issued in the future');
  if (!nonce || payload.nonce !== nonce) throw new IdTokenError('bad-nonce', 'nonce mismatch');
  if (payload.email_verified !== true) throw new IdTokenError('email-unverified', 'google reports this e-mail as unverified');
  if (!payload.sub || typeof payload.sub !== 'string') throw new IdTokenError('malformed', 'missing sub');
  if (!payload.email || typeof payload.email !== 'string') throw new IdTokenError('malformed', 'missing email');
  return { sub: payload.sub, email: payload.email, name: typeof payload.name === 'string' ? payload.name : '' };
}

// The token endpoint, exchanging the authorization code (plus the PKCE verifier) for an ID token.
// `client_secret` travels in the body, same as any confidential client — this is a server-to-
// server POST, never reachable from a browser.
export async function exchangeCode({ tokenEndpoint, code, redirectUri, clientId, clientSecret, codeVerifier }) {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: clientId, client_secret: clientSecret, code_verifier: codeVerifier
    })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.id_token) throw new Error(`google token exchange failed: HTTP ${res.status}`);
  return body;
}
