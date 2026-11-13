/* #348: the "rest over" push belongs to the device that started the rest. When that device had no
   subscription of its own, sendPush fell back to every subscription of the account, so the phone
   rang for a rest timed on the desktop. The subscriptions here have private endpoints: the send
   path refuses and prunes each one it would have contacted, without opening a socket, so what is
   left in db.json says which ones it tried. Real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempData, spawnApi, seedUserState, testPool } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = { Cookie: `gymsid=${mintSession('u_test_1')}` };
const sub = (endpoint, deviceId) => ({
  userId: 'u_test_1', endpoint, keys: { p256dh: 'p', auth: 'a' }, ...(deviceId ? { deviceId } : {}), created: new Date().toISOString()
});

async function startServer(t, subs) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_test_1', name: 'One', created: new Date().toISOString() }], creds: [], invites: [], subs
  }));
  const h = await spawnApi(t, { dataDir, env: { AUDIT_LOG: '0', REMINDER_TICK_MS: '100000' } });
  // The profile's document is a row (ISO-1403), seeded once the boot import has made the user.
  await seedUserState(h.databaseUrl, 'u_test_1', { _rev: 1, lang: 'en', workouts: [], routines: [] });
  return h;
}

async function restOn(h, deviceId) {
  const r = await fetch(`${h.api}/api/push/rest-timer`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:8080' },
    body: JSON.stringify({ seconds: 1, deviceId })
  });
  assert.equal(r.status, 200);
  await new Promise(res => setTimeout(res, 2500));   // fires at 1 s, then prunes what it tried
  const p = testPool(h.databaseUrl);
  try { return (await p.query('SELECT endpoint FROM push_subscriptions')).rows.map(r => r.endpoint).sort(); } finally { await p.end(); }
}

test('a rest on a device without a subscription rings no other device', async t => {
  const h = await startServer(t, [sub('https://10.0.0.2/phone', 'phoneBBBBBB'), sub('https://10.0.0.3/old')]);
  // The desktop has none: the phone is left alone, the subscription from an older client still rings.
  assert.deepEqual(await restOn(h, 'desktopAAAA'), ['https://10.0.0.2/phone']);
});

test('a rest on a subscribed device rings that device and nobody else', async t => {
  const h = await startServer(t, [sub('https://10.0.0.2/phone', 'phoneBBBBBB'), sub('https://10.0.0.4/desk', 'desktopAAAA')]);
  assert.deepEqual(await restOn(h, 'desktopAAAA'), ['https://10.0.0.2/phone']);
});
