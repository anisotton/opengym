/* Stripe billing (ISO-1393, contract fixed by ISO-1392): webhook signature/idempotency, status
   transitions, and the 402 write gate. Real server.js in a child, real PostgreSQL. STRIPE_API_KEY
   only needs to look like a key; nothing in this file calls out to api.stripe.com — the one test
   that exercises convertToSchedule's own network call (below) points billing.js's Stripe client at
   a local mock instead (STRIPE_API_HOST/STRIPE_API_PORT, billing.js's getStripe()), rather than
   skipping that call entirely.

   Event fixtures below use the account's actual pinned API version shape (2026-08-26.dahlia,
   Stripe's "flexible billing" object layout) by default — `current_period_end` under
   `items.data[0]`, not at the subscription's root, and an invoice's subscription id under
   `parent.subscription_details.subscription`, not at the invoice's root. Sentinel's sandbox
   findings were exactly this: the old tests built events in the pre-dahlia flat shape by hand, so
   they could never have caught billing.js reading fields that moved. Dedicated fallback tests
   below cover the flat shape too, since applyStripeEvent still reads it as a secondary source. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import Stripe from 'stripe';
import { tempData, spawnApi, testPool } from './helpers.mjs';

// Opened and closed within the same statement (server-billing-catalog.test.js's own comment on
// this exact shape explains why: a pool kept open across a fetch has hit "terminating connection
// due to administrator command" racing spawnApi's own teardown).
async function sql(databaseUrl, text, params) {
  const pool = testPool(databaseUrl);
  try { return await pool.query(text, params); }
  finally { await pool.end(); }
}

const SECRET = crypto.randomBytes(32).toString('hex');
const WEBHOOK_SECRET = 'whsec_test_' + crypto.randomBytes(8).toString('hex');
const stripeTestClient = new Stripe('sk_test_unused', { apiVersion: '2026-08-26.dahlia' });

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json' });

const INTRO_PRICE = 'price_intro_test';
const MONTHLY_PRICE = 'price_monthly_test';

// ISO-1625 (T2b): fetch-latest means applyStripeEvent now calls subscriptions.retrieve for every
// customer.subscription.* event — every test in this file needs somewhere for that call to land,
// not just the one (below) that already exercised convertToSchedule's own network call. One
// stateful mock, created fresh per test by startServer and always wired via STRIPE_API_HOST/
// STRIPE_API_PORT, replaces what used to be a special case.
function mockStripeApi() {
  const calls = [];
  const subscriptions = {};
  const schedules = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      calls.push({ method: req.method, url: req.url, body });
      const notFound = () => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found' } })); };

      if (req.method === 'GET' && u.pathname.match(/^\/v1\/subscriptions\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const s = subscriptions[id];
        if (!s) return notFound();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(s));
      }
      if (req.method === 'GET' && u.pathname.match(/^\/v1\/subscription_schedules\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const s = schedules[id];
        if (!s) return notFound();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(s));
      }
      if (req.method === 'POST' && u.pathname === '/v1/subscription_schedules') {
        const id = 'sched_test_1';
        const schedule = schedules[id] || {
          id, object: 'subscription_schedule',
          phases: [{ start_date: 1700000000, end_date: 1702678400, items: [{ price: INTRO_PRICE, quantity: 1 }] }]
        };
        schedules[id] = schedule;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(schedule));
      }
      if (req.method === 'POST' && u.pathname.match(/^\/v1\/subscription_schedules\/[^/]+$/)) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const schedule = schedules[id] || { id, object: 'subscription_schedule', phases: [] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(schedule));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `not mocked: ${req.method} ${req.url}` } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, subscriptions, schedules })));
}

async function startServer(t, { users, env = {} } = {}) {
  const mock = await mockStripeApi();
  t.after(() => mock.server.close());
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, {
    dataDir,
    env: {
      STRIPE_API_KEY: 'sk_test_unused',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(mock.port),
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      STRIPE_PRICE_INTRO: INTRO_PRICE,
      ...env
    }
  });
  h.mock = mock;
  return h;
}

function stripeEvent(type, object) {
  return { id: 'evt_' + crypto.randomBytes(12).toString('hex'), type, data: { object } };
}

// Registers the event's own object as the mock's current "live" state before posting — every
// test but one wants its event payload and the live object fetch-latest retrieves back to be the
// same, byte for byte, same as before fetch-latest existed. `registerLive: false` is the one
// escape hatch, for the out-of-order-convergence test below, which sets up a *different*,
// deliberately fresher live object itself and must stop this helper from clobbering it with the
// (deliberately stale) event payload it is about to post.
async function postWebhook(h, event, { registerLive = true } = {}) {
  const obj = event.data.object;
  if (registerLive && obj?.id) {
    if (event.type.startsWith('customer.subscription.')) h.mock.subscriptions[obj.id] = obj;
    else if (event.type.startsWith('subscription_schedule.')) h.mock.schedules[obj.id] = obj;
  }
  const payload = JSON.stringify(event);
  const sig = stripeTestClient.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${h.api}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
    body: payload
  });
  return { status: r.status, body: await r.json() };
}

// `priceId` defaults to the full monthly price — a returning-subscriber or already-converted
// shape. Pass `priceId: INTRO_PRICE` to simulate still being in the first (R$1,99) period.
// `current_period_end` lives under the item (dahlia shape), not at the subscription's root — see
// the fallback test below for the pre-dahlia root-level shape applyStripeEvent also still reads.
const sub = (id, overrides) => ({
  id, object: 'subscription', status: 'active', customer: 'cus_1',
  items: {
    data: [{
      price: { id: MONTHLY_PRICE, unit_amount: 8900 },
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400
    }]
  },
  cancel_at_period_end: false,
  metadata: { userId: 'u_bill_1', plan: 'monthly' },
  ...overrides
});

// Dahlia-shape invoice: the subscription id lives under parent.subscription_details, and a line's
// price is a bare id under pricing.price_details.price — neither lives where the invoice's root
// (`subscription`) or an old-shape line (`price.id`, an object) used to carry it. See the fallback
// tests below for both pre-dahlia root-level shapes.
const invoice = (id, subId, overrides) => ({
  id, object: 'invoice', customer: 'cus_1',
  parent: { subscription_details: { subscription: subId } },
  lines: { data: [{ pricing: { price_details: { price: MONTHLY_PRICE } } }] },
  amount_paid: 8900, currency: 'brl', created: Math.floor(Date.now() / 1000),
  ...overrides
});

test('POST /api/billing/webhook: wrong signature is refused, never applied', async t => {
  const users = [{ id: 'u_bill_1', name: 'One', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const event = stripeEvent('customer.subscription.created', sub('sub_bad_sig'));
  const r = await fetch(`${h.api}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=deadbeef' },
    body: JSON.stringify(event)
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid signature');

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());
  assert.equal(status.status, 'none', 'a refused signature never reaches applyStripeEvent');
});

test('POST /api/billing/webhook: a repeated event id is acknowledged once and applied once', async t => {
  const users = [{ id: 'u_bill_1', name: 'One', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const event = stripeEvent('customer.subscription.created', sub('sub_dupe'));

  const first = await postWebhook(h, event);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);

  const second = await postWebhook(h, event); // byte-identical redelivery, same event.id
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());
  assert.equal(status.status, 'active');
  assert.equal(status.plan, 'monthly');
});

test('POST /api/billing/webhook: a failed apply un-claims the event, so a Stripe retry gets a real second attempt', async t => {
  // Sentinel's finding on the first version of this fix: claimStripeEvent landing is not the same
  // as applyStripeEvent's effect actually having happened — the schedule conversion in particular
  // calls out to Stripe itself and can fail for reasons that have nothing to do with our data. This
  // reproduces that class of failure without needing a real network call: `id: null` makes
  // upsertSubscription's INSERT violate subscriptions.id's NOT NULL constraint, which is enough to
  // prove the general mechanism (server.js unclaims on ANY throw from applyStripeEvent, not only a
  // Stripe-specific one).
  const users = [{ id: 'u_bill_4', name: 'Four', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const event = stripeEvent('customer.subscription.updated', sub(null, { metadata: { userId: 'u_bill_4', plan: 'monthly' } }));

  const first = await postWebhook(h, event);
  assert.equal(first.status, 500, 'applying the event failed');

  // If the claim had survived that failure, this exact event.id would now read back as a no-op
  // duplicate instead of being retried — it isn't, which is the whole point of unclaiming.
  const second = await postWebhook(h, event);
  assert.equal(second.status, 500, 'retried, not silently skipped as already-handled');

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_4') }).then(r => r.json());
  assert.equal(status.status, 'none', 'nothing was ever actually committed');
});

test('POST /api/billing/webhook: subscription status transitions reach GET /api/billing/status', async t => {
  const users = [{ id: 'u_bill_1', name: 'One', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const status = async () => fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());

  // First period: active from the first invoice, not a Stripe trial — `firstPeriod` is what tells
  // the UI apart from the ongoing-subscriber case, and `nextChargeAmount` already shows the
  // upcoming FULL plan charge even though the subscription's current item is still the intro price.
  let r = await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_lifecycle', {
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] }
  })));
  assert.equal(r.status, 200);
  let s = await status();
  assert.equal(s.status, 'active');
  assert.equal(s.active, true);
  assert.equal(s.firstPeriod, true);
  assert.equal(s.nextChargeAmount, 8900, 'the upcoming charge is the full monthly price, not R$1.99');

  // The schedule's phase change: the subscription's item is now the chosen plan's price.
  r = await postWebhook(h, stripeEvent('customer.subscription.updated', sub('sub_lifecycle')));
  assert.equal(r.status, 200);

  // The first full-price invoice: firstFullCharge is recorded once, keyed off the invoice's own
  // line price rather than billing_reason — robust regardless of event ordering. Subscription id
  // is read from the dahlia shape (parent.subscription_details.subscription) — see `invoice()`.
  r = await postWebhook(h, stripeEvent('invoice.paid', invoice('in_1', 'sub_lifecycle')));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'active');
  assert.equal(s.active, true);
  assert.equal(s.firstPeriod, false, 'no longer in the first period once the full invoice landed');
  assert.equal(s.firstFullCharge.amount, 8900);
  assert.equal(s.nextChargeAmount, 8900, 'now read straight off the subscription item, same amount');

  // A failed renewal moves the account to past_due — it still writes (issue rule: Stripe retries
  // before cancelling).
  r = await postWebhook(h, stripeEvent('invoice.payment_failed', invoice('in_2', 'sub_lifecycle')));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'past_due');
  assert.equal(s.active, true, 'past_due still writes');

  // The Portal's cancellation, once the period actually ends.
  r = await postWebhook(h, stripeEvent('customer.subscription.deleted', sub('sub_lifecycle', { status: 'canceled' })));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'canceled');
  assert.equal(s.active, false);
});

test('POST /api/billing/webhook: current_period_end falls back to the pre-dahlia root-level field', async t => {
  // Sentinel's bug #2 (ISO-1393 sandbox validation, 2026-10-03): on this account's pinned API
  // version, current_period_end moved off the subscription's root into items.data[0] — the shape
  // every other fixture in this file now uses by default. This test pins down the other half of
  // the fix: an event that still carries the old flat field (a replay from before this account's
  // API version pin, or any instance on an older `stripe` SDK/account default) must keep working.
  const users = [{ id: 'u_bill_6', name: 'Six', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const flatPeriodEnd = Math.floor(Date.now() / 1000) + 45 * 86400;
  const flatSub = {
    id: 'sub_flat', object: 'subscription', status: 'active', customer: 'cus_1',
    items: { data: [{ price: { id: MONTHLY_PRICE, unit_amount: 8900 } }] }, // no items[0].current_period_end
    current_period_end: flatPeriodEnd, // root-level, pre-dahlia
    cancel_at_period_end: false,
    metadata: { userId: 'u_bill_6', plan: 'monthly' }
  };
  const r = await postWebhook(h, stripeEvent('customer.subscription.created', flatSub));
  assert.equal(r.status, 200);
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_6') }).then(r => r.json());
  assert.equal(status.nextChargeDate, new Date(flatPeriodEnd * 1000).toISOString());
});

test('POST /api/billing/webhook: invoice.paid falls back to the pre-dahlia root-level subscription field', async t => {
  // Sentinel's bug #3: an invoice's subscription id moved to parent.subscription_details.subscription
  // on this account's API version — every other invoice fixture in this file now uses that shape by
  // default (see `invoice()`). This pins down the flat fallback the same way as current_period_end
  // above: without it, invoice.paid/invoice.payment_failed are a silent no-op (subId is undefined).
  const users = [{ id: 'u_bill_7', name: 'Seven', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_flat_inv', { metadata: { userId: 'u_bill_7', plan: 'monthly' } })));

  const flatInvoice = {
    id: 'in_flat', object: 'invoice', customer: 'cus_1', subscription: 'sub_flat_inv', // root-level, pre-dahlia
    lines: { data: [{ price: { id: MONTHLY_PRICE } }] },
    amount_paid: 8900, currency: 'brl', created: Math.floor(Date.now() / 1000)
  };
  const r = await postWebhook(h, stripeEvent('invoice.paid', flatInvoice));
  assert.equal(r.status, 200);
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_7') }).then(r => r.json());
  assert.equal(status.status, 'active');
  assert.equal(status.active, true, 'invoice.paid was not a silent no-op');
});

test('POST /api/billing/webhook: firstFullCharge is recorded from the dahlia invoice line shape, with a pre-dahlia fallback', async t => {
  // Sentinel's bug #4 (found only after bug #3 was fixed — a real paid full-price invoice in the
  // sandbox never got this far before): an invoice line's price moved from `price.id` (an object)
  // to `pricing.price_details.price` (already a string id). `invoice()`'s default fixture already
  // uses the dahlia shape, so the lifecycle test above covers the primary path — this pins down the
  // pre-dahlia fallback the same way as the other two fields.
  const users = [{ id: 'u_bill_9', name: 'Nine', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_flat_price', {
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    metadata: { userId: 'u_bill_9', plan: 'monthly' }
  })));

  const flatPriceInvoice = invoice('in_flat_price', 'sub_flat_price', {
    lines: { data: [{ price: { id: MONTHLY_PRICE } }] } // root-level price.id, pre-dahlia
  });
  const r = await postWebhook(h, stripeEvent('invoice.paid', flatPriceInvoice));
  assert.equal(r.status, 200);
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_9') }).then(r => r.json());
  assert.equal(status.firstFullCharge?.amount, 8900, 'firstFullCharge was recorded from the flat line price, not silently skipped');
});

test('customer.subscription.created with scheduleTo: the real schedule update sends end_date, never the rejected iterations param', async t => {
  // Sentinel's bug #1: subscriptionSchedules.update with phases[].iterations fails on this
  // account's API version (400 parameter_unknown). Points billing.js's Stripe client at a local
  // mock (STRIPE_API_HOST/STRIPE_API_PORT) so the exact outgoing request can be inspected, instead
  // of only re-reading the source that changed.
  const { server, port, calls, subscriptions } = await mockStripeApi();
  t.after(() => server.close());
  const users = [{ id: 'u_bill_8', name: 'Eight', created: new Date().toISOString() }];
  const h = await startServer(t, { users, env: { STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(port) } });

  const event = stripeEvent('customer.subscription.created', sub('sub_sched', {
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    metadata: { userId: 'u_bill_8', plan: 'monthly', scheduleTo: MONTHLY_PRICE }
  }));
  // ISO-1633: applyStripeEvent now retrieves the live subscription unconditionally (so the full
  // upsert can run even when the schedule conversion is skipped or fails) — this server talks to
  // this standalone mock (not h.mock), so that GET needs its own registered object, same as
  // postWebhook's registerLive does for h.mock in every other test.
  subscriptions[event.data.object.id] = event.data.object;
  const r = await postWebhook(h, event);
  assert.equal(r.status, 200, 'convertToSchedule succeeded against the mock');

  const create = calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules');
  assert.ok(create, 'subscriptionSchedules.create was called');
  const update = calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules/sched_test_1');
  assert.ok(update, 'subscriptionSchedules.update was called');
  assert.match(update.body, /end_date/, 'uses end_date, the version-correct way to say "one more cycle"');
  assert.doesNotMatch(update.body, /iterations/, 'iterations is rejected by this account\'s API version');
});

test('customer.subscription.created with a failed-first-charge/3DS subscription does not 500, and the schedule conversion runs once Stripe reports it active (ISO-1633)', async t => {
  // Real Stripe refuses subscriptionSchedules.create against a subscription that is still
  // `incomplete` — exactly what Stripe reports while the 1st charge (the R$1,99 intro Price) has
  // failed or still needs 3DS. The old code called convertToSchedule unconditionally from this
  // event, with nothing catching that rejection: a 500, and the upsert below it never ran, so the
  // row was left permanently missing priceId/customerId/plan.
  const users = [{ id: 'u_bill_18', name: 'Eighteen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });

  const incomplete = sub('sub_1633', {
    status: 'incomplete',
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    metadata: { userId: 'u_bill_18', plan: 'monthly', scheduleTo: MONTHLY_PRICE }
  });
  let r = await postWebhook(h, stripeEvent('customer.subscription.created', incomplete));
  assert.equal(r.status, 200, 'an incomplete subscription must not crash the webhook');

  const createWhileIncomplete = h.mock.calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules');
  assert.equal(createWhileIncomplete, undefined, 'the conversion is not attempted while the subscription is not yet active');

  let status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_18') }).then(r => r.json());
  assert.equal(status.status, 'incomplete');
  assert.equal(status.active, false, 'an incomplete first charge never grants access');
  assert.equal(status.plan, 'monthly', 'the full upsert ran despite the deferred conversion — plan is never left null');

  // The retry succeeds (or 3DS completes): Stripe reports the same subscription active, still
  // carrying scheduleTo and no schedule yet.
  const nowActive = sub('sub_1633', {
    status: 'active',
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    metadata: { userId: 'u_bill_18', plan: 'monthly', scheduleTo: MONTHLY_PRICE }
  });
  r = await postWebhook(h, stripeEvent('customer.subscription.updated', nowActive));
  assert.equal(r.status, 200);

  const createOnceActive = h.mock.calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules');
  assert.ok(createOnceActive, 'the schedule conversion ran once the subscription became active, not stuck on the intro price forever');

  status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_18') }).then(r => r.json());
  assert.equal(status.status, 'active');
  assert.equal(status.active, true);
});

test('customer.subscription.updated never re-converts a subscription that is already past the intro Price, even with scheduleTo and no schedule (ISO-1633, Oráculo review)', async t => {
  // scheduleTo is never cleared from the subscription's own metadata, so a gate that only checks
  // "active/past_due, no schedule yet" would re-fire every time schedule happens to be empty again
  // later in the subscription's life — the two-phase schedule's own end_behavior:'release' releases
  // it once the final (full-plan) phase starts, or an operator releases it by hand in the
  // Dashboard. Either way, the subscription's item is by then the plan's own Price, not the intro
  // one — this must not trigger a brand new conversion back to the original scheduleTo price.
  const users = [{ id: 'u_bill_19', name: 'Nineteen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });

  const alreadyConverted = sub('sub_1633b', {
    status: 'active',
    items: { data: [{ price: { id: MONTHLY_PRICE, unit_amount: 8900 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    metadata: { userId: 'u_bill_19', plan: 'monthly', scheduleTo: MONTHLY_PRICE } // leftover, never cleared
  });
  const r = await postWebhook(h, stripeEvent('customer.subscription.updated', alreadyConverted));
  assert.equal(r.status, 200);

  const create = h.mock.calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules');
  assert.equal(create, undefined, 'no reconversion is attempted once the item is already the plan\'s own (non-intro) Price');

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_19') }).then(r => r.json());
  assert.equal(status.status, 'active');
  assert.equal(status.plan, 'monthly');
});

test('PUT /api/data: 402 without a subscription, 200 once active, 200 while past_due, 402 once canceled', async t => {
  const users = [{ id: 'u_bill_2', name: 'Two', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const put = () => fetch(`${h.api}/api/data`, {
    method: 'PUT', headers: headers('u_bill_2'),
    body: JSON.stringify({ state: { workouts: [{ id: 'w1' }], routines: [] } })
  });

  let r = await put();
  assert.equal(r.status, 402);
  assert.equal((await r.json()).code, 'billing');

  // reading and exporting stay open even with no subscription at all
  const get = await fetch(`${h.api}/api/data`, { headers: headers('u_bill_2') });
  assert.equal(get.status, 200);

  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_gate', { metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 200, 'an active subscription (first period or not) lifts the 402');

  await postWebhook(h, stripeEvent('customer.subscription.updated', sub('sub_gate', { status: 'past_due', metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 200, 'past_due still writes — Stripe is still retrying');

  await postWebhook(h, stripeEvent('customer.subscription.deleted', sub('sub_gate', { status: 'canceled', metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 402, 'canceled goes back to read-only');
});

test('PUT /api/data: no 402 at all when billing is not configured', async t => {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const users = [{ id: 'u_bill_3', name: 'Three', created: new Date().toISOString() }];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, { dataDir }); // no STRIPE_* env at all
  const r = await fetch(`${h.api}/api/data`, {
    method: 'PUT', headers: headers('u_bill_3'),
    body: JSON.stringify({ state: { workouts: [], routines: [] } })
  });
  assert.equal(r.status, 200);

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_3') });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { enabled: false });

  const webhook = await fetch(`${h.api}/api/billing/webhook`, { method: 'POST', body: '{}' });
  assert.equal(webhook.status, 404);
});

/* ---------- ISO-1625 (T2b): fetch-latest convergence, new events, pauseCollection, duplicateOf ---------- */

test('POST /api/billing/webhook: an out-of-order redelivery converges on the live Stripe object, never regresses to a stale payload', async t => {
  const users = [{ id: 'u_bill_11', name: 'Eleven', created: new Date().toISOString() }];
  const h = await startServer(t, { users });

  // The account is really already past_due by the time this delivery arrives — some earlier,
  // faster delivery already advanced it there. Registered directly as the mock's live truth.
  h.mock.subscriptions.sub_order = sub('sub_order', { status: 'past_due', metadata: { userId: 'u_bill_11', plan: 'monthly' } });

  // This event's own payload is stale — still says `active`, from before that transition. A
  // pre-fetch-latest applyStripeEvent would have written exactly this and regressed the account.
  const staleEvent = stripeEvent('customer.subscription.updated', sub('sub_order', { status: 'active', metadata: { userId: 'u_bill_11', plan: 'monthly' } }));
  const r = await postWebhook(h, staleEvent, { registerLive: false });
  assert.equal(r.status, 200);

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_11') }).then(r => r.json());
  assert.equal(status.status, 'past_due', 'converged on the live object, not the stale event payload');
});

test('PUT /api/data: pauseCollection (persisted by the webhook) refuses writes even while status stays active, and clears on resume', async t => {
  const users = [{ id: 'u_bill_13', name: 'Thirteen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const put = () => fetch(`${h.api}/api/data`, {
    method: 'PUT', headers: headers('u_bill_13'),
    body: JSON.stringify({ state: { workouts: [{ id: 'w1' }], routines: [] } })
  });

  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_pause', { metadata: { userId: 'u_bill_13', plan: 'monthly' } })));
  let r = await put();
  assert.equal(r.status, 200, 'active and unpaused: writes');

  await postWebhook(h, stripeEvent('customer.subscription.updated', sub('sub_pause', {
    pause_collection: { behavior: 'void', resumes_at: null }, metadata: { userId: 'u_bill_13', plan: 'monthly' }
  })));
  r = await put();
  assert.equal(r.status, 402, 'status is still active, but collection is paused — suspension is never free access');
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_13') }).then(r => r.json());
  assert.equal(status.status, 'active', 'no synthetic "paused" status');

  await postWebhook(h, stripeEvent('customer.subscription.updated', sub('sub_pause', {
    pause_collection: null, metadata: { userId: 'u_bill_13', plan: 'monthly' }
  })));
  r = await put();
  assert.equal(r.status, 200, 'resumed — writes again');
});

test('webhook: a second live subscription for the same account is marked duplicateOf the first, never refunded automatically', async t => {
  const users = [{ id: 'u_bill_14', name: 'Fourteen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });

  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_dup_a', { metadata: { userId: 'u_bill_14', plan: 'monthly' } })));
  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_dup_b', { metadata: { userId: 'u_bill_14', plan: 'monthly' } })));

  const rowA = await sql(h.databaseUrl, "SELECT data->>'duplicateOf' AS d FROM subscriptions WHERE id = 'sub_dup_a'").then(r => r.rows[0]);
  const rowB = await sql(h.databaseUrl, "SELECT data->>'duplicateOf' AS d FROM subscriptions WHERE id = 'sub_dup_b'").then(r => r.rows[0]);
  assert.equal(rowA.d, null, 'the older subscription is primary — never marked a duplicate of itself');
  assert.equal(rowB.d, 'sub_dup_a', 'the newer one is marked duplicateOf the primary');

  // No refund, no cancellation — this app never resolves a duplicate on its own.
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_14') }).then(r => r.json());
  assert.equal(status.active, true);

  // Cancelling the duplicate clears the mark — self-healing, not a one-shot flag.
  await postWebhook(h, stripeEvent('customer.subscription.deleted', sub('sub_dup_b', { status: 'canceled', metadata: { userId: 'u_bill_14', plan: 'monthly' } })));
  const rowB2 = await sql(h.databaseUrl, "SELECT data->>'duplicateOf' AS d FROM subscriptions WHERE id = 'sub_dup_b'").then(r => r.rows[0]);
  assert.equal(rowB2.d, null, 'no longer live — no longer marked a duplicate of anything');

  // ISO-1625 (Oráculo review): cancelling sub_dup_b is the very row the webhook just touched —
  // getAccountSubscription (not "whichever row has the newest updated_at") must still answer with
  // sub_dup_a, the account's own still-active primary, or this paying account would be refused
  // its own writes the moment its duplicate is cleaned up.
  const statusAfter = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_14') }).then(r => r.json());
  assert.equal(statusAfter.active, true, 'the primary subscription still grants access after the duplicate is cancelled');
  const put = await fetch(`${h.api}/api/data`, {
    method: 'PUT', headers: headers('u_bill_14'), body: JSON.stringify({ state: { workouts: [{ id: 'w1' }], routines: [] } })
  });
  assert.equal(put.status, 200, 'PUT /api/data still writes for the primary subscription holder');
});

test('webhook: subscription_schedule.updated/released keep scheduleId/scheduledPriceId on the subscription in step', async t => {
  const users = [{ id: 'u_bill_15', name: 'Fifteen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_sched_evt', { metadata: { userId: 'u_bill_15', plan: 'monthly' } })));

  // `status` is what fetch-latest actually decides "still governs" by (ISO-1625, Oráculo review)
  // — not which event type arrived — so the fixture carries it explicitly in both phases below.
  const schedule = {
    id: 'sched_evt_1', object: 'subscription_schedule', subscription: 'sub_sched_evt', status: 'active',
    phases: [{ start_date: 1700000000, end_date: null, items: [{ price: MONTHLY_PRICE }] }]
  };
  let r = await postWebhook(h, stripeEvent('subscription_schedule.updated', schedule));
  assert.equal(r.status, 200);
  let row = await sql(h.databaseUrl, "SELECT data->>'scheduleId' AS s, data->>'scheduledPriceId' AS p FROM subscriptions WHERE id = 'sub_sched_evt'").then(r => r.rows[0]);
  assert.equal(row.s, 'sched_evt_1');
  assert.equal(row.p, MONTHLY_PRICE);

  // `released` — the schedule let go; `released_subscription` is where the id lives once
  // `subscription` itself has already gone back to null.
  r = await postWebhook(h, stripeEvent('subscription_schedule.released', {
    ...schedule, subscription: null, released_subscription: 'sub_sched_evt', status: 'released'
  }));
  assert.equal(r.status, 200);
  row = await sql(h.databaseUrl, "SELECT data->>'scheduleId' AS s, data->>'scheduledPriceId' AS p FROM subscriptions WHERE id = 'sub_sched_evt'").then(r => r.rows[0]);
  assert.equal(row.s, null);
  assert.equal(row.p, null);
});

test('webhook: a delayed subscription_schedule.updated arriving after release does not resurrect scheduleId (fetch-latest, not event type)', async t => {
  const users = [{ id: 'u_bill_17', name: 'Seventeen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  await postWebhook(h, stripeEvent('customer.subscription.created', sub('sub_sched_order', { metadata: { userId: 'u_bill_17', plan: 'monthly' } })));

  // The schedule is really already released by the time this delivery arrives — registered
  // directly as the mock's live truth, same pattern as the out-of-order subscription test above.
  h.mock.schedules.sched_order_1 = {
    id: 'sched_order_1', object: 'subscription_schedule', subscription: null,
    released_subscription: 'sub_sched_order', status: 'released',
    phases: [{ start_date: 1700000000, end_date: null, items: [{ price: MONTHLY_PRICE }] }]
  };

  // This event's own payload is stale — an `updated` from before the release, still claiming to
  // govern. A pre-fetch-latest handler (or one that trusted the event type instead of the live
  // status) would have resurrected scheduleId on a subscription this schedule no longer drives.
  const staleEvent = stripeEvent('subscription_schedule.updated', {
    id: 'sched_order_1', object: 'subscription_schedule', subscription: 'sub_sched_order', status: 'active',
    phases: [{ start_date: 1700000000, end_date: null, items: [{ price: MONTHLY_PRICE }] }]
  });
  const r = await postWebhook(h, staleEvent, { registerLive: false });
  assert.equal(r.status, 200);

  const row = await sql(h.databaseUrl, "SELECT data->>'scheduleId' AS s, data->>'scheduledPriceId' AS p FROM subscriptions WHERE id = 'sub_sched_order'").then(r => r.rows[0]);
  assert.equal(row.s, null, 'converged on the live (released) schedule, not the stale event payload');
  assert.equal(row.p, null);
});

test('webhook: price.created/price.updated adopt an unknown bf_plan-tagged Price as a draft, ignore everything else', async t => {
  const users = [{ id: 'u_bill_16', name: 'Sixteen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  // No catalog seeded in this file's env (no STRIPE_PRICE_QUARTERLY/YEARLY) — a bf_plan tag naming
  // a plan this instance has never heard of is exactly the "nothing sane to attach it to" case.
  const unknownPlanPrice = {
    id: 'price_unknown_plan', object: 'price', unit_amount: 5000, currency: 'brl',
    recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1',
    metadata: { bf_plan: 'a-plan-nobody-made' }
  };
  let r = await postWebhook(h, stripeEvent('price.created', unknownPlanPrice));
  assert.equal(r.status, 200);
  let row = await sql(h.databaseUrl, 'SELECT * FROM billing_prices WHERE id = $1', ['price_unknown_plan']).then(r => r.rows[0]);
  assert.equal(row, undefined, 'no plan to attach it to — nothing adopted');

  // A Price with no bf_plan tag at all — not ours, untouched either way.
  const unrelatedPrice = { ...unknownPlanPrice, id: 'price_unrelated', metadata: {} };
  r = await postWebhook(h, stripeEvent('price.updated', unrelatedPrice));
  assert.equal(r.status, 200);
  row = await sql(h.databaseUrl, 'SELECT * FROM billing_prices WHERE id = $1', ['price_unrelated']).then(r => r.rows[0]);
  assert.equal(row, undefined);
});

test('webhook: price.updated on an already-known Price never changes its stored value (immutable once known)', async t => {
  const users = [{ id: 'u_bill_18', name: 'Eighteen', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  // This file's env never seeds the full catalog (no STRIPE_PRICE_QUARTERLY/YEARLY) — a plan and
  // its current Price are inserted directly, just enough for reconcilePriceFromStripe's own
  // getCatalogPlan/getPriceById lookups to find something already known. Price before plan (its
  // own plan_id FK would otherwise have nothing to point at yet), plan's current_price_id set
  // last once the price row it references actually exists.
  await sql(h.databaseUrl, `INSERT INTO billing_plans (id, display, interval, interval_count, available) VALUES ('monthly', '{"pt-BR":{"name":"Mensal"}}', 'month', 1, true)`);
  await sql(h.databaseUrl,
    `INSERT INTO billing_prices (id, plan_id, kind, unit_amount, currency, interval, interval_count, livemode, stripe_product_id, state)
     VALUES ($1, 'monthly', 'recurring', 8900, 'brl', 'month', 1, false, 'prod_1', 'current')`, [MONTHLY_PRICE]);
  await sql(h.databaseUrl, `UPDATE billing_plans SET current_price_id = $1 WHERE id = 'monthly'`, [MONTHLY_PRICE]);
  const before = await sql(h.databaseUrl, 'SELECT unit_amount FROM billing_prices WHERE id = $1', [MONTHLY_PRICE]).then(r => r.rows[0]);
  assert.equal(Number(before.unit_amount), 8900, 'the thing this test is about to try to disturb');

  // A Price this catalog already knows about, reported back with a different amount — Stripe
  // itself would never actually do this (a Price's own amount is immutable on Stripe's side too),
  // but an operator error or a malformed delivery is exactly what "só active/metadata, nunca
  // valor" (plan §3) exists to shrug off.
  const tampered = {
    id: MONTHLY_PRICE, object: 'price', unit_amount: 999999, currency: 'brl',
    recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1',
    metadata: { bf_plan: 'monthly' }
  };
  const r = await postWebhook(h, stripeEvent('price.updated', tampered));
  assert.equal(r.status, 200);
  const after = await sql(h.databaseUrl, 'SELECT unit_amount FROM billing_prices WHERE id = $1', [MONTHLY_PRICE]).then(r => r.rows[0]);
  assert.equal(Number(after.unit_amount), 8900, 'the stored amount never moved — an already-known row is never touched by this event');
});
