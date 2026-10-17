-- ISO-1390: records which version of the Terms of Use / Privacy Policy an account accepted, and
-- when. Two columns on `users` rather than a history table: only the latest acceptance matters
-- for deciding whether to ask again (compared against LEGAL_VERSION), and data/audit.log already
-- keeps the event itself. Both stay NULL for accounts that never accepted — imported ones, or
-- those created before this migration — which is what makes the app prompt them.
ALTER TABLE users ADD COLUMN terms_accepted_version text;
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;
