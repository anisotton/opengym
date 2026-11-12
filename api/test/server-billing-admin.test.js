/* Admin catalog routes (ISO-1619/ISO-1630, T1b): /api/admin/billing/catalog/* — requireAdmin, the
   live gate, proveOwner + reason on every write that touches Stripe, the Idempotency-Key claim,
   and reconcile. Real server.js in a child, real PostgreSQL, a local mock Stripe server (the same
   seam server-billing-catalog.test.js uses for T1a's read path) standing in for api.stripe.com.
   proveOwner's proof here is the admin's own password (hashPassword/password.js), same construction
   as server-account-delete.test.js's withPassword. */
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

// Decodes the form-urlencoded, bracket-nested body the Stripe SDK sends for every write
// (`metadata[bf_plan]=x&recurring[interval]=month`) — good enough for this file's own assertions,
// not a general qs implementation.
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

// Extends server-billing-catalog.test.js's own mock with prices.create/update/list, the Stripe
// calls the admin catalog routes make. `seedPrices` pre-populates the store (object keyed by id)
// so a test can hand it a fixture price (e.g. one carrying `metadata.bf_plan` for reconcile) that
// was never created through this mock server itself.
// `pageSize` (ISO-1625, T1b review — reconcileCatalog's own pagination) lets a test force more
// than one `prices.list` round trip regardless of how few fixture Prices it seeds, by capping how
// many this mock ever hands back in one page — the real limit billing.js asks for (100) stays
// irrelevant to the mock either way.
function mockStripeApi(seedPrices = {}, { pageSize = Infinity } = {}) {
  const calls = [];
  const prices = { ...seedPrices };
  // `delay.ms` (ISO-1625, T1b review — stale-after-stripe compensation): a test can widen the gap
  // between a price-update call landing and its response, to reliably land a concurrent, faster
  // (no Stripe call of its own) request's own DB write inside that gap — without this, that race is
  // too fast and too timing-dependent on a local mock to land in the one specific window the
  // compensation test needs (after Stripe already wrote, before this transaction's own DB CAS).
  const delay = { ms: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body, idempotencyKey: req.headers['idempotency-key'] || null });
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/v1/prices') {
        const product = u.searchParams.get('product');
        const startingAfter = u.searchParams.get('starting_after');
        let data = Object.values(prices).filter(p => !product || p.product === product).sort((a, b) => a.id.localeCompare(b.id));
        if (startingAfter) {
          const idx = data.findIndex(p => p.id === startingAfter);
          data = idx === -1 ? data : data.slice(idx + 1);
        }
        const hasMore = data.length > pageSize;
        data = data.slice(0, pageSize);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data, has_more: hasMore }));
      }
      if (req.method === 'GET' && u.pathname.startsWith('/v1/prices/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const p = prices[id];
        res.writeHead(p ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(p || { error: { message: 'No such price' } }));
      }
      if (req.method === 'POST' && u.pathname === '/v1/prices') {
        const f = parseStripeForm(body);
        const id = 'price_' + crypto.randomBytes(8).toString('hex');
        const p = {
          id, object: 'price', unit_amount: Number(f.unit_amount), currency: f.currency,
          recurring: f.recurring ? { interval: f.recurring.interval, interval_count: Number(f.recurring.interval_count) } : null,
          livemode: false, product: f.product, active: f.active !== 'false', metadata: f.metadata || {}
        };
        prices[id] = p;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(p));
      }
      if (req.method === 'POST' && u.pathname.startsWith('/v1/prices/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const f = parseStripeForm(body);
        const existing = prices[id];
        if (!existing) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'No such price' } })); }
        if ('active' in f) existing.active = f.active !== 'false';
        const respond = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(existing)); };
        return delay.ms > 0 ? setTimeout(respond, delay.ms) : respond();
      }
      if (req.method === 'POST' && u.pathname === '/v1/customers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'cus_test_1', object: 'customer' }));
      }
      if (req.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/pay/cs_test_1' }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `not mocked: ${req.method} ${req.url}` } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, prices, delay })));
}

async function sql(databaseUrl, text, params) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try { return await pool.query(text, params); }
  finally { await pool.end(); }
}

// Polls `calls` (the mock's own request log — appended the instant a request's body is fully
// received, before `mockDelay` holds its response) for a match, instead of a fixed sleep guessing
// how long proveOwner's own scrypt verification plus however many DB round trips will take. A
// fixed-sleep race against a concurrent request fired at some point part way through this delayed
// one has flaked under full-suite load (CPU contention pushes scrypt well past a sleep tuned for
// an idle machine); waiting for the actual Stripe call to land is exact regardless of load.
async function waitForCall(calls, match, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calls.some(match)) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for the expected Stripe call to land');
}

// `seeded: true` (the default) boots with STRIPE_PRICE_MONTHLY/QUARTERLY/YEARLY/INTRO set against
// the mock, so the catalog seeds at boot — needed by every test that publishes, prices a new
// version, or reconciles against the existing product. `seeded: false` + `apiKey: 'sk_live_...'`
// is the live-gate shape: the mock's fixture Prices are `livemode:false`, which a live key makes
// seedCatalogFromEnv's own livemode check refuse — deliberately, so those tests exercise the gate
// on an unseeded catalog without ever reaching real Stripe.
async function startServer(t, { users, seeded = true, apiKey = 'sk_test_unused', env = {}, pageSize = Infinity } = {}) {
  const seedPrices = seeded ? {
    price_monthly_test: { id: 'price_monthly_test', object: 'price', unit_amount: 8900, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1', active: true },
    price_quarterly_test: { id: 'price_quarterly_test', object: 'price', unit_amount: 23700, currency: 'brl', recurring: { interval: 'month', interval_count: 3 }, livemode: false, product: 'prod_1', active: true },
    price_yearly_test: { id: 'price_yearly_test', object: 'price', unit_amount: 76800, currency: 'brl', recurring: { interval: 'year', interval_count: 1 }, livemode: false, product: 'prod_1', active: true },
    price_intro_test: { id: 'price_intro_test', object: 'price', unit_amount: 199, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1', active: true }
  } : {};
  const { server, port, calls, prices, delay } = await mockStripeApi(seedPrices, { pageSize });
  t.after(() => server.close());
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, {
    dataDir,
    env: {
      STRIPE_API_KEY: apiKey, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(port),
      ADMIN_UIDS: 'u_admin_1', PASSWORD_LOGIN: '1',
      ...(seeded ? {
        STRIPE_PRICE_MONTHLY: 'price_monthly_test', STRIPE_PRICE_QUARTERLY: 'price_quarterly_test',
        STRIPE_PRICE_YEARLY: 'price_yearly_test', STRIPE_PRICE_INTRO: 'price_intro_test'
      } : {}),
      ...env
    }
  });
  h.calls = calls;
  h.mockDelay = delay;
  h.prices = prices;
  h.req = async (method, p, { body, cookie, headers = {} } = {}) => {
    const r = await fetch(`${h.api}${p}`, {
      method, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };
  h.row1 = (text, params) => sql(h.databaseUrl, text, params).then(r => r.rows[0] || null);
  h.rows = (text, params) => sql(h.databaseUrl, text, params).then(r => r.rows);
  return h;
}

const admin = () => withPassword('u_admin_1', 'Admin', { admin: true });
const plain = () => withPassword('u_plain_1', 'Plain');
const adminCookie = cookieFor('u_admin_1');
const plainCookie = cookieFor('u_plain_1');
const proof = { current: GOOD };
const idemp = () => 'idemp-' + crypto.randomBytes(8).toString('hex');

/* ---------- requireAdmin: every route refuses a signed-in non-admin with 403 ---------- */
test('admin billing catalog: every route is 403 for a signed-in non-admin', async t => {
  const h = await startServer(t, { users: [admin(), plain()] });
  const calls = [
    ['GET', '/api/admin/billing/catalog'],
    ['GET', '/api/admin/billing/catalog/actions'],
    ['POST', '/api/admin/billing/catalog/plan/new'],
    ['POST', '/api/admin/billing/catalog/plan/display'],
    ['POST', '/api/admin/billing/catalog/plan/availability'],
    ['POST', '/api/admin/billing/catalog/plan/price'],
    ['POST', '/api/admin/billing/catalog/plan/publish'],
    ['POST', '/api/admin/billing/catalog/order'],
    ['POST', '/api/admin/billing/catalog/reconcile']
  ];
  for (const [method, p] of calls) {
    const r = await h.req(method, p, { cookie: plainCookie, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
});

/* ---------- live gate ---------- */
test('admin billing catalog: live gate — 423 on every Stripe-touching write, liveWritesDisabled:true, order still passes', async t => {
  const h = await startServer(t, { users: [admin()], seeded: false, apiKey: 'sk_live_unused' });
  const view = await h.req('GET', '/api/admin/billing/catalog', { cookie: adminCookie });
  assert.equal(view.status, 200);
  assert.equal(view.body.liveWritesDisabled, true);

  const writes = [
    ['/api/admin/billing/catalog/plan/new', { id: 'biweekly', display: { 'pt-BR': { name: 'Quinzenal' } }, interval: 'month', intervalCount: 1, unitAmount: 5000, reason: 'test reason long enough', ...proof }],
    ['/api/admin/billing/catalog/plan/availability', { id: 'monthly', version: 1, available: true, reason: 'test reason long enough', ...proof }],
    ['/api/admin/billing/catalog/plan/price', { planId: 'monthly', unitAmount: 9900, reason: 'test reason long enough', ...proof }],
    ['/api/admin/billing/catalog/plan/publish', { planId: 'monthly', priceId: 'price_x', version: 1, reason: 'test reason long enough', ...proof }]
  ];
  for (const [p, body] of writes) {
    const r = await h.req('POST', p, { cookie: adminCookie, body, headers: { 'Idempotency-Key': idemp() } });
    assert.equal(r.status, 423, p);
    assert.equal(r.body.code, 'live-writes-disabled', p);
  }

  const reorder = await h.req('POST', '/api/admin/billing/catalog/order', { cookie: adminCookie, body: { order: [] } });
  assert.equal(reorder.status, 200, 'reorder does not pass through the live gate');
});

test('admin billing catalog: BILLING_ADMIN_LIVE=1 lifts the gate (liveWritesDisabled:false)', async t => {
  const h = await startServer(t, { users: [admin()], seeded: false, apiKey: 'sk_live_unused', env: { BILLING_ADMIN_LIVE: '1' } });
  const view = await h.req('GET', '/api/admin/billing/catalog', { cookie: adminCookie });
  assert.equal(view.body.liveWritesDisabled, false);
});

test('admin billing catalog: a sandbox key never trips the gate', async t => {
  const h = await startServer(t, { users: [admin()] });
  const view = await h.req('GET', '/api/admin/billing/catalog', { cookie: adminCookie });
  assert.equal(view.body.liveWritesDisabled, false);
});

/* ---------- proveOwner + reason on the financial writes ---------- */
test('admin billing catalog: criar oferta without proveOwner is refused', async t => {
  const h = await startServer(t, { users: [admin()] });
  const r = await h.req('POST', '/api/admin/billing/catalog/plan/new', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { id: 'biweekly', display: { 'pt-BR': { name: 'Quinzenal' } }, interval: 'month', intervalCount: 1, unitAmount: 5000, reason: 'a perfectly good reason' }
  });
  assert.equal(r.status, 403);
});

test('admin billing catalog: criar oferta with reason < 10 chars is refused', async t => {
  const h = await startServer(t, { users: [admin()] });
  const r = await h.req('POST', '/api/admin/billing/catalog/plan/new', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { id: 'biweekly', display: { 'pt-BR': { name: 'Quinzenal' } }, interval: 'month', intervalCount: 1, unitAmount: 5000, reason: 'short', ...proof }
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'reason');
});

test('admin billing catalog: ativar/desativar without proveOwner or with a short reason is refused, both directions', async t => {
  const h = await startServer(t, { users: [admin()] });
  const noProof = await h.req('POST', '/api/admin/billing/catalog/plan/availability', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body: { id: 'monthly', version: 1, available: false, reason: 'a perfectly good reason' }
  });
  assert.equal(noProof.status, 403);
  const shortReason = await h.req('POST', '/api/admin/billing/catalog/plan/availability', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body: { id: 'monthly', version: 1, available: true, reason: 'short', ...proof }
  });
  assert.equal(shortReason.status, 400);
});

test('admin billing catalog: nova versão de valor without proveOwner or with a short reason is refused', async t => {
  const h = await startServer(t, { users: [admin()] });
  const noProof = await h.req('POST', '/api/admin/billing/catalog/plan/price', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body: { planId: 'monthly', unitAmount: 9900, reason: 'a perfectly good reason' }
  });
  assert.equal(noProof.status, 403);
  const shortReason = await h.req('POST', '/api/admin/billing/catalog/plan/price', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body: { planId: 'monthly', unitAmount: 9900, reason: 'short', ...proof }
  });
  assert.equal(shortReason.status, 400);
});

/* ---------- criar oferta: happy path ---------- */
test('admin billing catalog: criar oferta creates a draft Price and an available:false plan', async t => {
  const h = await startServer(t, { users: [admin()] });
  const r = await h.req('POST', '/api/admin/billing/catalog/plan/new', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { id: 'biweekly', display: { 'pt-BR': { name: 'Quinzenal' } }, interval: 'month', intervalCount: 1, unitAmount: 5000, reason: 'launching a new biweekly plan', ...proof }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.available, false);
  const priceRow = await h.row1('SELECT * FROM billing_prices WHERE plan_id = $1', ['biweekly']);
  assert.equal(priceRow.state, 'draft');
  assert.equal(Number(priceRow.unit_amount), 5000);
});

/* ---------- editar apresentação: 409 on a stale version ---------- */
test('admin billing catalog: editar apresentação with a stale version returns 409', async t => {
  const h = await startServer(t, { users: [admin()] });
  const stale = await h.req('POST', '/api/admin/billing/catalog/plan/display', {
    cookie: adminCookie, body: { id: 'monthly', version: 999, display: { 'pt-BR': { name: 'Mensal Novo' } } }
  });
  assert.equal(stale.status, 409);
  const ok = await h.req('POST', '/api/admin/billing/catalog/plan/display', {
    cookie: adminCookie, body: { id: 'monthly', version: 1, display: { 'pt-BR': { name: 'Mensal Novo' } } }
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plan.display['pt-BR'].name, 'Mensal Novo');
});

/* ---------- publicar versão: atomic swap, old Price grandfathered ---------- */
test('admin billing catalog: publicar versão swaps current atomically, the old Price is retired but unchanged', async t => {
  const h = await startServer(t, { users: [admin()] });
  // A subscriber already billed off the plan's original Price (price_monthly_test) — the fixture
  // this test must still be able to name correctly after the plan moves on.
  await h.rows(`INSERT INTO subscriptions (id, user_id, data) VALUES ('sub_pub_1', 'u_admin_1', $1)`, [{ status: 'active', plan: 'monthly', priceId: 'price_monthly_test' }]);

  const draft = await h.req('POST', '/api/admin/billing/catalog/plan/price', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', unitAmount: 9900, decisionRef: 'ISO-1630', reason: 'adjusting for inflation', ...proof }
  });
  assert.equal(draft.status, 200);
  const newPriceId = draft.body.price.id;

  const publish = await h.req('POST', '/api/admin/billing/catalog/plan/publish', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', priceId: newPriceId, version: 1, reason: 'publishing the new monthly price', ...proof }
  });
  assert.equal(publish.status, 200);
  assert.equal(publish.body.plan.currentPriceId, newPriceId);

  const oldRow = await h.row1('SELECT * FROM billing_prices WHERE id = $1', ['price_monthly_test']);
  assert.equal(oldRow.state, 'retired');
  assert.equal(Number(oldRow.unit_amount), 8900, 'the old Price keeps the exact amount it was sold at');
  assert.equal(oldRow.plan_id, 'monthly', 'still named as the monthly plan — a subscriber on it still shows the right name');

  const newRow = await h.row1('SELECT * FROM billing_prices WHERE id = $1', [newPriceId]);
  assert.equal(newRow.state, 'current');
  assert.equal(Number(newRow.unit_amount), 9900);
});

/* ---------- ISO-1625 (T1b review): stale-after-stripe compensation ---------- */
test('ativar/desativar: a losing race after Stripe already flipped reverts the Price back to the winner\'s value', async t => {
  const h = await startServer(t, { users: [admin()] });
  // Two toggles racing the same plan/version at once, opposite directions: whichever wins the DB
  // CAS keeps its own Stripe write; the loser's own write already landed by the time it loses the
  // race and must be reverted — before this fix, Stripe and the DB were simply left disagreeing.
  const bodyA = { id: 'monthly', version: 1, available: false, reason: 'temporarily pulling this plan', ...proof };
  const bodyB = { id: 'monthly', version: 1, available: true, reason: 'keeping this plan on sale', ...proof };
  const [ra, rb] = await Promise.all([
    h.req('POST', '/api/admin/billing/catalog/plan/availability', { cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body: bodyA }),
    h.req('POST', '/api/admin/billing/catalog/plan/availability', { cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body: bodyB })
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = ra.status === 200 ? ra : rb;
  const loser = ra.status === 200 ? rb : ra;
  assert.equal(loser.body.code, 'stale');

  const plan = await h.row1('SELECT * FROM billing_plans WHERE id = $1', ['monthly']);
  const priceRow = h.prices[plan.current_price_id];
  assert.equal(priceRow.active, winner.body.plan.available, 'Stripe converges on the winner — the loser\'s write was reverted, never left standing');
});

test('ativar/desativar: a same-direction race never reactivates a Price the winner correctly left in the requested state (Oráculo review)', async t => {
  const h = await startServer(t, { users: [admin()] });
  const plan0 = await h.row1('SELECT current_price_id FROM billing_plans WHERE id = $1', ['monthly']);
  // Both requests deactivate the same plan/version — a blind "invert my own write" compensation
  // (the original fix) would have the loser reactivate exactly what the winner correctly turned
  // off. `mockDelay` holds the first request's own Stripe call open; `waitForCall` fires the
  // second only once that call has actually landed (never a fixed sleep guessing how long
  // proveOwner's own scrypt verification takes — that guess flaked under full-suite load), so the
  // first always reaches its own DB CAS before the second even starts its own Stripe call.
  h.mockDelay.ms = 200;
  const body = { id: 'monthly', version: 1, available: false, reason: 'pulling this plan off sale', ...proof };
  const first = h.req('POST', '/api/admin/billing/catalog/plan/availability', { cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body });
  await waitForCall(h.calls, c => c.method === 'POST' && c.url === `/v1/prices/${plan0.current_price_id}`);
  const second = await h.req('POST', '/api/admin/billing/catalog/plan/availability', { cookie: adminCookie, headers: { 'Idempotency-Key': idemp() }, body });
  const firstResolved = await first;
  const [winner, loser] = firstResolved.status === 200 ? [firstResolved, second] : [second, firstResolved];
  assert.equal(winner.status, 200, 'the request started first wins the race');
  assert.equal(loser.status, 409);
  assert.equal(loser.body.code, 'stale', 'the loser did reach Stripe first — this is the post-Stripe CAS loss, store.js just never names it stale-after-stripe for this route');

  const plan = await h.row1('SELECT * FROM billing_plans WHERE id = $1', ['monthly']);
  assert.equal(plan.available, false);
  assert.equal(h.prices[plan.current_price_id].active, false, 'still correctly inactive — the loser\'s convergence did not reactivate what the winner turned off');
});

test('publicar versão: two concurrent publishes for the same plan — the loser never reactivates the shared old Price the winner just retired', async t => {
  const h = await startServer(t, { users: [admin()] });
  const draftA = await h.req('POST', '/api/admin/billing/catalog/plan/price', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', unitAmount: 9900, reason: 'candidate version A', ...proof }
  });
  const draftB = await h.req('POST', '/api/admin/billing/catalog/plan/price', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', unitAmount: 10900, reason: 'candidate version B', ...proof }
  });
  const priceA = draftA.body.price.id;
  const priceB = draftB.body.price.id;

  // Same determinism trick as the same-direction availability race above: `waitForCall` fires the
  // second publish only once the first's own activate call has actually landed, so the first
  // always reaches its own `SELECT ... FOR UPDATE` transaction (which also naturally serializes
  // the second behind it either way) before the second even starts its own Stripe calls.
  h.mockDelay.ms = 200;
  const first = h.req('POST', '/api/admin/billing/catalog/plan/publish', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', priceId: priceA, version: 1, reason: 'publishing candidate A', ...proof }
  });
  await waitForCall(h.calls, c => c.method === 'POST' && c.url === `/v1/prices/${priceA}`);
  const second = await h.req('POST', '/api/admin/billing/catalog/plan/publish', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', priceId: priceB, version: 1, reason: 'publishing candidate B', ...proof }
  });
  const firstResolved = await first;
  const [winner, loser, winnerPriceId, loserPriceId] = firstResolved.status === 200
    ? [firstResolved, second, priceA, priceB] : [second, firstResolved, priceB, priceA];
  assert.equal(winner.status, 200, 'the request started first wins the race');
  assert.equal(loser.status, 409);
  assert.equal(loser.body.code, 'stale-after-stripe');

  assert.equal(h.prices[winnerPriceId].active, true, 'the winner\'s own Price stays active — the current one');
  assert.equal(h.prices[loserPriceId].active, false, 'the loser\'s own Price is deactivated — it never became current');
  assert.equal(h.prices.price_monthly_test.active, false, 'the shared old Price stays retired — the loser must not reactivate what the winner correctly retired');
  const plan = await h.row1('SELECT * FROM billing_plans WHERE id = $1', ['monthly']);
  assert.equal(plan.current_price_id, winnerPriceId);
});

test('publicar versão: a version bumped by an unrelated concurrent edit after Stripe already wrote is reverted (stale-after-stripe)', async t => {
  const h = await startServer(t, { users: [admin()] });
  const draft = await h.req('POST', '/api/admin/billing/catalog/plan/price', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', unitAmount: 9900, reason: 'adjusting for inflation', ...proof }
  });
  const newPriceId = draft.body.price.id;

  // Widens the gap between publish's own activate call landing and its response (ISO-1625, T1b
  // review): `waitForCall` fires the unrelated edit only once that call has actually landed, so
  // this lands inside the one window this test needs — after publish's own version check already
  // passed and Stripe already activated the new Price, but before publish's own DB transaction
  // re-checks the version — regardless of how long proveOwner's own scrypt verification took
  // (a fixed sleep guessing that has flaked under full-suite load).
  h.mockDelay.ms = 300;
  const publishPromise = h.req('POST', '/api/admin/billing/catalog/plan/publish', {
    cookie: adminCookie, headers: { 'Idempotency-Key': idemp() },
    body: { planId: 'monthly', priceId: newPriceId, version: 1, reason: 'publishing the new monthly price', ...proof }
  });
  await waitForCall(h.calls, c => c.method === 'POST' && c.url === `/v1/prices/${newPriceId}`);
  const displayEdit = await h.req('POST', '/api/admin/billing/catalog/plan/display', {
    cookie: adminCookie, body: { id: 'monthly', version: 1, display: { 'pt-BR': { name: 'Mensal (editado)' } } }
  });
  assert.equal(displayEdit.status, 200, 'the unrelated edit itself succeeds and bumps the version');
  const publish = await publishPromise;
  assert.equal(publish.status, 409);
  assert.equal(publish.body.code, 'stale-after-stripe');

  // Stripe already activated the new Price and deactivated the old one by the time the DB CAS
  // lost the race — both reverted, so current_price_id (still price_monthly_test) never ends up
  // pointing at a Price Stripe itself says is inactive.
  assert.equal(h.prices[newPriceId].active, false, 'the new Price was deactivated again');
  assert.equal(h.prices.price_monthly_test.active, true, 'the old Price was reactivated');
  const plan = await h.row1('SELECT * FROM billing_plans WHERE id = $1', ['monthly']);
  assert.equal(plan.current_price_id, 'price_monthly_test', 'never moved — still points at an active Price');
});

/* ---------- ISO-1625 (T1b review): reconcile pagination ---------- */
test('admin billing catalog: reconcile pages through prices.list instead of stopping at the first page', async t => {
  const h = await startServer(t, { users: [admin()], pageSize: 1 });
  // Three untracked bf_plan-tagged Prices — with the mock capped to one Price per page
  // (pageSize:1), a single-page reconcile would only ever see the first of these.
  for (const [id, planId] of [['price_page_a', 'monthly'], ['price_page_b', 'quarterly'], ['price_page_c', 'yearly']]) {
    h.prices[id] = {
      id, object: 'price', unit_amount: 12345, currency: 'brl',
      recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1', active: false,
      metadata: { bf_plan: planId, bf_version: '9' }
    };
  }
  const r = await h.req('POST', '/api/admin/billing/catalog/reconcile', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.adopted.sort(), ['price_page_a', 'price_page_b', 'price_page_c']);
  const listCalls = h.calls.filter(c => c.method === 'GET' && c.url.startsWith('/v1/prices?'));
  assert.ok(listCalls.length > 1, `pageSize:1 against more than one Price must take more than one page, saw ${listCalls.length}`);
});

/* ---------- ISO-1625 (T1b review): Idempotency-Key reused for a different action ---------- */
test('admin billing catalog: an Idempotency-Key reused for a different action is refused, never replayed as that action', async t => {
  const h = await startServer(t, { users: [admin()] });
  const key = idemp();
  const first = await h.req('POST', '/api/admin/billing/catalog/plan/price', {
    cookie: adminCookie, headers: { 'Idempotency-Key': key },
    body: { planId: 'monthly', unitAmount: 9900, reason: 'adjusting for inflation', ...proof }
  });
  assert.equal(first.status, 200);
  const second = await h.req('POST', '/api/admin/billing/catalog/plan/availability', {
    cookie: adminCookie, headers: { 'Idempotency-Key': key }, // same key, a different action
    body: { id: 'monthly', version: 1, available: false, reason: 'pulling this plan off sale', ...proof }
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'idempotency-key-reused');
  assert.equal(h.prices.price_monthly_test.active, true, 'never actually touched — refused before calling Stripe');
});

/* ---------- reconcile ---------- */
test('admin billing catalog: reconcile adopts an untracked Price tagged metadata.bf_plan, and retires an unknown subscription Price read off Stripe', async t => {
  const h = await startServer(t, { users: [admin()] });
  // A Price Stripe already has (created by hand, or by a previous attempt whose own DB write was
  // lost) that this catalog has never heard of — tagged exactly the way createOffer tags one.
  h.prices.price_untracked = {
    id: 'price_untracked', object: 'price', unit_amount: 15000, currency: 'brl',
    recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1', active: false,
    metadata: { bf_plan: 'yearly', bf_version: '2' }
  };
  // A subscription billed off a Price this catalog never seeded or created at all.
  h.prices.price_legacy = {
    id: 'price_legacy', object: 'price', unit_amount: 4200, currency: 'brl',
    recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1', active: false, metadata: {}
  };
  await h.rows(`INSERT INTO subscriptions (id, user_id, data) VALUES ('sub_legacy_1', 'u_admin_1', $1)`, [{ status: 'canceled', plan: 'monthly', priceId: 'price_legacy' }]);

  const r = await h.req('POST', '/api/admin/billing/catalog/reconcile', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.body.adopted.includes('price_untracked'));
  assert.ok(r.body.retired.includes('price_legacy'));

  const adoptedRow = await h.row1('SELECT * FROM billing_prices WHERE id = $1', ['price_untracked']);
  assert.equal(adoptedRow.state, 'draft', 'adopted, never auto-published');
  assert.equal(adoptedRow.plan_id, 'yearly');
  assert.equal(Number(adoptedRow.unit_amount), 15000);

  const retiredRow = await h.row1('SELECT * FROM billing_prices WHERE id = $1', ['price_legacy']);
  assert.equal(retiredRow.state, 'retired');
  assert.equal(Number(retiredRow.unit_amount), 4200, 'never invents a value — read straight off Stripe');
});

/* ---------- Idempotency-Key replay ---------- */
test('admin billing catalog: a repeated Idempotency-Key does not create a second Price or a second billing_admin_actions row', async t => {
  const h = await startServer(t, { users: [admin()] });
  const key = idemp();
  const body = { planId: 'monthly', unitAmount: 9900, reason: 'adjusting for inflation', ...proof };
  const first = await h.req('POST', '/api/admin/billing/catalog/plan/price', { cookie: adminCookie, headers: { 'Idempotency-Key': key }, body });
  assert.equal(first.status, 200);
  const second = await h.req('POST', '/api/admin/billing/catalog/plan/price', { cookie: adminCookie, headers: { 'Idempotency-Key': key }, body });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body, 'the replay is handed back the exact same result');

  const priceCreateCalls = h.calls.filter(c => c.method === 'POST' && c.url === '/v1/prices');
  assert.equal(priceCreateCalls.length, 1, 'Stripe was only ever asked to create the Price once');

  const actionRows = await h.rows('SELECT * FROM billing_admin_actions WHERE idempotency_key = $1', [key]);
  assert.equal(actionRows.length, 1);
});

/* ---------- reordenar ---------- */
test('admin billing catalog: reordenar updates sort_order for exactly the current plan set', async t => {
  const h = await startServer(t, { users: [admin()] });
  const r = await h.req('POST', '/api/admin/billing/catalog/order', { cookie: adminCookie, body: { order: ['yearly', 'monthly', 'quarterly'] } });
  assert.equal(r.status, 200);
  const rows = await h.rows('SELECT id, sort_order FROM billing_plans ORDER BY sort_order');
  assert.deepEqual(rows.map(r2 => r2.id), ['yearly', 'monthly', 'quarterly']);

  const partial = await h.req('POST', '/api/admin/billing/catalog/order', { cookie: adminCookie, body: { order: ['monthly'] } });
  assert.equal(partial.status, 400);
  assert.equal(partial.body.code, 'invalid-order');
});
