/* ISO-1447 (Phase 4, LGPD): the Stripe side of account deletion (billing.js's
   cleanupStripeCustomer/attemptStripeCleanup/tickStripeCleanup) and the webhook-after-deletion
   fix (resolveUserId), tested directly against real PostgreSQL and a local stand-in for
   api.stripe.com — no server.js spawned, since none of this is HTTP-route behaviour; that part
   (DELETE /api/account end to end) is server-account-delete.test.js.

   One mock Stripe server for the whole file: billing.js's getStripe() caches its client the first
   time anything here calls it, so every test points `route` (reassigned per test) at the same
   server rather than starting a fresh one each time — the second `STRIPE_API_HOST`/`PORT` pair
   would just never be read. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate, withTransaction } from '../db.js';
import { insertStripeCleanup, getStripeCleanupDue, bumpStripeCleanupFailure, createUser } from '../store.js';
import { attemptStripeCleanup, tickStripeCleanup, applyStripeEvent } from '../billing.js';

let mock, route = () => ({ status: 404, json: { error: { message: 'unhandled', type: 'invalid_request_error' } } });

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { status, json } = route(req.method, req.url, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  process.env.STRIPE_API_KEY = 'sk_test_unused';
  process.env.STRIPE_API_HOST = '127.0.0.1';
  process.env.STRIPE_API_PORT = String(mock.address().port);
});
after(() => mock.close());

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}

const queue = (pool, cleanup) => withTransaction(pool, client => insertStripeCleanup(client, cleanup));

test('attemptStripeCleanup: cancels the subscription and deletes the customer, then clears the pending row', async t => {
  const pool = await withPool(t);
  const calls = [];
  route = (method, url) => {
    calls.push(`${method} ${url}`);
    if (method === 'GET' && url === '/v1/subscriptions/sub_1') return { status: 200, json: { id: 'sub_1', object: 'subscription', schedule: null } };
    if (method === 'DELETE' && url === '/v1/subscriptions/sub_1') return { status: 200, json: { id: 'sub_1', object: 'subscription', status: 'canceled' } };
    if (method === 'DELETE' && url === '/v1/customers/cus_1') return { status: 200, json: { id: 'cus_1', object: 'customer', deleted: true } };
    return { status: 404, json: { error: { message: 'unexpected call: ' + method + ' ' + url, type: 'invalid_request_error' } } };
  };
  const row = await queue(pool, { customerId: 'cus_1', subscriptionIds: ['sub_1'] });
  await attemptStripeCleanup(pool, row);
  assert.deepEqual(calls.sort(), [
    'GET /v1/subscriptions/sub_1', 'DELETE /v1/subscriptions/sub_1', 'DELETE /v1/customers/cus_1'
  ].sort());
  assert.deepEqual(await getStripeCleanupDue(pool), [], 'the pending row is gone');
});

test('attemptStripeCleanup: a Subscription Schedule is cancelled instead of the subscription directly', async t => {
  const pool = await withPool(t);
  const calls = [];
  route = (method, url) => {
    calls.push(`${method} ${url}`);
    if (method === 'GET' && url === '/v1/subscriptions/sub_2') return { status: 200, json: { id: 'sub_2', object: 'subscription', schedule: 'sched_1' } };
    if (method === 'POST' && url === '/v1/subscription_schedules/sched_1/cancel') return { status: 200, json: { id: 'sched_1', object: 'subscription_schedule', status: 'canceled' } };
    if (method === 'DELETE' && url === '/v1/customers/cus_2') return { status: 200, json: { id: 'cus_2', object: 'customer', deleted: true } };
    return { status: 404, json: { error: { message: 'unexpected call: ' + method + ' ' + url, type: 'invalid_request_error' } } };
  };
  const row = await queue(pool, { customerId: 'cus_2', subscriptionIds: ['sub_2'] });
  await attemptStripeCleanup(pool, row);
  // subscriptionSchedules.cancel already cancels the subscription it drives — calling
  // subscriptions.cancel too would hit one Stripe already considers canceled.
  assert.ok(!calls.includes('DELETE /v1/subscriptions/sub_2'), calls.join(', '));
  assert.ok(calls.includes('POST /v1/subscription_schedules/sched_1/cancel'), calls.join(', '));
  assert.deepEqual(await getStripeCleanupDue(pool), []);
});

test('attemptStripeCleanup: a subscription or customer Stripe has no record of is treated as already gone', async t => {
  const pool = await withPool(t);
  route = (method, url) => {
    if (method === 'GET' && url === '/v1/subscriptions/sub_3') return { status: 404, json: { error: { message: 'No such subscription', type: 'invalid_request_error', code: 'resource_missing' } } };
    if (method === 'DELETE' && url === '/v1/customers/cus_3') return { status: 404, json: { error: { message: 'No such customer', type: 'invalid_request_error', code: 'resource_missing' } } };
    return { status: 404, json: { error: { message: 'unexpected', type: 'invalid_request_error' } } };
  };
  const row = await queue(pool, { customerId: 'cus_3', subscriptionIds: ['sub_3'] });
  await assert.doesNotReject(() => attemptStripeCleanup(pool, row));
  assert.deepEqual(await getStripeCleanupDue(pool), [], 'treated as success, not left pending');
});

test('tickStripeCleanup: a real failure backs off instead of retrying immediately, and a later attempt clears it', async t => {
  const pool = await withPool(t);
  let customerDeleteFails = true;
  route = (method, url) => {
    if (method === 'GET' && url === '/v1/subscriptions/sub_4') return { status: 200, json: { id: 'sub_4', object: 'subscription', schedule: null } };
    if (method === 'DELETE' && url === '/v1/subscriptions/sub_4') return { status: 200, json: { id: 'sub_4', object: 'subscription', status: 'canceled' } };
    if (method === 'DELETE' && url === '/v1/customers/cus_4') {
      return customerDeleteFails
        ? { status: 500, json: { error: { message: 'internal error, try again', type: 'api_error' } } }
        : { status: 200, json: { id: 'cus_4', object: 'customer', deleted: true } };
    }
    return { status: 404, json: { error: { message: 'unexpected', type: 'invalid_request_error' } } };
  };
  await queue(pool, { customerId: 'cus_4', subscriptionIds: ['sub_4'] });
  await tickStripeCleanup(pool);
  let pending = await getStripeCleanupDue(pool);
  assert.equal(pending.length, 0, 'the row is not due yet — its backoff was just set');
  const { rows } = await pool.query('SELECT attempts, next_attempt_at, last_error FROM stripe_cleanup WHERE customer_id = $1', ['cus_4']);
  assert.equal(rows.length, 1, 'the row is still there, not lost');
  assert.equal(rows[0].attempts, 1);
  assert.ok(rows[0].next_attempt_at > new Date(), 'pushed into the future');
  assert.match(rows[0].last_error, /internal error/);

  // The periodic retry, once its backoff has elapsed and Stripe is reachable again.
  await pool.query('UPDATE stripe_cleanup SET next_attempt_at = now() WHERE customer_id = $1', ['cus_4']);
  customerDeleteFails = false;
  await tickStripeCleanup(pool);
  assert.deepEqual(await getStripeCleanupDue(pool), []);
  assert.equal((await pool.query('SELECT 1 FROM stripe_cleanup WHERE customer_id = $1', ['cus_4'])).rows.length, 0);
});

// ISO-1447's other half of the Stripe contract: a webhook for an account already deleted must
// never recreate anything. metadata.userId is Stripe's own echo of what this instance sent it at
// Checkout time — never re-validated by Stripe itself — so a late customer.subscription.updated
// naming a since-deleted account is exactly the case resolveUserId has to catch before handing
// that id to upsertSubscription, whose subscriptions.user_id FK would otherwise turn this into a
// 500 (and Stripe retrying it forever) instead of the no-op it should be.
test('applyStripeEvent: an event for an account that no longer exists is a no-op, not a crash', async t => {
  const pool = await withPool(t);
  const event = {
    id: 'evt_after_delete', type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_ghost', object: 'subscription', status: 'active', customer: 'cus_ghost',
        items: { data: [{ price: { id: 'price_x', unit_amount: 100 }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] },
        cancel_at_period_end: false,
        // The deleted account's own id, exactly as Checkout set it at subscription creation —
        // Stripe echoes metadata back verbatim, it does not know the account is gone.
        metadata: { userId: 'u_deleted', plan: 'monthly' }
      }
    }
  };
  await assert.doesNotReject(() => applyStripeEvent(pool, event));
  assert.equal((await pool.query('SELECT 1 FROM subscriptions WHERE id = $1', ['sub_ghost'])).rows.length, 0);

  // Control: the same event for an account that does exist still applies normally.
  await createUser(pool, { id: 'u_alive', name: 'Ana', created: new Date().toISOString() });
  const alive = { ...event, id: 'evt_alive', data: { object: { ...event.data.object, id: 'sub_alive', metadata: { userId: 'u_alive', plan: 'monthly' } } } };
  await applyStripeEvent(pool, alive);
  assert.equal((await pool.query('SELECT user_id FROM subscriptions WHERE id = $1', ['sub_alive'])).rows[0]?.user_id, 'u_alive');
});
