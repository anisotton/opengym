/* GET /api/billing/plans and the catalog-aware half of POST /api/billing/checkout (ISO-1623),
 * against a real spawned server.js — billing.test.js already covers the webhook/status surface
 * this file doesn't repeat. The mock Stripe server below answers the three calls a real boot +
 * checkout makes: GET /v1/prices/:id (seedCatalogFromEnv, at boot) and POST /v1/customers +
 * POST /v1/checkout/sessions (createCheckoutSession). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { tempData, spawnApi, testPool } from './helpers.mjs';
import { LEGAL_VERSION } from '../legal.js';

const SECRET = crypto.randomBytes(32).toString('hex');
const WEBHOOK_SECRET = 'whsec_test_' + crypto.randomBytes(8).toString('hex');

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json' });

function mockStripeApi() {
  const calls = [];
  const prices = {
    price_monthly_test: { id: 'price_monthly_test', object: 'price', unit_amount: 8900, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1' },
    price_quarterly_test: { id: 'price_quarterly_test', object: 'price', unit_amount: 23700, currency: 'brl', recurring: { interval: 'month', interval_count: 3 }, livemode: false, product: 'prod_1' },
    price_yearly_test: { id: 'price_yearly_test', object: 'price', unit_amount: 76800, currency: 'brl', recurring: { interval: 'year', interval_count: 1 }, livemode: false, product: 'prod_1' },
    price_intro_test: { id: 'price_intro_test', object: 'price', unit_amount: 199, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1' }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      if (req.method === 'GET' && req.url.startsWith('/v1/prices/')) {
        const id = decodeURIComponent(req.url.split('/').pop());
        const p = prices[id];
        res.writeHead(p ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(p || { error: { message: 'No such price' } }));
      }
      if (req.method === 'POST' && req.url === '/v1/customers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'cus_test_1', object: 'customer' }));
      }
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/pay/cs_test_1' }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `not mocked: ${req.method} ${req.url}` } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls })));
}

async function startServer(t, { users } = {}) {
  const { server, port } = await mockStripeApi();
  t.after(() => server.close());
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  return spawnApi(t, {
    dataDir,
    env: {
      STRIPE_API_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(port),
      STRIPE_PRICE_MONTHLY: 'price_monthly_test', STRIPE_PRICE_QUARTERLY: 'price_quarterly_test',
      STRIPE_PRICE_YEARLY: 'price_yearly_test', STRIPE_PRICE_INTRO: 'price_intro_test'
    }
  });
}

const verifiedUser = id => ({ id, name: 'One', created: new Date().toISOString() });

// Opened and closed within the same statement — same shape as server-teacher.test.js's own `sql`
// and helpers.mjs's seedUserState — so this never holds a connection open against the race
// spawnApi's own teardown runs (pg_terminate_backend against every backend on this database,
// right before DROP DATABASE): a pool this test file kept open across the fetch below has hit
// exactly that race ("terminating connection due to administrator command") when the two land in
// the same tick.
async function sql(databaseUrl, text, params) {
  const pool = testPool(databaseUrl);
  try { return await pool.query(text, params); }
  finally { await pool.end(); }
}

// upsertUser (store.js) — the db.json boot-import path every test's fixture users go through —
// does not carry email_verified_at/terms_accepted_version (only createUser, the live signup path,
// does); readied here with a direct UPDATE instead, rather than switching the whole fixture to a
// live signup flow just for this.
const verifyAndAcceptTerms = (databaseUrl, id) =>
  sql(databaseUrl, 'UPDATE users SET email_verified_at = now(), terms_accepted_version = $2 WHERE id = $1', [id, LEGAL_VERSION]);

test('GET /api/billing/plans: the catalog seeded at boot, in cents, in display order', async t => {
  const h = await startServer(t, { users: [verifiedUser('u_cat_1')] });
  const r = await fetch(`${h.api}/api/billing/plans`, { headers: headers('u_cat_1') });
  assert.equal(r.status, 200);
  const { plans } = await r.json();
  assert.deepEqual(plans.map(p => p.id), ['monthly', 'quarterly', 'yearly']);
  assert.deepEqual(plans.map(p => p.amountCents), [8900, 23700, 76800]);
  assert.equal(plans[0].introAmountCents, 199);
});

test('GET /api/billing/plans: 401 without a session', async t => {
  const h = await startServer(t, { users: [] });
  const r = await fetch(`${h.api}/api/billing/plans`);
  assert.equal(r.status, 401);
});

test('POST /api/billing/checkout: a plan the admin has taken off sale is refused, even though its Price is still current', async t => {
  const h = await startServer(t, { users: [verifiedUser('u_cat_2')] });
  await verifyAndAcceptTerms(h.databaseUrl, 'u_cat_2');
  await sql(h.databaseUrl, "UPDATE billing_plans SET available = false WHERE id = 'monthly'");
  const r = await fetch(`${h.api}/api/billing/checkout`, { method: 'POST', headers: headers('u_cat_2'), body: JSON.stringify({ plan: 'monthly' }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'invalid-plan');
});

test('POST /api/billing/checkout: 409 already-subscribed when the last subscription is still active', async t => {
  const h = await startServer(t, { users: [verifiedUser('u_cat_3')] });
  await verifyAndAcceptTerms(h.databaseUrl, 'u_cat_3');
  await sql(h.databaseUrl,
    `INSERT INTO subscriptions (id, user_id, data) VALUES ('sub_cat_3', 'u_cat_3', $1)`,
    [{ status: 'active', plan: 'monthly' }]
  );
  const r = await fetch(`${h.api}/api/billing/checkout`, { method: 'POST', headers: headers('u_cat_3'), body: JSON.stringify({ plan: 'quarterly' }) });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'already-subscribed');
});

test('POST /api/billing/checkout: a plan still sellable succeeds and does not trip the duplicate guard', async t => {
  const h = await startServer(t, { users: [verifiedUser('u_cat_4')] });
  await verifyAndAcceptTerms(h.databaseUrl, 'u_cat_4');
  const r = await fetch(`${h.api}/api/billing/checkout`, { method: 'POST', headers: headers('u_cat_4'), body: JSON.stringify({ plan: 'monthly' }) });
  assert.equal(r.status, 200);
  assert.match((await r.json()).url, /^https:\/\/checkout\.stripe\.com\//);
});
