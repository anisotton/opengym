# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
For people, the same map with diagrams is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What this is

openGym is a self-hosted gym & body-weight tracker PWA. Three containers (`api` + `web` + `db`,
PostgreSQL — Phase 1 foundation, ISO-1387/1402) plus a `./data` folder the user owns — no
third-party account, no telemetry. Passkey (WebAuthn) login, installable as a home-screen app,
optional Capacitor shells for standalone Android/iOS builds. License: AGPL-3.0-or-later.

## Project layout

```
frontend/  React 19 + Vite app (src/views, src/components, src/store, src/lib). Builds to static files.
           android/ + ios/ are the Capacitor shells for the standalone mobile app (docs/MOBILE.md).
api/       backend — server.js (Node, no framework), deps: @simplewebauthn/server, web-push, pg,
           stripe, undici. coach/ is the optional AI coach; openapi.yaml documents every route.
web/       multi-stage Dockerfile (builds frontend → nginx) + nginx.conf.template (serves app, proxies /api).
mcp/       optional MCP server — read-only stdio bridge exposing a user's workouts/1RM/muscle
           balance to LLM clients (Claude Desktop, Cursor…). Not part of the Docker build; only
           runs when an LLM client spawns it.
catalogue/ the exercise database (5,632 exercises, text, muscle map, i18n) — generated into
           frontend/src/lib by scripts/catalogue/build.mjs. No third-party media: the fork removed
           the Gym visual/ExerciseDB pictures (ISO-1601/1603) and ships only Brilhart's own media for
           128 exercises (frontend/public/brilhart, exercises-brilhart*.js, ISO-1605/1638).
scripts/   build, CI and release helpers (scripts/README.md).
website/   static project site (plain HTML/CSS/JS), deployed separately.
kubernetes/ example manifests (docs/SELF_HOSTING_KUBERNETES.md).
docs/      guides indexed in docs/README.md (FAQ, SELF_HOSTING*, MOBILE, AI_COACH, DATA_IMPORTS, API);
           docs/dev/ holds feature design notes (SET_TYPES: drop sets/rest-pause, LIST_VIEW, COMBINE_ROUTINES).
```

## Commands

```bash
# Local stack (db + api + web, prebuilt or built from source)
cp .env.example .env
docker compose up -d --build

# Frontend dev server (hot reload), proxies /api to :3000
cd frontend && npm install && npm run dev

# Tests (Node 22, the version CI and the Dockerfiles use)
cd frontend && npm test                          # vitest run, the whole suite
cd frontend && npx vitest run src/lib/progression.test.js   # one file
cd frontend && npx vitest run -t "some test name"           # one test by name
cd api && npm test                               # node --test
cd mcp && npm test

# Checks CI runs besides the suites (run `npm ci` in the repo root once, for js-yaml)
cd frontend && node scripts/check-locales.mjs && node scripts/check-source-strings.mjs --strict
node scripts/catalogue/build.mjs --check
node scripts/build-coach-assets.mjs --check
node scripts/build-api-docs.mjs --check

# Builds
cd frontend && npm run build
cd frontend && npm run build:mobile   # + cap sync
```

There is no linter/formatter config and no TypeScript; match the existing style by hand.

GitHub (`github.com/DuarteSantos8/openGym`) is the home of the project; `.github/workflows/mirror.yml`
pushes `main` and `v*` tags to the GitLab mirror (fast-forward only, never push or merge there).
Pull requests are gated by `.github/workflows/test.yml`; `ios.yml` compiles the iPhone app on a Mac
runner. Release packages (APK, Play bundle, App Store IPA) are built and signed on the release
machine, never in CI (see "Exercise media" below and docs/APP_STORES.md).

## Architecture

### Frontend (`frontend/src`)

- **`store/useStore.js`**: a single Zustand store holding the client-side app state (`S`),
  persisted to `localStorage` (`gym_state_v1`) and debounce-pushed to the server when signed in
  (`pushState`, see `lib/api.js`). On the phones it is also mirrored to a file via `lib/mobile.js`
  (`nativeSave`), since WebView storage can be evicted. `store/useUI.js` holds ephemeral UI state
  (modals, active sheet, rest timer) separately from persisted data.
- **`lib/`**: pure, framework-free helpers, each paired with a same-directory `*.test.js`. The
  domain logic lives here, most importantly:
  - `progression.js`: the progression-rule engine (linear, Greyskull LP, double and triple
    progression, time-based). Rules implement a shared policy interface.
  - `onerm.js`: estimated 1RM from logged sets (several formulas).
  - `finish-workout.js`: reduces a completed session back into state (weights advance, PRs).
  - `recovery.js` / `recovery-view.js`: the fatigue and muscle-recovery model.
  - `workout-model.js`, `supersetFlow.js`: the in-session workout state machine.
  - `sync-merge.js`: the field-by-field merge behind the 409 retry (see "Sync" below).
  - `exercises.js` / `exercises-data.js`: the exercise library (5,632 catalogue exercises plus
    user-defined ones). `exercises-data.js`, `instr/`, `exercise-names/` and `exercise-desc/` are
    generated from `catalogue/` by `scripts/catalogue/build.mjs`; never edit them by hand.
  - `api.js`: the only place that talks to the backend (`fetch` wrapper, session flows).
  - Native bridges: `mobile.js` (the `MOBILE` flag, file persistence, notifications),
    `channel.js` (APK or store build), `watch-sync.js`, `widgets.js`, `health-sync.js`,
    `anim-quality.js` / `anim-packs.js` (animation sizes in the store apps).
  - CONTRIBUTING.md is explicit: **anything that decides what you lift next, or reads a logged
    session back, is a pure helper here with a unit test beside it.**
- **Body measurements (`lib/measurements.js`, `views/Measurements.jsx`)**: one check-in per day.
  Built-in circumferences and legacy custom fields store cm and follow the profile's cm/in
  display. Custom definitions may specify `unit: 'cm' | 'in' | '%' | 'kg' | 'lb' | 'none'`; that
  display choice stays fixed when the profile switches kg/lb. Custom values store canonical cm, kg
  (to 0.001 kg so a tenth of a pound round-trips), percent (0 to 100) or a plain number. Each
  custom reading also carries its unit, preserving its meaning in backups without definitions.
  Once values exist, the unit selector permits cm/in or kg/lb conversions within the recorded
  type; a different type needs a new field. The body CSV names a custom column with its unit,
  "Muscle ratio (%)", and the importer reads those columns back (only from our own header).
- **`views/`**: one file per screen, routed by `react-router-dom` from `App.jsx`.
- **`sheets.jsx`**: the bottom sheets (exercise picker, exercise config, workout detail, plan
  import...). It is large; a new sheet can go into `components/` as its own file.
- **`components/`**: shared UI (charts, modals, timers, media).
- **`locales/`**: one i18n pack per language, keyed by the English string (`lib/i18n.js`,
  `i18n-core.js`). A new `t()` string goes into every pack; pt-BR inherits from pt and has a
  fingerprint test (`scripts/pt-br-inheritance-fingerprint.mjs`).

### API (`api/server.js`)

Single file, no framework, plain `node:http`. Requests are dispatched through a `routes` object
keyed by `'METHOD /path'` (e.g. `routes['GET /api/health']`) matched against `req.method + ' ' +
url.pathname` — add a new endpoint by adding a key here. `DATABASE_URL` is mandatory: `db.js`
connects to PostgreSQL and applies `migrations/NNN_*.sql` before the server starts listening.
A profile's training data (`GET`/`PUT /api/data`, `GET /api/data/rev`) and `users` itself both live
in PostgreSQL (`store.js`) — `user_state.rev` is an optimistic-concurrency counter, and `PUT` is a
lock-free compare-and-set that retries against the fresh row on a lost race rather than losing a
concurrent write; `session_version` invalidates every cookie for an account at once the same way it
always did, just read from Postgres on every request now instead of an in-memory object. A login
or registration also creates a row in Postgres' `sessions` table and embeds its id as a fourth
`:`-separated field in the signed cookie/bearer payload (`uid:exp:sv:sessionId`); `POST /api/logout`
revokes that one row, so the same cookie replayed afterwards is refused — a real per-device logout,
not just clearing the cookie client-side. A payload with no fourth field (minted by a build before
this table existed, or a cookie forged directly against `secret` without a real login, as most of
the test suite still does for speed) has nothing to revoke individually and is read as valid by
`session_version` alone, exactly as before (ISO-1403, Phase 1b). A helper worth knowing before
touching auth code: `sessionStillValid(req, user, sv?)`
re-checks a session by account id and session version, not object identity — every read is its own
row now, not a live reference into a shared array, so the old `readSession(req) !== user` idiom
from before this migration can no longer tell a changed account from an unchanged one. Invite codes
also live in Postgres now (`store.js`'s `createInvite`/`consumeInvite`/etc.): registration creates
the user row and consumes the invite in one transaction (`withTransaction`), so a race between two
signups on the same code can only ever seat one of them — the other rolls back clean rather than
leaving an orphan account. `users.invited_by` still lives in the `extra` jsonb column rather than
that foreign-key column, because an invite code minted before this migration and only ever in
db.json cannot be referenced from a Postgres row at boot. `invites.used_by` deliberately carries no
foreign key (unlike `created_by`, which does): `admin/user/delete` relies on a burned code staying
burned even after the account that burned it is gone, or deleting a user would quietly free their
invite back up on an invite-only instance. Push subscriptions live in Postgres too now
(`push_subscriptions`, one row per browser/device keyed on its own unique `endpoint`); a dead or
refused endpoint is pruned with a plain `DELETE`, caught and logged rather than awaited by most
callers (the rest-timer `setTimeout`, the Coach proposal hook), so a query that fails right now
can no longer turn into an unhandled rejection that takes the process down — the row is just
pruned again next time a send to it fails. Device links (`device_links`, `device-link.js` +
`store.js`) moved too: `device-link.js` now holds only the pure code math (generating one,
hashing it) — the row itself, one per profile, is `createDeviceLink`/`findDeviceLink`/
`burnDeviceLink`/`dropDeviceLinks` in `store.js`. `burnDeviceLink` returns whether *that* call
actually deleted the row — the atomic single-use claim, same DELETE-and-check-rowCount shape as
`revokeInvite`. `POST /api/device-link/verify` burns before it creates the passkey, not after,
inside one `withTransaction`: a re-run of `findDeviceLink` right before the insert (checking the
link was still *findable*) looks equivalent but is not — two requests racing the same code can
both find it live, right up until whichever runs its own burn second, so only claiming the row
itself (not re-reading it) tells them apart. A failed `insertPasskey` (a colliding credential id)
rolls the burn back too, so a genuine failure doesn't strand the owner with no code left to retry.
Passkey credentials (`passkeys`, `passkeys-store.js` + `store.js`) are the
last db.json collection, also moved: `passkeys-store.js` holds only the pure shaping rules
(`passkeyName`, `transportsOf`, `MAX_PASSKEYS`) now, same split as `device-link.js`; the rows,
the count, and the "never lose the last way in" rule are `store.js`'s `insertPasskey`/
`listPasskeys`/`renamePasskey`/`removePasskey`/`passkeyRemovalRefused`/`touchPasskeyUse`.
`insertPasskey`'s cap check is one statement (a subquery in the INSERT's WHERE), not a separate
count-then-insert, so two additions racing the same account can't both slip past `MAX_PASSKEYS`.
Registration (both password and passkey signup) now inserts the user row, consumes the invite
*and* inserts the first passkey inside one transaction — the credential used to land in db.json as
a separate, non-atomic step after the Postgres user existed; now all three commit or none do.

With passkeys moved, `db.json` itself is retired: `server.js` no longer has a module-level `db`
object or a `saveDb()` — the "remove the global `db` variable, `saveDb()` and `stateFile()`" the
issue opened with. `db.json` is still read once, at boot (`readBootDb()`, a local variable scoped
to `listen()`), to carry over whatever an instance upgrading from before ISO-1403 still has on
disk; nothing after that boot pass reads or writes it again. The Coach (`api/coach/`) is on
PostgreSQL too now: `jobs.js`'s own `readState`/`listUserIds` (also used by `cohort.js`'s "compare
with others" and `cadence.js`'s scheduled-review tick) take `getUserState`/`getAllUsers` from
`store.js`, reached through `jobs.setPool(pool)` — a setter server.js calls once after
`connectAndMigrate`, the same idea as `setProposalHook`, since `jobs.js` (and cadence.js's own
`setInterval`, armed at import time) may already be live before any pool exists. `enqueue()`
claims its single-flight slot (`inflight`) synchronously, before its first `await`, and releases
it on any path that doesn't reach the queue: the whole function used to run to completion in one
JS tick, so two requests for the same profile arriving together were serialized for free; once
`readState` became a real query, that gap had to be closed by hand or both could pass the busy
check before either claimed it. `jobs.js`'s own per-profile job/consent/history record
(`data/coach/<uid>.json`) and the instance's own `data/coach.json` are unaffected — deliberately
still on disk, per the epic's own rule for this phase. Auth is WebAuthn passkeys
(`@simplewebauthn/server`) plus a signed session cookie (HMAC'd with a `DATA_DIR/secret` generated
on first boot) — no JWT/session-store dependency.
Optional pieces
gated by env vars: `ADMIN_UIDS` (admin dashboard), `INVITE_ONLY` (signup needs a code),
`ALLOW_GUEST` (client-only guest mode never hits the server at all), plus a rotating
`data/audit.log` (JSONL) for sign-in/admin events. Web Push (`web-push`, VAPID keys
auto-generated into `data/vapid.json`) drives rest-timer-over and day-reminder notifications.
`api/scripts/test-with-pg.sh` (`npm run test:pg`) starts an ephemeral Postgres and runs the whole
suite against it — every test that spawns `server.js` needs one now, not just the ones that used
to exercise PostgreSQL directly.

### Sync

Each profile is one document with a server revision. A device PUTs with the revision it last saw;
if another device wrote in between, the server answers 409 with the current document and the
client merges (`lib/sync-merge.js`) and retries. Every change carries its own stamp, per setting
and per field, so the newest edit of each wins and deletions stay deleted.

### Code that exists twice on purpose

The API image cannot import the frontend, so some rules are hand-copied. Change both sides
together: `lib/sync-merge.js` and `api/sync-stamps.js` (parity test), `lib/glyphs.js` and
`api/coach/core/glyphs.js` (parity test), `lib/nudge.js` and `api/nudge.js`, `lib/queue.js` and
`api/queue.js` (mirrored test cases only, nothing compares the code). The other way round,
`lib/coach-local.js` imports `api/coach/core/` directly so the phones run the same coach pipeline.

### MCP server (`mcp/src`)

Stdio MCP bridge (`@modelcontextprotocol/sdk`) that reads one user's data straight from
`DATA_DIR`. `state.js` loads and derives the data, `tools.js` defines the read tools (zod schemas),
`labels.js` maps keys to readable labels, `index.js` wires it together. The one write tool,
`log_workout` (`write-tools.js`), never writes the file: it builds the workout with
`frontend/src/lib/log-workout.js` and saves it with `PUT /api/data` over a paired-session token
(`api-client.js`, `scripts/pair.mjs`), the way a device syncs. See `mcp/README.md`.

### Passkeys and self-hosting constraints

WebAuthn passkeys are bound to an exact hostname (`RP_ID`) and require HTTPS (localhost excepted)
— this shapes a lot of the API and Settings code (`RP_ID`/`ORIGIN` env vars, guest-mode fallback
when neither is available). Read `docs/SELF_HOSTING.md` before touching auth, session, or
notification code; it documents the exact env-var contract (`RP_ID`, `ORIGIN`, `PORT`,
`WEB_PORT`, `NGINX_PORT`, `BACKEND`, `BASE_PATH`, `SESSION_DAYS`, `ADMIN_UIDS`, `FIRST_USER_ADMIN`,
`INVITE_ONLY`, `ALLOW_GUEST`, `ALLOWED_PRIVATE_IPS`, `CONTENT_SECURITY_POLICY`, `AUDIT_*`,
`VAPID_SUBJECT`) that real deployments depend on. `FIRST_USER_ADMIN=1` makes the first profile on
an empty instance its admin and owner (`claimFirstAdmin`, under an advisory lock); the owner is
the one admin who appoints and removes admins (`POST /api/admin/user/role`, `/api/admin/owner`),
recomputed into `ownerIdCache` at boot and after every route that can change it.

### Docker / deploy

`docker-compose.yml` has three services: `db` (`postgres:17-alpine`, named volume `pgdata`, no
host port published), `api` (`depends_on: db: condition: service_healthy`), `web` (multi-stage
build of `frontend/` served by nginx as the unprivileged user 101, which also proxies `/api` →
`api` — single origin, required for passkeys; the only exercise media are Brilhart's own, bundled
by Vite from `frontend/public/brilhart`). `web/nginx.conf.template` is rendered from env vars at
container start (`NGINX_PORT`, `BACKEND`, `PORT`, `BASE_PATH`, `CONTENT_SECURITY_POLICY` — the
default CSP lives in `web/Dockerfile` and names the hash of the one inline script in
`frontend/index.html`, so `src/lib/csp.test.js` fails when either changes alone), and
`40-substitute-app-url.sh` writes `APP_URL` into `index.html` at start; host/port remapping works
against prebuilt images without
a rebuild.

## Guidelines from CONTRIBUTING.md worth knowing before changing code

- **Dependency-light is a hard constraint, not a preference.** Frontend: React + Router + Zustand
  and nothing else. `api/`: three dependencies total (`@simplewebauthn/server`, `web-push`, `pg`).
  New dependencies are a hard sell either side.
- Don't commit `data/` (gitignored).
- Training-logic changes (progression, 1RM, session read-back) need a unit test in `src/lib`
  beside the code.
- User-facing text: plain and human, no em dashes. CHANGELOG.md is written at release time.
