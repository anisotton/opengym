-- Phase 1 (ISO-1387) foundation schema. Replaces DATA_DIR/db.json (users, creds, subs, invites,
-- deviceLinks) and DATA_DIR/state-<uid>.json. Field-by-field mapping from the current JSON shape
-- is noted per table below — nothing in db.json is dropped; anything without an obvious column
-- goes to that table's `extra` JSONB instead (see ISO-1402).
--
-- users.id / passkeys.id / invites.code / device_links.hash / push_subscriptions.user_id keep the
-- exact string values already in db.json (base64url ids, hex hashes, invite codes) — no reissuing.

CREATE TABLE users (
  id                       text PRIMARY KEY,               -- db.users[].id (crypto.randomBytes(12) base64url)
  name                     text NOT NULL,                  -- .name
  email                    text UNIQUE,                    -- .email (optional)
  email_verified_at        timestamptz,                    -- reserved for Phase 2 (account/e-mail); unused today
  admin                    boolean NOT NULL DEFAULT false,  -- .admin (ADMIN_UIDS-based admins have no row flag)
  disabled                 boolean NOT NULL DEFAULT false,  -- .disabled
  session_version          integer NOT NULL DEFAULT 0,      -- .sv (bumped to invalidate existing session cookies)
  password_hash            text,                            -- .pw.h
  password_set_at          timestamptz,                     -- .pw.set
  password_reset_hash      text,                            -- .pwReset.h
  password_reset_expires_at timestamptz,                    -- .pwReset.exp (epoch ms -> timestamptz)
  password_reset_by        text,                            -- .pwReset.by (admin user id); FK added below, after invites exists
  invited_by               text,                            -- .invitedBy (invite code); FK added below, after invites exists
  last_pull_at             timestamptz,                     -- .lastPull (epoch ms -> timestamptz)
  created_at               timestamptz NOT NULL DEFAULT now(), -- .created
  extra                    jsonb NOT NULL DEFAULT '{}'::jsonb  -- any db.json field this schema didn't anticipate
);

-- Invite codes. users.invited_by and invites.used_by/created_by are mutually referential, so this
-- table is created after users and the cross-reference on users is added afterwards.
CREATE TABLE invites (
  code        text PRIMARY KEY,                                  -- db.invites[].code
  note        text,                                               -- .note
  created_by  text REFERENCES users(id) ON DELETE SET NULL,       -- .createdBy (admin)
  created_at  timestamptz NOT NULL DEFAULT now(),                 -- .created
  used_by     text REFERENCES users(id) ON DELETE SET NULL,       -- .usedBy
  used_at     timestamptz                                         -- .usedAt
  -- `.revoked` is not carried over: server.js never actually sets it (revoke deletes the row
  -- instead), so there is no data to lose in leaving the column out.
);
CREATE INDEX invites_used_by_idx ON invites(used_by);

ALTER TABLE users
  ADD CONSTRAINT users_password_reset_by_fkey FOREIGN KEY (password_reset_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT users_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES invites(code) ON DELETE SET NULL;

-- WebAuthn credentials — db.creds[] (passkeys-store.js).
CREATE TABLE passkeys (
  id            text PRIMARY KEY,                              -- .id (the credential id)
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- .userId
  public_key    text NOT NULL,                                 -- .publicKey (base64url)
  counter       bigint NOT NULL DEFAULT 0,                     -- .counter
  transports    text[] NOT NULL DEFAULT '{}',                  -- .transports
  name          text,                                          -- .name (optional label)
  created_at    timestamptz NOT NULL DEFAULT now(),             -- .created
  last_used_at  timestamptz                                     -- .lastUsed
);
CREATE INDEX passkeys_user_id_idx ON passkeys(user_id);

-- Per-profile app state — DATA_DIR/state-<uid>.json, an opaque blob the app itself owns. `rev`
-- keeps the same optimistic-concurrency meaning the API already exposes (GET/PUT /api/data):
-- `UPDATE user_state SET state = $1, rev = rev + 1 WHERE user_id = $2 AND rev = $3` — zero rows
-- updated means the same 409 conflict server.js returns today.
CREATE TABLE user_state (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  rev         bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Real, revocable sessions. Nothing writes here yet — server.js still signs stateless cookies
-- keyed on session_version — but the table exists from Phase 1 on so Phase 1b can switch to it
-- ("sign out everywhere" today just bumps session_version; this lets it revoke one device at a
-- time instead).
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

-- Web Push endpoints — db.subs[]. `endpoint` is the natural key server.js already upserts on.
CREATE TABLE push_subscriptions (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- .userId
  endpoint    text NOT NULL UNIQUE,                                 -- .endpoint
  p256dh      text NOT NULL,                                        -- .keys.p256dh
  auth        text NOT NULL,                                        -- .keys.auth
  device_id   text,                                                 -- .deviceId (optional)
  created_at  timestamptz NOT NULL DEFAULT now()                    -- .created
);
CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions(user_id);

-- One-time device-pairing links — db.deviceLinks[] (device-link.js). `hash` is the sha256 the
-- code hashes to; like today, the code itself is never stored.
CREATE TABLE device_links (
  hash        text PRIMARY KEY,                                    -- .h
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- .userId
  expires_at  timestamptz NOT NULL,                                 -- .exp (epoch ms -> timestamptz)
  created_at  timestamptz NOT NULL DEFAULT now()                    -- .created (epoch ms -> timestamptz)
);
CREATE INDEX device_links_user_id_idx ON device_links(user_id);

-- Stripe billing (Phase 3). Created empty now, per ISO-1387/ISO-1402 — no data to migrate, and
-- the exact shape (customer id, price, period) is Phase 3's decision; `data` holds whatever it
-- needs until then without another migration blocking on it.
CREATE TABLE subscriptions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_id_idx ON subscriptions(user_id);

-- Stripe webhook idempotency (Phase 3). Created empty now, same reasoning as `subscriptions`.
CREATE TABLE stripe_events (
  id           text PRIMARY KEY,
  type         text,
  data         jsonb,
  received_at  timestamptz NOT NULL DEFAULT now()
);
