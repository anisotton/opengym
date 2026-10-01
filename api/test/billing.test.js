/* Stripe billing (ISO-1393, contract fixed by ISO-1392): webhook signature/idempotency, status
   transitions, and the 402 write gate. Real server.js in a child, real PostgreSQL (billing.js's
   own HTTP calls to Stripe are never exercised here — only webhook processing, which is pure local
   verification plus writes to our own tables). STRIPE_API_KEY only needs to look like a key;
   nothing in this file calls out to api.stripe.com.

   None of the simulated webhook events below carry `scheduleTo` in their subscription metadata —
   that is what tells applyStripeEvent's 'customer.subscription.created' case to call
   stripe.subscriptionSchedules.create/update (billing.js), a real network call this file cannot
   make with a fake key. Each event here instead represents the subscription exactly as it would
   already look once that conversion has happened — e.g. a first-period report is a plain `created`
   or `updated` event whose item price is the intro Price and whose metadata has no `scheduleTo` —
   which is also exactly the shape of the real follow-up `updated` event Stripe's own conversion
   fires. The conversion call itself is covered only by the pending Stripe-sandbox validation (see
   the ISO-1393 comment thread), not by this suite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';
import { tempData, spawnApi } from './helpers.mjs';

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

async function startServer(t, { users } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  return spawnApi(t, {
    dataDir,
    env: {
      STRIPE_API_KEY: 'sk_test_unused',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      STRIPE_PRICE_INTRO: INTRO_PRICE
    }
  });
}

function stripeEvent(type, object) {
  return { id: 'evt_' + crypto.randomBytes(12).toString('hex'), type, data: { object } };
}

async function postWebhook(api, event) {
  const payload = JSON.stringify(event);
  const sig = stripeTestClient.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${api}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
    body: payload
  });
  return { status: r.status, body: await r.json() };
}

// `priceId` defaults to the full monthly price — a returning-subscriber or already-converted
// shape. Pass `priceId: INTRO_PRICE` to simulate still being in the first (R$1,99) period.
const sub = (id, overrides) => ({
  id, object: 'subscription', status: 'active', customer: 'cus_1',
  items: { data: [{ price: { id: MONTHLY_PRICE, unit_amount: 8900 } }] },
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
  cancel_at_period_end: false,
  metadata: { userId: 'u_bill_1', plan: 'monthly' },
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

  const first = await postWebhook(h.api, event);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);

  const second = await postWebhook(h.api, event); // byte-identical redelivery, same event.id
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());
  assert.equal(status.status, 'active');
  assert.equal(status.plan, 'monthly');
});

test('POST /api/billing/webhook: subscription status transitions reach GET /api/billing/status', async t => {
  const users = [{ id: 'u_bill_1', name: 'One', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const status = async () => fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());

  // First period: active from the first invoice, not a Stripe trial — `firstPeriod` is what tells
  // the UI apart from the ongoing-subscriber case, and `nextChargeAmount` already shows the
  // upcoming FULL plan charge even though the subscription's current item is still the intro price.
  let r = await postWebhook(h.api, stripeEvent('customer.subscription.created', sub('sub_lifecycle', {
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 } }] }
  })));
  assert.equal(r.status, 200);
  let s = await status();
  assert.equal(s.status, 'active');
  assert.equal(s.active, true);
  assert.equal(s.firstPeriod, true);
  assert.equal(s.nextChargeAmount, 8900, 'the upcoming charge is the full monthly price, not R$1.99');

  // The schedule's phase change: the subscription's item is now the chosen plan's price.
  r = await postWebhook(h.api, stripeEvent('customer.subscription.updated', sub('sub_lifecycle')));
  assert.equal(r.status, 200);

  // The first full-price invoice: firstFullCharge is recorded once, keyed off the invoice's own
  // line price rather than billing_reason — robust regardless of event ordering.
  r = await postWebhook(h.api, stripeEvent('invoice.paid', {
    id: 'in_1', object: 'invoice', subscription: 'sub_lifecycle', customer: 'cus_1',
    lines: { data: [{ price: { id: MONTHLY_PRICE } }] },
    amount_paid: 8900, currency: 'brl', created: Math.floor(Date.now() / 1000)
  }));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'active');
  assert.equal(s.active, true);
  assert.equal(s.firstPeriod, false, 'no longer in the first period once the full invoice landed');
  assert.equal(s.firstFullCharge.amount, 8900);
  assert.equal(s.nextChargeAmount, 8900, 'now read straight off the subscription item, same amount');

  // A failed renewal moves the account to past_due — it still writes (issue rule: Stripe retries
  // before cancelling).
  r = await postWebhook(h.api, stripeEvent('invoice.payment_failed', {
    id: 'in_2', object: 'invoice', subscription: 'sub_lifecycle', customer: 'cus_1'
  }));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'past_due');
  assert.equal(s.active, true, 'past_due still writes');

  // The Portal's cancellation, once the period actually ends.
  r = await postWebhook(h.api, stripeEvent('customer.subscription.deleted', sub('sub_lifecycle', { status: 'canceled' })));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'canceled');
  assert.equal(s.active, false);
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

  await postWebhook(h.api, stripeEvent('customer.subscription.created', sub('sub_gate', { metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 200, 'an active subscription (first period or not) lifts the 402');

  await postWebhook(h.api, stripeEvent('customer.subscription.updated', sub('sub_gate', { status: 'past_due', metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 200, 'past_due still writes — Stripe is still retrying');

  await postWebhook(h.api, stripeEvent('customer.subscription.deleted', sub('sub_gate', { status: 'canceled', metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
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
