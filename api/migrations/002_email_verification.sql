-- Phase 2 (ISO-1397): verified e-mail + password-less recovery.
--
-- `email` on `users` and the reserved-but-unused `email_verified_at` both already exist
-- (migrations/001_init.sql) — this migration makes the uniqueness check they imply actually
-- case-insensitive, and adds what Phase 2 needs on top: a birth date and one-time tokens.
--
-- The 001 UNIQUE on `email` compared addresses byte-for-byte; every write already lower-cases
-- through normalizeEmail() (password.js) before it reaches this column, so in practice the two
-- have agreed since day one — this index is what turns that into an actual guarantee at the
-- database level instead of a convention every future caller has to remember to keep. `email`
-- itself stays nullable: it is required for every signup from here on (enforced in server.js,
-- not here), but an account from before this phase keeps `email IS NULL` until its owner is
-- asked for one — the partial index lets as many of those coexist as there are old accounts.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- Decision 2 of ISO-1386: the signup form asks for a birth date (to show, not block, an under-18
-- notice — ISO-1398's concern, not this one's); nullable for the same reason `email` is.
ALTER TABLE users ADD COLUMN birth_date date;

-- One-time tokens for the two flows that prove someone controls an address: e-mail confirmation
-- after signup ('verify', 24h) and "I lost my access" ('recover', 15min) — see email-tokens.js
-- for the code math (a random token, and the sha256 this column actually holds) and store.js for
-- the single-use claim (an UPDATE ... WHERE used_at IS NULL, same idiom as invites.used_by).
-- `used_at` instead of deleting on claim (unlike device_links, which only ever holds one *live*
-- link at a time) keeps a record a support request can be checked against — "was this link ever
-- opened" — the way invites.used_by/used_at already does.
CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'recover')),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_token_hash_idx ON email_tokens(token_hash);
-- What a fresh request (register/verify's own token, "resend", "I lost my access") invalidates
-- before it inserts the next one: every outstanding, unused token of that purpose for that user.
CREATE INDEX email_tokens_user_purpose_idx ON email_tokens(user_id, purpose) WHERE used_at IS NULL;
