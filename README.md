# Gift Tracker

A calm, mobile-first gift-giving tracker for keeping the people you love and the
occasions you care about in sight.

Two roles only — **admin** (Gaylon) and **manager** (Madonna). No public sign-up.

Live at **<https://gifts.gaylon.photos>**.

## Stack

- **SvelteKit 2** (TypeScript, adapter-node), runes-mode
- **better-sqlite3** with WAL — single-process, single-writer
- **argon2id** password hashing, server-side sessions, `SameSite=Lax` cookies
- **Google OAuth2** (Gmail + People API) for Contacts import and email-driven gift / package import
- **Shippo** tracking API for carrier registration + webhook checkpoints (URL-token auth, pay-as-you-go ~$0.01/registration)
- **Anthropic Opus 4.7** (optional, via `ANTHROPIC_API_KEY`) as the primary Amazon-import matcher. Heuristic ranks open gifts into a top-20 shortlist; Opus picks the right candidate per line item via structured `tool_use` output (`{matches[], unmatched_items[], confidence, safe_to_apply, summary}`). Verdicts persist on the import row and the review page renders synchronously. Shipment matching uses the same model with an abstain policy — when uncertain about which siblings shipped, the shipment record is still created but no gift advances status; admin gets a "held for review" surface in the UI
- **node-cron** in-process scheduler (env-guarded; only runs when `NODE_ENV=production AND ENABLE_CRON=true`)
- **PM2** for process management on a shared DigitalOcean droplet behind Nginx + Cloudflare (Flexible SSL)
- **Telegram + nodemailer** for daily digest delivery
- **Vitest** for unit tests (parsers + helpers)

Accessibility is a core constraint, not a polish item — Lighthouse 100/100/100/98 against `/login` in prod.

## What it does

- Gift lifecycle: `idea → planned → ordered → shipped → delivered → wrapped → given` (with `returned` as a branch)
- Per-recipient occasions (birthdays, anniversaries, custom annual + one-time) with reminder lead-times
- Skip-this-year per-iteration with reversible Undo (no archiving the link)
- Gift history per person, grouped by year — scan past Christmases to avoid duplicates
- Daily reminder digest via Telegram + email, including pending-import counts
- **Two email-import pipelines** (admin gates every commit):
  - **Amazon**: `Giftlist/Amazon/Inbox` → parses Amazon order/shipped/delivered emails → recipient match → gift create/advance. Multi-recipient orders model partial shipments via `order_shipments` so only the boxed-up siblings advance status per shipping notification.
  - **Tracking**: `Giftlist/Tracking/Inbox` → parses non-Amazon shipment confirmations (UPS / USPS / FedEx / DHL / OnTrac / Lasership / Canada Post) → either links to existing gift, routes ambiguous order# matches to a manual review queue, or creates a self-package with Shippo registration
- **Match-quality safety net** — heuristic shortlist + Opus 4.7 ranker with confidence-tiered verdicts (`high` / `medium` / `low`); admin sees AI badges + the model's reasoning inline. Shipment-decider abstains rather than guess on ambiguous shipped/delivered events. Commit-time dedup uses content fingerprints (title-only) with line_item_index as fallback, refuses to silently override a recipient mismatch, and is backed by a partial unique index on active `(order_pk, line_item_index)`
- **Exclusion keywords** (td-8360f4) — recurring non-gift Amazon items (household supplies, subscriptions) are filtered per line item by an admin-managed keyword list (`contains` / `exact`, soft-delete + restore at `/admin/exclusion-keywords`). Excluded items are dropped at scan time and hidden on the review page; a per-item "Exclude this item…" button trims the title to a recurring core in one step
- **Auto-accept** (td-dbaa0c, Wave 2) — a link-only gate auto-commits rows where *every* item is a `high`-confidence match to an existing gift (never auto-creates). Manual "Commit all high-confidence" button on the review page; an automatic-in-scan mode sits behind an admin toggle on `/admin/system` (**default OFF**). The goal: turn the daily review from "look at everything" into "glance at the few it wasn't sure about"
- **Learns from corrections** (td-4bfb59, Wave 2) — when an admin commits a gift the LLM didn't pick, the correction is logged (`matcher_corrections`) and the last 5 are fed back into the Opus prompt as few-shot examples. The same override signal (`detectOverride`) also invalidates the now-stale cache entry (Phase 4); a weekly sweep + a `/admin/system` "Clear LLM cache" button round out cache maintenance
- **Searchable recipient picker** — type-to-filter combobox on every "for who?" field (gift forms + Amazon review per-line-item pickers)
- Personal (non-gift) packages — `is_self` people scoped per-owner so manager and admin only see their own
- Soft-delete with reachable Restore button + visible archived gifts under "Past gifts" history per person, plus `/admin/system/archived` for cross-person browsing with chronological sort
- Today list keeps people surfaced until the gift is *given* (not just delivered) so wrapped-but-not-handed-over stays visible

## Local development

```bash
git clone https://github.com/gvorwaller/giftlist.git
cd giftlist
cp .env.example .env       # then edit: ADMIN_PASSWORD, MANAGER_PASSWORD, AUTH_SECRET, etc.
npm install
npm run seed               # creates admin + manager rows from .env
npm run dev                # http://localhost:5175
```

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on **port 5175** (5173/4 are taken by other projects) |
| `npm run build` | Production build via adapter-node |
| `npm run check` | Type-check + svelte-check (0 errors / 0 warnings baseline) |
| `npm test` | Vitest run (parser + helper unit tests) |
| `npm run seed` | Idempotent admin + manager upsert from `.env` |

## Deploy

Always use the script — never manual SSH + build.

```bash
./scripts/deploy-to-DO.sh             # push, snapshot, install, build, restart, health-check
./scripts/deploy-to-DO.sh --skip-push # redeploy current main without new commits
```

What the script does:
1. Local pre-flight (clean tree, on `main`, push pending commits)
2. SSH to droplet → `sqlite3 .backup` to `data/backup/pre-deploy-<utc>.db`
3. `git pull --ff-only`
4. `NODE_ENV=development npm ci` (PM2's env contaminates the inherited shell — without the override, devDeps including vite are skipped)
5. `npm run build`
6. `pm2 restart giftlist --update-env`
7. Retry `/healthz` for up to 20s; bail with logs on failure
8. Verify the public URL through Cloudflare

## Backup

```bash
./scripts/backup-sqlite.sh             # local snapshot + pull prod DB and .env
./scripts/backup-sqlite.sh --local-only
```

Outputs a complete recovery package under `data/backup/`:

| File | Contents |
|---|---|
| `data/backup/gifttracker.db` | Local dev snapshot (online `.backup`, integrity-checked) |
| `data/backup/prod/gifttracker.db` | Prod snapshot via SSH |
| `data/backup/prod/.env` | Prod secrets (`AUTH_SECRET`, OAuth, Telegram) — mode 600 |
| `data/backup/prod/PULL_OK_AT` | ISO-8601 timestamp on success |

CCC pre-flight runs this before uploading the directory to the NAS.

## Key files

| Concern | File |
|---|---|
| Schema | `migrations/*.sql` (currently at **v28**) |
| Migration runner (FK choreography) | `src/lib/server/migrate.ts` |
| Type definitions | `src/lib/server/types.ts` |
| Auth | `src/lib/server/{auth,session}.ts` |
| Job orchestration | `src/lib/server/jobs/{runner,reminders,amazon-import,tracking-import,tracking-refresh,christmas-kickoff,backup}.ts` |
| Email parsers | `src/lib/server/{amazon-parser,shipment-parser}.ts` |
| Gift / line-item matcher (Wave 1) | `src/lib/server/{gift-matcher,llm-matcher,shipment-decider}.ts` (heuristic shortlist ranker + Opus 4.7 verdict + shipment abstain policy) |
| Matcher feedback spine (Wave 2) | `src/lib/server/matcher-feedback.ts` (`detectOverride` — admin-commit-vs-LLM signal driving cache invalidation + correction logging + auto-accept gating) |
| Corrections few-shot (Wave 2) | `src/lib/server/matcher-corrections.ts` (`appendCorrection` upsert + `listRecentCorrections`), table `matcher_corrections` (mig 028) |
| Amazon exclusion keywords | `src/lib/server/exclusion-keywords.ts` (CRUD + pure `matchExcluded`), `/admin/exclusion-keywords`, table `exclusion_keywords` (mig 027) |
| Auto-accept gate + scan hook | `src/lib/server/jobs/amazon-import.ts` (`buildAutoAcceptDecisions`, `autoAcceptHighConfidenceRows`, `AUTO_ACCEPT_FLAG`) |
| App config flags (K/V) | `src/lib/server/app-state.ts` (`getBoolFlag`/`setBoolFlag` over the `app_state` table — backs the auto-accept toggle) |
| Order / shipment helpers | `src/lib/server/orders.ts` (`upsertOrderByOrderId`, `upsertShipment`, `matchSiblingsToShipment`) |
| DB test harness (Wave 1) | `src/lib/server/test-harness.ts` (tempfile SQLite + factories used by fixture corpus in `src/lib/server/jobs/amazon-import-fixtures.test.ts`) |
| Tracking provider integration | `src/lib/server/tracking.ts` (+ webhook at `/api/tracking/shippo`) |
| Gmail reader | `src/lib/server/gmail-reader.ts` |
| Notification channels | `src/lib/server/{notify,notify-email,notify-telegram}.ts` |
| Cron scheduler | `src/lib/server/scheduler.ts` |
| Audit log | `src/lib/server/audit.ts`, `/admin/audit` |
| Occasion management | `src/lib/server/occasions.ts`, `/admin/occasions` |
| Skip-iteration | `src/lib/server/occasion-skips.ts` |
| Privacy guards | `src/lib/server/people.ts` (`isPersonVisibleToUser`, `getOrCreateSelfPerson`) |
| Shared components | `src/lib/components/{PersonPicker,BottomNav,PreviewBanner,SignedInBar}.svelte` |
| PM2 config | `ecosystem.config.cjs` |
| Backup script | `scripts/backup-sqlite.sh` |
| Deploy script | `scripts/deploy-to-DO.sh` |

## Document hierarchy

When docs disagree, the higher-numbered version wins.

1. `cs.md` — debugging methodology, infrastructure rules, historical failures
2. `docs/gift-tracker-design-Claude.md` — V3 authoritative design spec
3. `docs/gift-tracker-implementation-plan-Codex.md` — phased delivery plan
4. `docs/2026-04-26_status-checkpoint.md` — most recent status snapshot
5. `docs/devlog/YYYY-MM-DD.md` — session-by-session work log

## Operational notes

- **Single instance only** — SQLite WAL is single-writer. No PM2 cluster mode.
- **Port 3001** in prod (3000 is `gaylonphotos`, also on this droplet)
- **PM2 reboot survival** — `pm2 startup systemd` + `pm2 save` already done; processes restart automatically
- **Logs**: `/var/log/pm2/giftlist-{out,error}.log`
- **Cron jobs** (env-tunable; defaults below):
  - `backup.sqlite` — `0 2 * * *` (02:00 daily, before any other job)
  - `amazon.scan` — `30 7 * * *` (07:30, before reminders so the digest sees fresh pending counts)
  - `tracking_email.scan` — `35 7 * * *` (07:35, between Amazon scan and tracking refresh)
  - `tracking.refresh` — `45 7 * * *` (07:45 — pulls Shippo status for in-flight gifts)
  - `reminders.daily` — `0 8 * * *` (08:00)
  - `amazon.cleanup_processed` — `15 3 * * 0` (03:15 Sundays — trash messages older than 180 days; also sweeps expired LLM matcher cache rows)
  - `tracking_email.cleanup_processed` — `25 3 * * 0` (03:25 Sundays)
  - `christmas.kickoff` — `0 8 1 9 *` (Sept 1 — gift-shopping kickoff)
