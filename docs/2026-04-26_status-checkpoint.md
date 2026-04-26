# Gift Tracker — Status Checkpoint

**Date:** 2026-04-26
**Purpose:** Durable record of what's done, what's pending, and what the
final cutover to prod looks like. Refer to this at the next session start
along with `cs.md` and `docs/gift-tracker-design-Claude.md`.

---

## What ships today (committed to `main`, ~head 05c63eb)

The manager + admin loops are functionally complete. Local dev exercises
the full flow end-to-end against a real Google account.

### Phase 0 — Scaffold ✅
- SvelteKit + adapter-node, port 5175 (5174 was in use on this box)
- better-sqlite3 12.x via `$server/db.ts` with WAL + foreign keys
- Migration runner + 8 applied migrations (schema_version=8)
- Warm-palette design tokens in `src/app.css`
- BottomNav role-aware shell

### Phase 1 — Auth + roles ✅
- Two fixed accounts (admin + manager), argon2id hashing
- Server-side sessions in DB, sliding 30-day TTL
- `SameSite=Lax` cookie (required for OAuth callbacks)
- Route guards: `/app/*` (manager+admin), `/admin/*` (admin-only)

### Phase 2a — People CRUD ✅
- People list/detail/create/edit on both manager and admin sides
- Per-person occasion management (birthday + shared holidays seeded)
- Recently-viewed tracking with 10-row cap
- Phone-book last-name sort + sort-by-upcoming-occasion default

### Phase 2b — Google OAuth ✅
- AES-256-GCM encryption at rest for refresh+access tokens
- `gmail.modify` + `contacts.readonly` + `userinfo.email` scopes
- Connect/Reconnect/Disconnect flow at `/admin/settings`
- `external_tokens` table, audit log entries

### Phase 2c — Google Contacts import ✅
- Birthday-filtered contacts via People API
- `google_resource_name` column on people for re-sync idempotency
- "Refresh birth years" backfill action

### Phase 2d — Birth year + age display ✅
- `occasions.year` column threading through to UI
- "Turns N in X days" format on birthday cards everywhere

### Phase 3 — Gifts + Drafts + Today ✅
- Gift create form with 2s-debounced server-side draft autosave
- Forward-only status lifecycle (idea→planned→ordered→shipped→delivered→wrapped→given, returned branch)
- Today screen with Next Best Action / Coming Up / Packages /
  Recently Viewed / Resume Draft sections
- Packages screen (on-the-way + arrived-waiting-to-wrap)

### Phase 4 — Amazon email parsing ✅
- Gmail label structure: `Giftlist > Amazon > {Inbox, Processed, Failed}`
- `gmail-reader.ts`, `amazon-parser.ts`, `name-matcher.ts`
- Scan staging into `import_runs` + `import_rows`
- Review UI with three-way per-row decision (Accept / Skip / Leave pending)
- Parallel `getFullMessage` (concurrency 10) + `batchModify` for label moves
- Configurable batch size (50/100/200/300/500), default 200
- Auto-refresh meta tag on scan-in-progress
- Stats breakdown (fetched / already-staged / parsed / auto-skipped / pending)

### Phase 5 — Notifications + Admin Home + scheduler ✅
- Job runner with `job_runs` lock, 5-min stale sweep
- Daily reminder digest with upcoming + packages + pending-imports
- Email (nodemailer) + Telegram (HTTP API) channels, both no-op cleanly
  when env vars absent
- Admin Home control center (Priority Action / Snapshot / Needs Review /
  Manager Context / Operations / Quick Actions)
- `/admin/system` with manual reminder trigger + job history
- `/healthz` JSON probe
- node-cron scheduler with env-tunable expressions, double-guarded by
  `NODE_ENV=production AND ENABLE_CRON=true`
- `dotenv/config` at hooks.server.ts top so prod reads `/opt/giftlist/.env`

---

## Phase 6 — Remaining work (in priority order)

### 6.1 Production deployment 🟧 **next up**

Pre-flight checklist:

| Step | Owner | Status |
|---|---|---|
| Pick subdomain | user | pending decision |
| Cloudflare DNS A record `<subdomain>` → `134.199.211.199` (proxied) | user | pending |
| Add `https://<subdomain>/admin/settings/google/callback` to Google OAuth client | user | pending |
| Generate prod `AUTH_SECRET` (`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`) | claude | pending |
| Decide prod admin/manager passwords | user | pending |
| `ssh root@134.199.211.199`, `mkdir /opt/giftlist`, clone repo | claude | pending |
| Write `/opt/giftlist/.env` with prod values | claude (paste) | pending |
| `npm ci && npm run build` | claude | pending |
| `npm run seed` with prod passwords | claude | pending |
| Nginx server block for `<subdomain>` → `127.0.0.1:3001` | claude | pending |
| `pm2 start ecosystem.config.cjs` | claude | pending |
| `pm2 save && pm2 startup systemd` (one-time, for reboot survival) | claude | pending |
| Smoke test: `/healthz`, login flow, manual reminder run | claude | pending |
| Re-connect Google account from prod URL (new redirect URI takes effect) | user | pending |
| First Amazon scan from prod | user | pending |

Operational notes:
- App lives at `/opt/giftlist`, port `3001` (gaylonphotos owns 3000)
- PM2 auto-restarts on crash; `pm2 startup systemd` + `pm2 save` makes it
  survive reboots
- Logs at `/var/log/pm2/giftlist-{out,error}.log` (PM2 timestamps each line)
- Nightly CCC backup of `data/backup/gifttracker.db` to NAS pre-flights via
  `scripts/backup-sqlite.sh`

### 6.2 Deploy automation 🟧

`scripts/deploy-to-DO.sh` is currently a skeleton. Once #6.1 is done by hand,
codify the steps:
- `git push origin main`
- `ssh root@134.199.211.199 'cd /opt/giftlist && git pull --ff-only && npm ci && npm run build && pm2 restart ecosystem.config.cjs --update-env && curl -fsS http://127.0.0.1:3001/healthz'`
- Bail on any non-zero step

### 6.3 Audit log viewer 🟧

`/admin/audit` page:
- Table of `audit_log` rows, paginated (50/page)
- Filters: actor, entity_type, action, date range
- Free-text search over `summary`
- Link from each row to the relevant entity (person/gift/etc.)
- Already-emitting writes from every mutation path; just need the read view.

### 6.4 Batch occasion assignment 🟨

On `/admin/people`:
- Checkbox column on each row (or a "Select multiple" toggle that reveals them)
- Sticky action bar: "Assign occasion to selected people" → modal with the
  shared occasions list + apply button
- Use case: bulk-assign Christmas to 30 family members in one click instead of
  per-person clicking

### 6.5 Empty / loading / error state audit 🟨

Walk every route, verify three states:
- **Empty**: list is empty (e.g., no gifts yet for a person, no people imported)
- **Loading**: Svelte's `await` blocks or transition states
- **Error**: load fn throws, action fails

Most empty states exist; loading is inconsistent (pages currently feel
instant in dev but will not be once we're on prod with real network); error
states often default to SvelteKit's generic `+error.svelte`.

Action: build a single `src/routes/+error.svelte` with warm palette + helpful
copy + return-home affordance. Audit each page for empty/error coverage.

### 6.6 Confirmation dialogs for destructive actions 🟨

Inventory:
- ✅ Admin person archive (has a confirm-then-confirm flow inline)
- ❌ Gift archive (no confirm)
- ❌ OAuth disconnect (no confirm)
- ❌ Skip-all-pending on Amazon import (no confirm — but reversible by moving
  emails back from Processed)
- ❌ Person occasion remove (no confirm)

Add a small `Modal.svelte` component, hook into the destructive paths.

### 6.7 Accessibility audit 🟨

Against design V3 §11 checklist:
- 18px minimum font size everywhere (verify with browser inspector)
- 48×48 minimum tap targets (audit buttons, links, form controls)
- WCAG AAA 7:1 contrast ratios (verify muted text especially)
- Status badges: color + text label (already done; verify nothing slipped in)
- Single primary CTA per screen
- 3-item bottom nav for manager (already done)

Tooling: run the Chrome Lighthouse accessibility audit on the prod URL
once #6.1 is up; address findings.

---

## Post-MVP items (no specific phase, "as needed")

| Item | Priority | Trigger |
|---|---|---|
| Amazon parser refinement (regex tweaks for missed cases) | medium | when real scan turns up wrong classifications |
| Notification config editing in `/admin/settings` UI (currently `.env`-only) | low | if you want to tweak lead time / channel toggles without SSH |
| Per-occasion reminder lead time override | low | not in design spec; defer |
| `/admin/system` backup verification status panel (last verify run) | low | when nightly verify cron is wired up |
| Gift edit endpoint (currently no `/app/gifts/[id]/edit`; status transitions only) | medium | first time you mistype something during entry |
| Soft-delete recovery view in admin | low | when something genuinely needs to come back |
| Multi-year occasion-year selector on gift create form | medium | if you want to plan ahead for next Christmas before this one is given |

---

## Telegram bot (one-time setup, user-driven)

Not blocking deploy — the channel no-ops cleanly without env vars. Walkthrough
in chat history but reproduced for the record:

1. Telegram → `@BotFather` → `/newbot` → name/username → save token
2. Open chat with the new bot, send any message
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` → grab the
   `chat.id` integer
4. Add to `.env` (local + prod):
   ```
   TELEGRAM_BOT_TOKEN=<token>
   TELEGRAM_CHAT_ID=<chat id>
   ```
5. Verify: `/admin/system` → "Run reminders now" → bot DMs the digest

---

## File map (where to look when something is wrong)

| Concern | File |
|---|---|
| Schema | `migrations/*.sql` |
| Type definitions | `src/lib/server/types.ts` |
| Auth | `src/lib/server/{auth,session}.ts` |
| Job orchestration | `src/lib/server/jobs/{runner,reminders,amazon-import}.ts` |
| Notification channels | `src/lib/server/{notify,notify-email,notify-telegram}.ts` |
| Cron scheduler | `src/lib/server/scheduler.ts` |
| Gmail wrapper | `src/lib/server/gmail-reader.ts` |
| Amazon parser | `src/lib/server/amazon-parser.ts` |
| Admin home aggregator | `src/lib/server/admin-home.ts` |
| Backup script | `scripts/backup-sqlite.sh` |
| Deploy (skeleton) | `scripts/deploy-to-DO.sh` |
| PM2 config | `ecosystem.config.cjs` |
| Env template | `.env.example` |

Job names that show up in `job_runs` table:
- `reminders.daily`
- `amazon.scan`
- `amazon.cleanup_processed`

---

## How to pick this up next session

1. Read `cs.md` (debugging methodology, infra rules)
2. Read `docs/gift-tracker-design-Claude.md` (V3 authoritative design)
3. Read this file (current status + Phase 6 remaining)
4. `td usage --new-session` for any active task threads
5. Pick the highest-priority Phase 6 item from §6.1–§6.7 above and go
