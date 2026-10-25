-- Google (OpenID Connect) sign-in (ISO-1597). One row per linked external identity — `provider` is
-- always 'google' for now, kept as a column (not baked into the table name) so a second provider
-- is a row shape, not another migration. Same ON DELETE CASCADE as passkeys: deleting a profile,
-- by the app or by admin/user/delete, takes its Google identity with it for free.
CREATE TABLE oauth_identities (
  provider      text NOT NULL,
  subject       text NOT NULL,                              -- the provider's own account id (the ID token's `sub`)
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         text,                                       -- the provider's e-mail at the time of linking — display only
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  PRIMARY KEY (provider, subject)
);
-- One Google account per profile: a second would make "which one signs you in" ambiguous, and
-- DELETE /api/account/google would have nothing unambiguous to name.
CREATE UNIQUE INDEX oauth_identities_provider_user_idx ON oauth_identities(provider, user_id);
