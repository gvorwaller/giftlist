# td-0bfdf8 — True Multiuser: Households (Caleb's family gets their own space)

> **Status: DRAFT — for Gaylon's review, 2026-07-19. Not approved; no work started.**
> Everything here is open to revision, including the "user-confirmed decisions" below (those captured quick Q&A answers during planning and may not reflect what you actually want on reflection). Comment inline or strike sections — the scope can be cut substantially (e.g., skipping support view, the users UI, or per-household jobs) if the full effort isn't worth it.

## Context

The app today serves one household: Gaylon (admin) + wife (manager), two fixed accounts, all gift data shared between them. Goal: add a second, fully isolated **household** — son Caleb as its `admin`, his wife as its `manager` — while Gaylon becomes **app owner** (super-admin): the only person who manages users/passwords/access, with an audit-logged "support view" to enter Caleb's space when helping.

**User-confirmed decisions:**
- Households share data internally (Caleb + wife see the same people/gifts), isolated from household 1.
- Gaylon: user management + can enter Caleb's space (fully visible in Caleb's audit log).
- Caleb's v1 features: manual gift entry + all `/app` views, Shippo tracking (shared `SHIPPO_API_KEY`), **Google Contacts import via Caleb's own Gmail** (he connects his own OAuth). NO Amazon/tracking-email import (stays Gaylon-only — they barely use Amazon). NO reminders for them in v1 — but the digest must be household-scoped so Caleb's data never appears in Gaylon's digest.
- Passwords: only Gaylon sets/resets (new UI). No self-service.
- **Occasions: per-household copies** (no shared global holiday rows). New households get the standard holiday set seeded.
- Caleb's `/admin` is **trimmed**: only People, Occasions, Vendors, Contacts import, Settings (Google connect). Owner-only tiles hidden.

**Key existing facts (verified):**
- `users` (mig 001): `role CHECK IN ('manager','admin'))`, no household/tenant column anywhere. Sessions server-side; `hooks.server.ts:29-58` populates `locals.user`. argon2id in `src/lib/server/auth.ts`; `destroyAllSessionsForUser` in `session.ts:127`.
- No user-management UI exists; passwords only via `scripts/seed-users.ts`.
- `external_tokens` is already per-user (`UNIQUE(user_id, provider)`), and contacts import already uses `locals.user.id` → Caleb's contacts import works once he can reach the connect flow. Google client creds (env) are shared app-wide — fine.
- `people.owner_user_id`/`is_self` (migs 012/013) is a *self-package privacy* flag only, NOT a tenancy column (NULL for normal recipients).
- ~110–120 query sites across the repo layer (`people.ts`, `gifts.ts`, `occasions.ts`, `today.ts`, `orders.ts`, `tracking.ts`, …) touch per-household tables. Direct-SQL routes bypassing repos: amazon/tracking review pages (~36 sites, owner-only feature → gate, don't scope), `admin/system/archived`, `admin/audit`, `app/packages`.
- Single-tenant chokepoints: `getAdminUserId()` (scheduler.ts:41-47 + duplicated in the Shippo webhook), `findManagerUser()` (auth.ts:50-64, used by preview-as-manager), env-global notification targets (`TELEGRAM_CHAT_ID`, `SMTP_TO`), global digest queries in `jobs/reminders.ts` + `christmas-kickoff.ts`.
- No UNIQUE on `occasions.title` — per-household holiday copies need no constraint re-keying. `vendors` has `UNIQUE(name COLLATE NOCASE)` → must become `(household_id, name)`.

## Design

### Tenancy model
- New `households` table; `household_id` FK on: `users`, `people` (both NOT NULL via recreate-table), `occasions` (NOT NULL semantics, backfilled), `vendors`, `orders`, `audit_log` (nullable column + backfill, NOT NULL enforced in app code — **no `DEFAULT 1`**: a forgotten household_id must surface as NULL, not silently land in household 1).
- **Gifts do NOT get `household_id`** — every gift query is person-anchored, already joins `people`, or is intentionally global (Shippo poll/webhook by tracking number). Scope through `people` joins; a denormalized column would add a write-side invariant (`updateGift` can change `person_id`) for near-zero benefit. Same for `person_occasions`, `occasion_skips`, `person_aliases`, `shipment_events`, `order_shipments` — scoped through their parent.
- Stay global: `shippers` (seeded carriers; CRUD becomes owner-only), `exclusion_keywords` (feeds Gaylon-only Amazon pipeline; gate the page owner-only instead of scoping), `app_state`, `job_runs`, `matcher_llm_cache`, `sessions`, `external_tokens`, `import_runs`/`import_rows` (owner pipeline; scope derivable via `actor_user_id`). Per-user as-is: `drafts`, `recently_viewed`.

### Roles
Keep `role IN ('manager','admin')` untouched (dozens of `role !== 'admin'` checks stay valid; Caleb is a normal admin). Add `users.is_app_owner INTEGER NOT NULL DEFAULT 0` + `users.is_disabled INTEGER NOT NULL DEFAULT 0` (checked at login + `validateSession`). Owner-only = `requireOwner` guard.

### Guards & scope threading (new `src/lib/server/guards.ts`)
```ts
interface Scope { householdId: number; userId: number }  // householdId = locals.activeHouseholdId
requireUser(locals)   // redirect /login or 401 for /api
requireAdmin(locals)  // + role==='admin' else 403
requireOwner(locals)  // + is_app_owner===1 else 403
scopeFrom(locals): Scope
```
Repo functions take `Scope`/`householdId` as an **explicit parameter** — change signatures and let `npm run check` enumerate every call site (the mechanical engine of the refactor). New canonical scoped getters used by every action that accepts an id from a form/URL (IDOR defense):
- `getPersonScoped(id, scope)` — `household_id = ?` + existing self-owner rule (absorbs `isPersonVisibleToUser`, people.ts:190).
- `getGiftScoped(id, scope)` — join people. Replaces bare `getGiftById` in all routes.
- `getOccasionScoped`, and po/skip/order/vendor equivalents.

### Support view & preview
- `giftlist_household` cookie (httpOnly, Lax, 8h — same pattern as `giftlist_preview`). hooks.server.ts: `locals.activeHouseholdId = user.household_id`, overridden by cookie only when `is_app_owner`; `locals.supportView = activeHouseholdId !== user.household_id`.
- `POST /api/support-view/start|stop` (requireOwner) — audit-logged with the **target** household (Caleb sees "Gaylon entered support view" — confirmed desired).
- Persistent banner in `/app` + `/admin` layouts during support view (AAA contrast, 48px exit target, not a toast).
- `findManagerUser()` → `findManagerUser(householdId)`; preview-as-manager composes with support view (owner in household 2 + preview = Caleb's wife's view).
- Suppress `recordLastSeen` + `recently_viewed` writes while in support view (otherwise cross-household leakage into Today strips).
- Mutations in support view: `scope.userId` stays Gaylon (audit truth), `scope.householdId` = target (data lands correctly).

### Occasions (per-household copies — user's choice)
- Migration backfills ALL existing occasion rows (holidays + birthdays + customs) to household 1.
- `seedHouseholdOccasions(householdId)` — TS helper replicating the mig-003 holiday set — called by `createHousehold`. All occasion queries filter `household_id = ?` (no NULL-global special case).
- Christmas-kickoff job finds each household's own Christmas row.

### Jobs & notifications
- `households` gets `notify_email`, `telegram_chat_id`, `reminder_lead_days` (nullable). Household 1 falls back to env (`SMTP_TO`/`TELEGRAM_CHAT_ID`/`REMINDER_LEAD_DAYS`) — zero prod config change. Household with no channels configured → digest query never runs (structurally no leak; satisfies "no reminders for Caleb v1").
- `runReminderJob` + `christmas-kickoff` iterate households; `collectUpcoming/collectPackages` take householdId; `collectPendingImports` becomes owner-household-only.
- `getAdminUserId()` → single exported `getAppOwnerUserId()` (`WHERE is_app_owner = 1 LIMIT 1`), used by Amazon/tracking scans + Shippo webhook actor. `tracking.refresh` stays a global poll (shared Shippo account by design; webhook resolves by unique tracking number).
- **Matcher leak fix (must land with Phase 1, not Phase 4):** `gift-matcher.ts:78-79` / `name-matcher.ts` / contacts-import candidate selection queries people globally — the moment household 2 has people, Gaylon's Amazon scan could match onto Caleb's recipients. Scope candidates to the actor's household.

## Implementation Phases (each independently deployable; live prod app)

### Phase 0 — Guards + owner-gating (no schema change) · ~0.5–1 day
- Add `guards.ts` (`requireUser`/`requireAdmin`; `requireOwner` temporarily = first admin).
- Replace inline role checks in admin actions/endpoints; consolidate the duplicated `getAdminUserId()` (scheduler.ts + `api/tracking/shippo/+server.ts:83-91`) into one export.
- Gate owner-only routes NOW (no-op while Gaylon is the only admin): `/admin/imports/amazon*`, `/admin/imports/tracking*`, `/admin/exclusion-keywords`, `/admin/system`, `/admin/shippers` mutations, `/admin/vendors` stays all-admin.
- Verify: `npm run check` 0 warnings, `npm test`, admin click-through. Deploy.

### Phase 1 — Migration 029 + full data-plane scoping (the big one) · ~3–5 days
**`migrations/029-households.sql`:**
1. `CREATE TABLE households (id, name UNIQUE, notify_email, telegram_chat_id, reminder_lead_days, created_at, updated_at)`; insert household 1 (name per Gaylon).
2. Recreate `users` (12-step, FK-off window already supported by migrate.ts): + `household_id NOT NULL REFERENCES households ON DELETE RESTRICT`, `is_app_owner`, `is_disabled`; backfill household 1; set `is_app_owner=1` for first admin.
3. Recreate `people`: + `household_id NOT NULL`; backfill 1; google-resource unique index becomes `(household_id, google_resource_name)`; add `idx_people_household`.
4. `occasions` + `household_id` (ADD COLUMN, backfill ALL rows to 1).
5. `vendors` + `household_id`, backfill 1; drop `idx_vendors_name_nocase`, create `UNIQUE (household_id, name COLLATE NOCASE)`.
6. `orders` + `household_id`, backfill 1, index.
7. `audit_log` + `household_id`, backfill 1, index `(household_id, created_at DESC)`.

Test against a **copy of the prod DB** locally before deploying; manual DB backup before the prod deploy.

**Code:**
- `types.ts` (Household, User/Person/Occasion/Vendor/Order household fields); `auth.ts`/`session.ts` SELECT lists; `app.d.ts` Locals `{ user, previewAsManager, activeHouseholdId, supportView }`; hooks.server.ts sets `activeHouseholdId = user.household_id` (no switch cookie yet).
- Thread Scope through repos in dependency order: `people.ts` → `occasions.ts` → `gifts.ts` → `today.ts` (joins at ~L93/283 + recently_viewed EXISTS subqueries) → `occasion-skips.ts` → `tracking.ts` (L413 viewer filter; keep L403/473 global) → `orders.ts`, `gift-status.ts`, `vendors.ts`, `admin-home.ts`, `contacts-import.ts`, `gift-matcher.ts`/`name-matcher.ts` (**candidate scoping — the leak**), `audit.ts` (`logAudit` gains householdId; `listAuditLog` filter).
- Shared direct-SQL routes get predicates: `app/packages/+page.server.ts`, `admin/system/archived` (owner-gated anyway but scope it), `admin/audit`. Owner-gated import-review routes stay unscoped (defense at the door).
- Jobs temporarily pinned to owner's household with greppable `// td-0bfdf8 Phase 4` markers.
- **Tests:** extend `test-harness.ts` (`seedHousehold`, household params); new `scoping.test.ts` — the cross-household probe: seed households A/B with person/occasion/gift/vendor/skip/audit each; assert every list function, Today load, digest collector, and matcher candidate set for A returns zero B ids; scoped getters with B's ids return undefined.
- Deploy; prod behaves identically (all data = household 1); `/healthz` shows v29.

### Phase 2 — Owner marker live + `/admin/users` UI · ~1.5–2 days
- `requireOwner` switches to `is_app_owner`. `findManagerUser(householdId)`; preview endpoints + `app/+layout.server.ts` pass scope.
- New `src/lib/server/users.ts`: `createHousehold` (+ `seedHouseholdOccasions`), `createUser`, `renameUser`, `setRole`, `resetPassword` (hashPassword + `destroyAllSessionsForUser`), `setDisabled` — all audit-logged with target household.
- New routes `/admin/users` (owner-only, tile visible only to owner): list users grouped by household; create household; create user (username/display/role/household/password). `/admin/users/[id]`: rename, reset password (modal confirm), disable. Household notification fields (email/telegram/lead-days) editable on the household section here.
- Trimmed admin home: non-owner admins see only People / Occasions / Vendors / Contacts import / Settings tiles; ops panels (backup/jobs/manager-context) owner-only. `/admin/settings` for Caleb shows only the Google connect section.
- Login: `is_disabled` rejected; landing unchanged (admin→/admin, manager→/app/today).
- Verify in prod with a throwaway test household + user: log in, confirm empty space, run probe checklist, disable test user.

### Phase 3 — Support view + audit visibility · ~1 day
- Cookie + hooks logic, `/api/support-view/start|stop`, banners in both layouts, household switcher on admin home (owner only).
- `/admin/audit`: non-owner sees own household only; owner gets household filter dropdown incl. "All"; actor filter options household-aware.
- Suppress recordLastSeen/recently_viewed during support view.

### Phase 4 — Per-household jobs & notifications · ~1–2 days
- `notify.ts` takes per-household channel config (`getHouseholdNotifyConfig`, env fallback for household 1); reminders + christmas-kickoff iterate households, skip unconfigured; `job_runs` summary lists per-household results; digest preview on `/admin/system` gains household param.
- `getAppOwnerUserId()` for Gmail scan jobs + webhook actor.
- Remove the Phase-1 `// td-0bfdf8 Phase 4` pins.

### Phase 5 — Caleb onboarding · ~0.5 day
Everything deployed + verified with only household 1 populated → manual DB backup → create Caleb's household via UI (no notification config) → create caleb (admin) + wife (manager), Gaylon sets passwords → Caleb logs in, connects his Google account at `/admin/settings`, runs Contacts import → run probe checklist from BOTH sides (Caleb sees nothing of household 1; Gaylon's digest/Today unchanged) → done.

## Verification

- `npm run check` (0-warning baseline) + `npm test` after every phase; `./scripts/deploy-to-DO.sh` per phase.
- `scoping.test.ts` cross-household probe runs in vitest forever.
- Manual prod probe checklist (Phase 2 test user + Phase 5 Caleb): empty Today/People/Packages; gift-form person/occasion/vendor pickers show nothing of household 1; direct URL probes `/app/people/<h1-id>`, `/app/gifts/<h1-id>` → 404/403; form-POST a household-1 `person_id` → rejected; `/admin/audit` clean; `/admin/imports/amazon` → 403; Gaylon's digest contains no Caleb names.
- Reminder dry-run preview per household from `/admin/system` before enabling anything for household 2.

## Option B — Second deployment (separate instance for Caleb) · ~1 day

**Gaylon's preferred direction as of 2026-07-19 review.** Instead of multi-tenanting the codebase, run a second copy of the same app on the shared droplet: own subdomain, own SQLite file, own PM2 process. Near-zero code change; isolation is total by construction.

**Verified feasibility (checked 2026-07-19):**
- Droplet: 4 GB RAM, ~1.5 GB available, giftlist uses 224 MB — a second instance fits easily. Disk 55% used.
- Shippo webhook handler already replies `{ok, note: 'Unknown tracking; ignored'}` for unrecognized tracking numbers (`api/tracking/shippo/+server.ts:60`) — both instances can be registered as webhook endpoints on the one Shippo account; each ignores the other's events. Polling fallback (`tracking.refresh` cron) also works per instance.
- Backup job is local-file only (`jobs/backup.ts` — no Spaces upload in code), so no shared-bucket conflict.
- Contacts import + Google connect already key off `locals.user.id`; the same GCP OAuth client works for both instances by adding Caleb's redirect URI in the Google console and setting his instance's `GOOGLE_REDIRECT_URI`.

**The "over-arching admin" requirement:** the schema supports N users; Gaylon simply gets a *third* account on Caleb's instance (role `admin`). His actions there are attributed to his username in Caleb's audit log — the support-transparency goal falls out for free. One ordering caveat: `getAdminUserId()` (scheduler + webhook) picks the **first admin by id**, so seed **Caleb's admin account first**, then his wife (manager), then Gaylon's support-admin account.

**Work items:**
1. `scripts/seed-users.ts`: add an optional third spec (e.g., `SUPPORT_*` env prefix, role admin, skipped when unset). ~20 lines.
2. `scripts/deploy-to-DO.sh`: parameterize APP_DIR / PM2_APP / port / URLs (`--target caleb` flag or a config block per instance); default deploys both so the two never drift.
3. Droplet provisioning (one-time): `/opt/giftlist-caleb` checkout, own `.env` (`DATABASE_PATH`, **distinct `AUTH_SECRET`**, `PORT=3002`, `BASE_URL`, `SHIPPO_API_KEY` + own `SHIPPO_WEBHOOK_SECRET`; NO SMTP/Telegram → notifications structurally off), PM2 app `giftlist-caleb`, Nginx server block, Cloudflare DNS for the new subdomain (Caleb picks the name).
4. Google console: add Caleb's callback URL to the shared OAuth client.
5. Shippo dashboard: register second webhook URL with Caleb's token.
6. Seed the three accounts; smoke test; done.

**Trade-offs vs. Option A (households):**
- No in-app user management — passwords still set via `npm run seed` per instance (acceptable: only Gaylon touches the server anyway).
- Two deploys per release (mitigated by the deploy-both script); migrations self-apply per instance at boot.
- Two DBs to back up (the per-instance backup cron handles it).
- If a *third* family ever joins, this pattern scales linearly (another instance) whereas Option A would amortize — but Option A's ~8–11.5 days only pays off at a scale this app may never reach.
- Cron caveat: `ENABLE_CRON=true` on Caleb's instance enables all jobs; Amazon/tracking-email scans no-op harmlessly without Gmail labels, reminders no-op without notify channels. Nothing to disable.

## Risks / notes
- Biggest leak surfaces, ranked: global digest queries (fixed by per-household iteration + skip-unconfigured), matcher candidate selection (fixed Phase 1), IDOR via posted ids (scoped getters), today.ts joins, direct-SQL admin routes (owner-gated).
- SQLite: FK columns via ADD COLUMN must be nullable — hence recreate-table for `users`/`people` (tiny tables) and app-enforced NOT NULL elsewhere; migrate.ts already supports the FK-off recreate pattern.
- Shippo stays one shared account: cross-household webhook events land by unique tracking number — correct by design; Gaylon absorbs ~$0.01/registration.
- Vendors: Caleb starts with an empty vendor list (intentional).
- Effort: ~8–11.5 working days total across 6 deploys.
