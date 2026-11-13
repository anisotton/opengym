-- openGym v1.4.4, on PostgreSQL instead of db.json and files under DATA_DIR. Purely additive.

-- The watch relay (watch-relay.js, Zepp OS watches): a watch link is a token of its own, stored
-- only as a SHA-256, carrying the session version it was made under so "sign out everywhere" ends
-- it with every session. Upstream keeps these in db.json (`watchLinks`).
CREATE TABLE watch_links (
  id          text PRIMARY KEY,                                     -- .id (6 random bytes, hex)
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- .userId
  sv          integer NOT NULL,                                     -- .sv
  hash        text NOT NULL UNIQUE,                                 -- .h
  name        text NOT NULL,                                        -- .name
  created_at  timestamptz NOT NULL,                                 -- .created
  seen_at     timestamptz NOT NULL                                  -- .seen
);
CREATE INDEX watch_links_user_id_idx ON watch_links(user_id);

-- One mailbox per profile between the page and its watches ({ snapshot, snapAt, events }).
-- Upstream: DATA_DIR/watch-<uid>.json.
CREATE TABLE watch_boxes (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  box         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Integrations (integrations/, INTEGRATIONS=webhook): a profile's connections, as the list
-- integrations/store.js keeps (secrets already sealed with a key derived from DATA_DIR/secret).
-- Upstream: DATA_DIR/integrations/u-<uid>.json.
CREATE TABLE integration_connections (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  connections jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The delivery outbox (integrations/outbox.js): one document { jobs, done, failed }, rewritten
-- whole like upstream's DATA_DIR/integrations/outbox.json. A single row (id = 1).
CREATE TABLE integration_outbox (
  id          integer PRIMARY KEY CHECK (id = 1),
  doc         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
