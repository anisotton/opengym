/* Admin subscription ficha and actions (ISO-1619/ISO-1624, T2a): /api/admin/user/billing,
   /api/admin/billing/subscription/*. Real server.js in a child, real PostgreSQL, a local mock
   Stripe server (same seam as server-billing-admin.test.js's own) extended with
   subscriptions/subscription_schedules/invoices.create_preview — the endpoints these routes
   actually call. proveOwner's proof is the admin's own password, same construction as
   server-billing-admin.test.js. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { hashPassword } from '../password.js';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const WEBHOOK_SECRET = 'whsec_test_' + crypto.randomBytes(8).toString('hex');

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookieFor = uid => `gymsid=${mintSession(uid)}`;

const GOOD = 'correct horse battery staple';
let pwHash;
before(async () => { pwHash ??= await hashPassword(GOOD); });
const user = (id, name, extra = {}) => ({ id, name, created: new Date().toISOString(), ...extra });
const withPassword = (id, name, extra = {}) => user(id, name, { pw: { h: pwHash, set: new Date().toISOString() }, ...extra });

// Same bracket-nested form decoder as server-billing-admin.test.js — good enough for this file's
// own assertions (and, since Stripe's integer-keyed `phases[0]`/`phases[1]` decode into plain JS
// objects whose integer-like keys iterate in ascending numeric order regardless of insertion
// order, `Object.values(...)` on them already comes back in the right order).
function parseStripeForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const parts = k.replace(/\]/g, '').split('[');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ||= {});
    node[parts[parts.length - 1]] = v;
  }
  return out;
}

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

// Extends the T1b mock (prices/customers/checkout) with the live-subscription surface T2a's
// actions and ficha actually call. `fail` lets a test arm a response for every request matching
// `match(method, pathname)` — either a canned Stripe error body (a "rejected" outcome) or a
// dropped connection (an "unknown" outcome) — until the test clears it. A dropped connection stays
// armed on purpose: the Stripe SDK's own default `maxNetworkRetries` (2) retries a connection
// error automatically, so a one-shot failure is silently masked by a successful retry — this has
// to keep failing for every attempt billing.js's own call makes before it gives up.
function mockStripeApi({ prices = {}, subscriptions = {}, schedules = {} } = {}) {
  const calls = [];
  let fail = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      calls.push({ method: req.method, url: req.url, body, idempotencyKey: req.headers['idempotency-key'] || null });
      if (fail && fail.match(req.method, u.pathname)) {
        // Destroying the socket instead of responding reproduces a dropped connection (ECONNRESET)
        // right away, rather than waiting out the Stripe SDK's own multi-second request timeout —
        // the SDK's HttpClient wraps exactly this into a StripeConnectionError. A canned error
        // body (not a hang) is a one-shot: a 4xx like this is never retried by the SDK anyway.
        if (fail.hang) return req.socket.destroy();
        const inj = fail; fail = null;
        res.writeHead(inj.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: inj.error }));
      }
      const notFound = () => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found' } })); };

      if (req.method === 'POST' && u.pathname === '/v1/customers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'cus_test_1', object: 'customer' }));
      }
      if (req.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/pay/cs_test_1' }));
      }
      if (req.method === 'GET' && u.pathname.startsWith('/v1/prices/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const p = prices[id];
        res.writeHead(p ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(p || { error: { message: 'No such price' } }));
      }

      if (req.method === 'GET' && u.pathname.match(/^\/v1\/subscriptions\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const s = subscriptions[id];
        if (!s) return notFound();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(s));
      }
      if (req.method === 'POST' && u.pathname.match(/^\/v1\/subscriptions\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const s = subscriptions[id];
        if (!s) return notFound();
        const f = parseStripeForm(body);
        if ('cancel_at_period_end' in f) s.cancel_at_period_end = f.cancel_at_period_end === 'true';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(s));
      }
      if (req.method === 'DELETE' && u.pathname.match(/^\/v1\/subscriptions\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const s = subscriptions[id];
        if (!s) return notFound();
        s.status = 'canceled';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(s));
      }

      if (req.method === 'POST' && u.pathname === '/v1/subscription_schedules') {
        const f = parseStripeForm(body);
        const sub = subscriptions[f.from_subscription];
        if (!sub) return notFound();
        const id = 'sched_' + crypto.randomBytes(6).toString('hex');
        const schedule = {
          id, object: 'subscription_schedule', status: 'active', end_behavior: 'release',
          phases: [{ start_date: now(), end_date: now() + DAY, items: [{ price: sub.items.data[0].price.id }] }]
        };
        schedules[id] = schedule;
        sub.schedule = id;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(schedule));
      }
      if (req.method === 'GET' && u.pathname.match(/^\/v1\/subscription_schedules\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const s = schedules[id];
        if (!s) return notFound();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(s));
      }
      if (req.method === 'POST' && u.pathname.match(/^\/v1\/subscription_schedules\/[^/]+\/cancel$/)) {
        const id = decodeURIComponent(u.pathname.split('/')[3]);
        const schedule = schedules[id];
        if (!schedule) return notFound();
        schedule.status = 'canceled';
        const subId = Object.keys(subscriptions).find(k => subscriptions[k].schedule === id);
        if (subId) subscriptions[subId].status = 'canceled';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(schedule));
      }
      if (req.method === 'POST' && u.pathname.match(/^\/v1\/subscription_schedules\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const schedule = schedules[id];
        if (!schedule) return notFound();
        const f = parseStripeForm(body);
        if (f.end_behavior) schedule.end_behavior = f.end_behavior;
        if (f.phases) {
          schedule.phases = Object.values(f.phases).map(p => ({
            start_date: p.start_date !== undefined ? Number(p.start_date) : undefined,
            end_date: p.end_date !== undefined ? Number(p.end_date) : undefined,
            items: Object.values(p.items).map(it => ({ price: it.price }))
          }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(schedule));
      }

      if (req.method === 'POST' && u.pathname === '/v1/invoices/create_preview') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'invoice', amount_due: 8900, currency: 'brl', next_payment_attempt: null }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `not mocked: ${req.method} ${req.url}` } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, calls, prices, subscriptions, schedules,
    failNext: inj => { fail = inj; },
    port: () => server.address().port
  })));
}

async function sql(databaseUrl, text, params) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try { return await pool.query(text, params); }
  finally { await pool.end(); }
}

const CATALOG_SEED_PRICES = {
  price_monthly_test: { id: 'price_monthly_test', object: 'price', unit_amount: 8900, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1', active: true },
  price_quarterly_test: { id: 'price_quarterly_test', object: 'price', unit_amount: 23700, currency: 'brl', recurring: { interval: 'month', interval_count: 3 }, livemode: false, product: 'prod_1', active: true },
  price_yearly_test: { id: 'price_yearly_test', object: 'price', unit_amount: 76800, currency: 'brl', recurring: { interval: 'year', interval_count: 1 }, livemode: false, product: 'prod_1', active: true },
  price_intro_test: { id: 'price_intro_test', object: 'price', unit_amount: 199, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1', active: true }
};

async function startServer(t, { users, apiKey = 'sk_test_unused', env = {} } = {}) {
  const mock = await mockStripeApi({ prices: { ...CATALOG_SEED_PRICES } });
  t.after(() => mock.server.close());
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, {
    dataDir,
    env: {
      STRIPE_API_KEY: apiKey, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(mock.port()),
      ADMIN_UIDS: 'u_admin_1', PASSWORD_LOGIN: '1',
      STRIPE_PRICE_MONTHLY: 'price_monthly_test', STRIPE_PRICE_QUARTERLY: 'price_quarterly_test',
      STRIPE_PRICE_YEARLY: 'price_yearly_test', STRIPE_PRICE_INTRO: 'price_intro_test',
      ...env
    }
  });
  h.mock = mock;
  h.req = async (method, p, { body, cookie, headers = {} } = {}) => {
    const r = await fetch(`${h.api}${p}`, {
      method, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };
  h.row1 = (text, params) => sql(h.databaseUrl, text, params).then(r => r.rows[0] || null);
  h.rows = (text, params) => sql(h.databaseUrl, text, params).then(r => r.rows);
  // One row in `subscriptions` (the DB's own mirror) and one matching live object in the mock —
  // every action/ficha route retrieves the live object before doing anything, so the two have to
  // agree on id/customer/price the way a real webhook-written row and a real Stripe object would.
  h.seedSubscription = async ({ id, userId, planId = 'monthly', priceId = 'price_monthly_test', status = 'active', cancelAtPeriodEnd = false }) => {
    const price = CATALOG_SEED_PRICES[priceId];
    await sql(h.databaseUrl,
      `INSERT INTO subscriptions (id, user_id, data, updated_at) VALUES ($1,$2,$3,now())`,
      [id, userId, JSON.stringify({
        status, plan: planId, priceId, priceAmount: price.unit_amount, customerId: 'cus_test_1',
        firstPeriod: false, currentPeriodEnd: new Date((now() + 30 * DAY) * 1000).toISOString(), cancelAtPeriodEnd
      })]
    );
    h.mock.subscriptions[id] = {
      id, object: 'subscription', status, customer: 'cus_test_1', cancel_at_period_end: cancelAtPeriodEnd,
      current_period_end: now() + 30 * DAY, schedule: null,
      items: { object: 'list', data: [{ id: 'si_' + id, price: { id: priceId, unit_amount: price.unit_amount } }] },
      metadata: { userId, plan: planId }
    };
    return (await h.row1('SELECT updated_at FROM subscriptions WHERE id = $1', [id])).updated_at.toISOString();
  };
  return h;
}

const admin = () => withPassword('u_admin_1', 'Admin', { admin: true });
const plain = () => withPassword('u_plain_1', 'Plain', { emailVerifiedAt: Date.now() });
const adminCookie = cookieFor('u_admin_1');
const plainCookie = cookieFor('u_plain_1');
const proof = { current: GOOD };
const idemp = () => 'idemp-' + crypto.randomBytes(8).toString('hex');
const REASON = 'a perfectly good admin reason';

/* ---------- ficha ---------- */
test('admin billing ficha: lists the subscription, its price, origin and the available actions', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const r = await h.req('GET', '/api/admin/user/billing?id=u_plain_1', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.subscriptions.length, 1);
  assert.equal(r.body.subscriptions[0].priceAmountCents, 8900);
  assert.equal(r.body.subscriptions[0].origin, 'self');
  assert.equal(r.body.subscriptions[0].pauseCollection, null);
  assert.equal(r.body.actions.changePlan.enabled, true);
  assert.equal(r.body.actions.cancelAtPeriodEnd.enabled, true);
  assert.equal(r.body.actions.resumeCancellation.enabled, false);
});

test('admin billing ficha: origin reflects metadata.source=admin_link, pauseCollection is exposed raw', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  h.mock.subscriptions.sub_1.metadata.source = 'admin_link';
  h.mock.subscriptions.sub_1.pause_collection = { behavior: 'void', resumes_at: null };
  // Sync is what actually persists `origin` from Stripe's own metadata into the DB row — the
  // ficha's other fields are read straight off the DB, only `schedule`/`pauseCollection` come
  // from the live retrieve it does itself.
  await h.req('POST', '/api/admin/billing/subscription/sync', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1' }
  });
  const r = await h.req('GET', '/api/admin/user/billing?id=u_plain_1', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.subscriptions[0].origin, 'admin_link');
  assert.deepEqual(r.body.subscriptions[0].pauseCollection, { behavior: 'void', resumes_at: null });
  assert.equal(r.body.subscriptions[0].status, 'active', 'no synthetic "paused" status — pause_collection is the only signal');
});

/* ---------- requireAdmin ---------- */
test('admin subscription actions: every route is 403 for a signed-in non-admin', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const calls = [
    ['GET', '/api/admin/user/billing?id=u_plain_1'],
    ['POST', '/api/admin/billing/subscription/preview'],
    ['POST', '/api/admin/billing/subscription/change-plan'],
    ['POST', '/api/admin/billing/subscription/cancel-period-end'],
    ['POST', '/api/admin/billing/subscription/resume'],
    ['POST', '/api/admin/billing/subscription/cancel-immediately'],
    ['POST', '/api/admin/billing/subscription/generate-link'],
    ['POST', '/api/admin/billing/subscription/sync']
  ];
  for (const [method, p] of calls) {
    const r = await h.req(method, p, { cookie: plainCookie, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
});

/* ---------- live gate ---------- */
test('admin subscription actions: live gate — 423 on every Stripe-write action, sync still passes it', async t => {
  const h = await startServer(t, { users: [admin(), plain()], apiKey: 'sk_live_unused' });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const writes = [
    ['/api/admin/billing/subscription/change-plan', { userId: 'u_plain_1', subscriptionId: 'sub_1', newPlanId: 'yearly', reason: REASON, ...proof }],
    ['/api/admin/billing/subscription/cancel-period-end', { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof }],
    ['/api/admin/billing/subscription/resume', { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON }],
    ['/api/admin/billing/subscription/cancel-immediately', { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof }],
    ['/api/admin/billing/subscription/generate-link', { userId: 'u_plain_1', planId: 'monthly', reason: REASON }]
  ];
  for (const [p, body] of writes) {
    const r = await h.req('POST', p, { cookie: adminCookie, body, headers: { 'Idempotency-Key': idemp() } });
    assert.equal(r.status, 423, p);
    assert.equal(r.body.code, 'live-writes-disabled', p);
  }
  const sync = await h.req('POST', '/api/admin/billing/subscription/sync', {
    cookie: adminCookie, body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON }, headers: { 'Idempotency-Key': idemp() }
  });
  assert.equal(sync.status, 200, 'sync is read-only and does not pass through the live gate');
});

/* ---------- each action against the mock ---------- */
test('change-plan: no schedule yet — converts into a two-phase schedule, phase 2 at the new plan', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const r = await h.req('POST', '/api/admin/billing/subscription/change-plan', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', newPlanId: 'yearly', reason: REASON, ...proof }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.end_behavior, 'release');
  assert.equal(r.body.phases[1].items[0].price, 'price_yearly_test');
  const action = await h.row1('SELECT * FROM billing_admin_actions WHERE action = $1', ['subscription.change-plan']);
  assert.equal(action.status, 'succeeded');
  assert.equal(action.target_user_id, 'u_plain_1');
});

test('cancel-at-period-end: no schedule — cancel_at_period_end:true, nothing invented in the DB', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const r = await h.req('POST', '/api/admin/billing/subscription/cancel-period-end', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cancel_at_period_end, true);
  const row = await h.row1('SELECT data FROM subscriptions WHERE id = $1', ['sub_1']);
  assert.equal(row.data.status, 'active', 'the webhook, not this route, is what would update the DB row');
});

test('resume: no schedule — cancel_at_period_end back to false', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1', cancelAtPeriodEnd: true });
  h.mock.subscriptions.sub_1.cancel_at_period_end = true;
  const r = await h.req('POST', '/api/admin/billing/subscription/resume', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cancel_at_period_end, false);
});

test('cancel-immediately: no schedule — subscriptions.cancel, status canceled', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const r = await h.req('POST', '/api/admin/billing/subscription/cancel-immediately', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'canceled');
  const call = h.mock.calls.find(c => c.method === 'DELETE' && c.url.startsWith('/v1/subscriptions/sub_1'));
  assert.ok(call, 'subscriptions.cancel was called, not subscriptionSchedules.cancel');
});

test('cancel-immediately: with a schedule — subscriptionSchedules.cancel, not subscriptions.cancel', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  h.mock.schedules.sched_1 = { id: 'sched_1', object: 'subscription_schedule', status: 'active', end_behavior: 'release', phases: [{ start_date: now(), end_date: now() + DAY, items: [{ price: 'price_intro_test' }] }, { start_date: now() + DAY, items: [{ price: 'price_monthly_test' }] }] };
  h.mock.subscriptions.sub_1.schedule = 'sched_1';
  const r = await h.req('POST', '/api/admin/billing/subscription/cancel-immediately', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof }
  });
  assert.equal(r.status, 200);
  const scheduleCancel = h.mock.calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules/sched_1/cancel');
  assert.ok(scheduleCancel, 'subscriptionSchedules.cancel was called');
  const subCancel = h.mock.calls.find(c => c.method === 'DELETE' && c.url.startsWith('/v1/subscriptions/sub_1'));
  assert.equal(subCancel, undefined, 'subscriptions.cancel was not called when a schedule exists');
});

test('generate-link: reuses createCheckoutSession with metadata.source=admin_link, forwards the Idempotency-Key to Stripe', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  const key = idemp();
  const r = await h.req('POST', '/api/admin/billing/subscription/generate-link', {
    cookie: adminCookie, headers: { 'Idempotency-Key': key },
    body: { userId: 'u_plain_1', planId: 'monthly', reason: REASON }
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.url);
  const call = h.mock.calls.find(c => c.url === '/v1/checkout/sessions');
  const f = parseStripeForm(call.body);
  assert.equal(f.subscription_data.metadata.source, 'admin_link');
  assert.equal(call.idempotencyKey, key, 'the same Idempotency-Key reaches the checkout.sessions.create call, not just billing_admin_actions');
});

test('sync: no reason needed from the caller (ISO-1626) — a fixed reason is recorded, the webhook\'s own mapping is applied', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  h.mock.subscriptions.sub_1.status = 'past_due'; // drifted on Stripe's side only
  const r = await h.req('POST', '/api/admin/billing/subscription/sync', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1' } // no `reason` in the body at all
  });
  assert.equal(r.status, 200);
  const row = await h.row1('SELECT data FROM subscriptions WHERE id = $1', ['sub_1']);
  assert.equal(row.data.status, 'past_due');
  const action = await h.row1('SELECT reason FROM billing_admin_actions WHERE action = $1', ['subscription.sync']);
  assert.equal(action.reason, 'admin manual sync');
});

/* ---------- idempotency, concurrency, staleness ---------- */
test('same Idempotency-Key replayed — one Stripe call, the stored result handed back both times', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const key = idemp();
  const body = { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof };
  const first = await h.req('POST', '/api/admin/billing/subscription/cancel-period-end', { cookie: adminCookie, headers: { 'Idempotency-Key': key }, body });
  const second = await h.req('POST', '/api/admin/billing/subscription/cancel-period-end', { cookie: adminCookie, headers: { 'Idempotency-Key': key }, body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  const subUpdates = h.mock.calls.filter(c => c.method === 'POST' && c.url === '/v1/subscriptions/sub_1');
  assert.equal(subUpdates.length, 1, 'Stripe was called exactly once');
});

test('two actions on the same subscription at once — one wins, the other gets a stale 409', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  const expectedUpdatedAt = await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const body = { userId: 'u_plain_1', subscriptionId: 'sub_1', expectedUpdatedAt, reason: REASON, ...proof };
  const [ra, rb] = await Promise.all([
    h.req('POST', '/api/admin/billing/subscription/cancel-period-end', { cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body }),
    h.req('POST', '/api/admin/billing/subscription/cancel-immediately', { cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body })
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = ra.status === 409 ? ra : rb;
  assert.equal(loser.body.code, 'stale');
});

test('expectedUpdatedAt from a stale read — 409 stale', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  const r = await h.req('POST', '/api/admin/billing/subscription/cancel-period-end', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', expectedUpdatedAt: '2000-01-01T00:00:00.000Z', reason: REASON, ...proof }
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'stale');
});

/* ---------- Stripe errors (plan §5.2) ---------- */
test('a rejected Stripe request — failed, 422, nothing changes in the DB', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  h.mock.failNext({ match: (m, p) => m === 'POST' && p === '/v1/subscriptions/sub_1', status: 400, error: { type: 'invalid_request_error', message: 'mock: bad request' } });
  const r = await h.req('POST', '/api/admin/billing/subscription/cancel-period-end', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof }
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'stripe-rejected');
  const action = await h.row1('SELECT * FROM billing_admin_actions WHERE action = $1', ['subscription.cancel-at-period-end']);
  assert.equal(action.status, 'failed');
});

test('a connection failure mid-call — unknown, then an immediate reconcile records the real state', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  // Only the one subscriptions.update call this action makes is torn down; the reconcile's own
  // follow-up subscriptions.retrieve (a GET, never matched by this injection) goes through
  // normally and finds the subscription exactly as it was before the failed update.
  h.mock.failNext({ match: (m, p) => m === 'POST' && p === '/v1/subscriptions/sub_1', hang: true });
  const r = await h.req('POST', '/api/admin/billing/subscription/cancel-period-end', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON, ...proof }
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.code, 'action-unknown');
  const action = await h.row1('SELECT * FROM billing_admin_actions WHERE action = $1', ['subscription.cancel-at-period-end']);
  assert.equal(action.status, 'unknown');
  const row = await h.row1('SELECT data FROM subscriptions WHERE id = $1', ['sub_1']);
  assert.equal(row.data.status, 'active', 'the immediate reconcile wrote back the real (unchanged) Stripe state');
});

/* ---------- account deletion (ISO-1447/LGPD) ---------- */
test('deleting the account preserves billing_admin_actions with target_user_id set to NULL', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  await h.seedSubscription({ id: 'sub_1', userId: 'u_plain_1' });
  await h.req('POST', '/api/admin/billing/subscription/sync', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { userId: 'u_plain_1', subscriptionId: 'sub_1', reason: REASON }
  });
  const before = await h.row1('SELECT target_user_id FROM billing_admin_actions WHERE action = $1', ['subscription.sync']);
  assert.equal(before.target_user_id, 'u_plain_1');
  const del = await h.req('POST', '/api/admin/user/delete', { cookie: adminCookie, body: { id: 'u_plain_1' } });
  assert.equal(del.status, 200);
  const after = await h.row1('SELECT target_user_id, status FROM billing_admin_actions WHERE action = $1', ['subscription.sync']);
  assert.equal(after.target_user_id, null);
  assert.equal(after.status, 'succeeded');
});
