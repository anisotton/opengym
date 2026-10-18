-- ISO-1485: admin-curated catalog of training programs — the instance's own content, not a
-- user's training data (see docs/ADMIN_PROGRAMS.md for why this is "Program", not "training":
-- Workout already means a logged session in this codebase, Routine already means a user's own
-- exercise list). category/difficulty are fixed enums enforced by CHECK; widening either needs a
-- migration that remaps existing rows before the CHECK changes, same as any other fixed-vocabulary
-- column here. rev is optimistic concurrency, same shape as user_state.rev: an edit against a
-- stale rev loses the compare-and-set instead of silently overwriting a concurrent one.
--
-- deleted_at/deleted_by is the trash, orthogonal to status — a trashed row keeps whatever status
-- it had, but that stops counting as published while deleted_at is set (server.js's own read path
-- enforces that; the column itself doesn't need to). The unique title index is partial
-- (WHERE deleted_at IS NULL) so a trashed title is free for a new program to reuse right away.
--
-- created_by/updated_by/deleted_by/cover_updated_by are all ON DELETE SET NULL: the program
-- outlives whichever admin account touched it, same precedent as invites.created_by in
-- migrations/001_init.sql. Unlike invites.used_by (migrations/003), there's no "must stay burned"
-- rule here for any of these columns to break — SET NULL is enough.
CREATE TABLE programs (
  id               text PRIMARY KEY,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  category         text NOT NULL CHECK (category IN ('strength', 'hypertrophy', 'conditioning', 'mobility', 'general')),
  difficulty       text NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  session_minutes  integer NOT NULL CHECK (session_minutes BETWEEN 1 AND 600),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  rev              integer NOT NULL DEFAULT 1,
  -- Cover image metadata only — the bytes live on disk at DATA_DIR/program-covers/<cover_file>,
  -- outside api/media.js's per-profile store (its GC would otherwise collect a file no profile's
  -- own state ever references). Either every cover_* column is set, or none are: there is no
  -- cover without alt text, and no alt text without a cover.
  cover_file       text CHECK (cover_file ~ '^[0-9a-f]{64}\.(jpg|png|webp)$'),
  cover_mime       text CHECK (cover_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  cover_width      integer CHECK (cover_width BETWEEN 1 AND 4000),
  cover_height     integer CHECK (cover_height BETWEEN 1 AND 4000),
  cover_bytes      integer CHECK (cover_bytes > 0),
  cover_alt        text,
  cover_updated_at timestamptz,
  cover_updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text REFERENCES users(id) ON DELETE SET NULL,
  published_at     timestamptz,
  deleted_at       timestamptz,
  deleted_by       text REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT programs_cover_all_or_none CHECK (
    (cover_file IS NULL AND cover_mime IS NULL AND cover_width IS NULL AND cover_height IS NULL AND cover_bytes IS NULL AND cover_alt IS NULL)
    OR
    (cover_file IS NOT NULL AND cover_mime IS NOT NULL AND cover_width IS NOT NULL AND cover_height IS NOT NULL AND cover_bytes IS NOT NULL AND cover_alt IS NOT NULL)
  )
);
CREATE UNIQUE INDEX programs_title_active_idx ON programs (lower(title)) WHERE deleted_at IS NULL;
CREATE INDEX programs_status_idx ON programs (status) WHERE deleted_at IS NULL;
CREATE INDEX programs_category_idx ON programs (category);
CREATE INDEX programs_deleted_idx ON programs (deleted_at) WHERE deleted_at IS NOT NULL;

-- Append-only audit trail (plan rev 2 §2.4) — the durable "who/when/what" that survives both the
-- purge of the program it is about and the deletion of the admin account that acted, by
-- snapshotting the title and actor name rather than carrying a foreign key either could outlive.
-- No FK on program_id either, for the same reason; no cleanup route by design, unlike data/audit.log
-- (AUDIT_DAYS/AUDIT_MAX) — the volume is one row per admin action on a Program, never per request.
CREATE TABLE program_events (
  id            bigserial PRIMARY KEY,
  program_id    text NOT NULL,
  program_title text NOT NULL,
  action        text NOT NULL CHECK (action IN (
                   'create', 'update', 'publish', 'unpublish', 'cover_set', 'cover_remove',
                   'trash', 'restore', 'purge', 'purge_auto'
                 )),
  actor_id      text,
  actor_name    text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  changes       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX program_events_program_idx ON program_events (program_id, at DESC);
