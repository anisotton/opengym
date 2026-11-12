-- ISO-1594/ISO-1609: teacher/student roles, a link between the two, and workout assignments.
-- "Program" (migrations/007) stays the admin's curated catalog; this is a teacher assigning
-- either their own routine (a snapshot, never a live reference back to their library — a
-- teacher must never reach a student's state after delivering, D16) or one of those Programs.
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'student'
  CHECK (role IN ('student', 'teacher'));
-- Every existing account becomes 'student' through the DEFAULT — no backfill needed.

-- Single-use, same shape as device_links (hash only, the code itself is never stored). One
-- teacher can have several live at once (several classes), unlike a device link.
CREATE TABLE teacher_invites (
  hash        text PRIMARY KEY,
  teacher_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX teacher_invites_teacher_idx ON teacher_invites(teacher_id);

-- PK on student_id: a student has at most one teacher. scope_version is the TEACHER_SCOPE_VERSION
-- (teacher.js) accepted at the time of accepting — a wider allowlist later needs a fresh accept.
-- share_bodyweight is its own opt-in (D12), off by default, independent of scope_version.
CREATE TABLE teacher_links (
  student_id       text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  teacher_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_version    integer NOT NULL,
  share_bodyweight boolean NOT NULL DEFAULT false,
  accepted_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (student_id <> teacher_id)
);
CREATE INDEX teacher_links_teacher_idx ON teacher_links(teacher_id);

-- payload is a validated snapshot (a routine) or `{ programId }` — never a live reference to the
-- teacher's own library (D16) or to the admin Program catalog beyond its id. days indexes the
-- same way S.week does (getDay(): 0 = Sunday .. 6 = Saturday).
CREATE TABLE teacher_assignments (
  id            text PRIMARY KEY,
  teacher_id    text REFERENCES users(id) ON DELETE SET NULL,
  student_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('routine', 'program')),
  payload       jsonb NOT NULL,
  starts_on     date NOT NULL,
  days          smallint[] CHECK (days IS NULL OR (cardinality(days) BETWEEN 1 AND 7
                                    AND days <@ ARRAY[0,1,2,3,4,5,6]::smallint[])),
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  end_reason    text CHECK (end_reason IN ('replaced', 'ended', 'unlinked', 'role-revoked')),
  delivered_at  timestamptz,
  end_acked_at  timestamptz,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
-- D14: at most one active assignment per student, enforced by the database, not by application
-- discipline — a race between two "assign" calls for the same student can only ever insert one.
CREATE UNIQUE INDEX teacher_assignments_one_active ON teacher_assignments(student_id) WHERE ended_at IS NULL;
CREATE INDEX teacher_assignments_student_idx ON teacher_assignments(student_id, created_at DESC);

-- D13: the teacher's private notes about a student, erased the moment the relationship that
-- justified them ends (endLink, store.js) — whatever the reason.
CREATE TABLE teacher_notes (
  id          text PRIMARY KEY,
  teacher_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teacher_notes_pair_idx ON teacher_notes(teacher_id, student_id, created_at DESC);

-- Durable proof of consent (LGPD) — survives audit.log's own rotation and either account's
-- deletion, same reasoning as program_events (migrations/007): no FK on either id.
CREATE TABLE teacher_link_events (
  id            bigserial PRIMARY KEY,
  student_id    text NOT NULL,
  teacher_id    text NOT NULL,
  action        text NOT NULL CHECK (action IN ('accept', 'end', 'bodyweight-on', 'bodyweight-off')),
  reason        text CHECK (reason IN ('by-student', 'by-teacher', 'role-revoked')),
  scope_version integer,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teacher_link_events_student_idx ON teacher_link_events(student_id, at DESC);
