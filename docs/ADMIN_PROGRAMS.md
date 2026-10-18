# Admin: training program catalog

An instance-wide catalog an admin curates from the dashboard — not any one user's own routines
or logged workouts. This page is the admin-facing reference; see
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md#training-program-catalog) for the two env vars that
configure it and [`api/openapi.yaml`](../api/openapi.yaml) for the HTTP contract.

## Glossary

openGym already uses three related words for three different things. A fourth, **Program**, is
new with this feature — it does not replace or rename any of the other three:

| Term | What it means | Who owns it | Where it lives |
|---|---|---|---|
| **Exercise** | A movement ("Barbell Bench Press") | built-in (1,324, immutable) or a user's own | the frontend bundle / that user's own state |
| **Routine** | A list of exercises a user put together for a day | that user | that user's own state |
| **Workout** | A session that user actually logged (date, sets) | that user | that user's own state |
| **Program** | A catalog entry an admin curates for the instance | the instance (any admin) | PostgreSQL (`programs` table) |

A Program is metadata only — a title, description, category, difficulty, an estimated session
length and an optional cover image. It does not reference any Exercise, Routine or Workout, and
nothing in the end-user app reads it yet; the admin dashboard is the only surface for it today.

**Category** (the program's main goal — pick one; a mixed program is `general`) and
**difficulty** are fixed lists, each with a short description in the admin form:

| Category | Difficulty |
|---|---|
| `strength` — max force, low reps, heavy load | `beginner` — under 6 months of consistent training |
| `hypertrophy` — muscle growth, moderate/high volume | `intermediate` — 6 months to 2 years |
| `conditioning` — cardio, metcon, intervals | `advanced` — 2+ years, solid technique on the basics |
| `mobility` — range of motion, active recovery | |
| `general` — general fitness or mixed goals | |

Changing either list needs a migration that remaps existing rows first — there is no category or
difficulty CRUD in the dashboard.

## Lifecycle

```
             publish            trash                        purge (typed confirmation)
  [draft] ⇄────────────⇄ [published] ───────▶ [in trash] ───────────────────────────────▶ gone
     │      unpublish                           ▲   │
     └─────────────── trash ───────────────────▶┘   └─ auto-purge after PROGRAM_TRASH_DAYS ──▶ gone
                                       restore (always comes back as a draft)
```

- **Trash** is a soft delete: the program disappears from the catalog at once, but nothing is
  destroyed. Its title is freed for reuse (another program may claim it) while it's in the trash.
- **Restore** always comes back as a `draft` — republishing is a separate, explicit step, so a
  deleted program never silently reappears to anyone.
- A program in the trash is **read-only**: it cannot be edited, published or given a new cover
  until it's restored.
- **Purge** (permanent delete) only works from the trash, and the server requires the program's
  exact title typed back as confirmation (`confirmTitle` in the request) — the dashboard's own
  "type the title" gate is convenience, the server re-checks the same thing. There is no undo
  past this point.
- **Auto-purge**: anything still in the trash past `PROGRAM_TRASH_DAYS` (default 30; `0` disables
  it) is purged automatically, on an hourly sweep, logged the same way a manual purge is
  (`program_events.action = 'purge_auto'`, actor "system").

Two programs cannot share a title (case-insensitive) while both are active; a trashed program's
title doesn't count, so restoring one that collides with an active program's title fails until
one of them is renamed.

Edits use optimistic concurrency: every program carries a `rev`, and a save against a stale `rev`
is refused (`409 {code: "stale", current}`) rather than silently overwriting someone else's
change — the dashboard shows a banner with a "Reload" button when that happens.

## Auditing

Three layers, each answering a different question:

1. **The row itself** — `createdAt`/`createdBy`, `updatedAt`/`updatedBy`, `publishedAt`,
   `deletedAt`/`deletedBy`, `coverUpdatedAt`/`coverUpdatedBy`. This is what the dashboard shows
   today. If the admin account that acted is later deleted, the `*By` id goes away (the program
   itself is unaffected) but the event history below keeps the name.
2. **`program_events`** — an append-only, per-program history (visible as "History" on each
   program's detail sheet): who, when, what changed, for every create/update/publish/unpublish/
   trash/restore/cover change/purge. It has no foreign key on the actor or the program, on
   purpose — it has to survive both the program being purged and the admin account being deleted.
   There is no cleanup route for it; the volume is one row per admin action.
3. **`./data/audit.log`** — the instance's existing activity log (`admin.program.*`,
   `program.purge.auto`), for the same "Activity log" card every other admin action already shows
   up in. It's subject to the log's own retention (`AUDIT_LOG`/`AUDIT_MAX`/`AUDIT_DAYS`) and can
   be turned off; `program_events` is the durable record regardless.

## Cover image

Optional, and 16:9 by construction: the browser crops whatever you pick to that ratio
(centered) before it ever leaves your device, scrubbing EXIF/GPS along the way, and caps it at
1600×900. The server accepts JPEG, PNG or WebP, validated by the file's own magic number (not its
name or declared type) — an SVG, GIF, video or renamed file is refused regardless of its
extension — up to `PROGRAM_COVER_MAX_MB` (default 5 MB).

**Alt text is required whenever a cover is set.** It has to describe the image, not restate the
title or the file name — both of those are refused with a clear message. Without a cover, the
program shows a plain placeholder tinted by its category instead; a cover that fails to load
later (the file went missing on disk) falls back to the same placeholder with a "Cover missing"
note, rather than a broken image.

A cover's bytes are stored outside any one user's upload space (`DATA_DIR/program-covers/`,
named by their own SHA-256), so they survive independently of any profile and are swept clean
once nothing references them any more — replacing or removing a cover does not touch a copy
still used by another program that happens to share the exact same image.

This dashboard is the only place a cover (or any Program data) is visible today — there is no
end-user route yet. If one is added later, the contract is: only a `published` program outside
the trash is visible there, and anything else answers 404 (not 403, so it doesn't reveal that a
draft or trashed program exists).
