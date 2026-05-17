# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **DO NOT modify this file without explicitly asking the user first.**

## Session Startup (Do These First, In Order)

1. **Read `cs.md`** — hard rules on debugging methodology, infrastructure details, and historical failures. Non-negotiable.
2. **Read `docs/gift-tracker-design.md`** — the authoritative design spec. If other docs conflict, the design doc wins.
3. **Read `docs/gift-tracker-implementation-plan-Codex.md`** — phased delivery plan and schema order.
4. **Check recent devlog** — review the last few entries in `docs/devlog/` for recent decisions and work.
5. **Task management** — run `td usage --new-session` to see current work (after reading docs).

## Project Overview

Mobile-first gift tracking web app with two roles: a gift manager (primary user) and an admin. Tracks gift purchases, shipments, and upcoming gift-giving occasions. Built with SvelteKit (TypeScript, adapter-node), SQLite (via better-sqlite3 thin wrapper), hosted on a shared DigitalOcean droplet behind Nginx + Cloudflare. Live at <https://gifts.gaylon.photos>.

**Accessibility is a core design constraint, not a nice-to-have.** See design spec Section 11 for detailed guidelines.

The original 6-phase plan in `docs/gift-tracker-implementation-plan-Codex.md` is largely shipped (phases 1-6 complete; ongoing work tracked in `td` and `docs/devlog/YYYY-MM-DD.md`). Schema currently at v22.

## Commands

```bash
# Dev server — runs on port 5175 (5173 is BTC Dashboard, 5174 already taken, 3000 is gaylonphotos)
npm run dev

# Production build
npm run build
node build/index.js

# Type checking + Svelte diagnostics (0 warnings baseline — fix any new warnings)
npm run check

# Run unit tests (Vitest — parsers, helpers)
npm test

# Deploy to production (ALWAYS use this — never manual SSH + build)
./scripts/deploy-to-DO.sh

# When user requests CC session status, use this script.
# Reads Claude Code session logs — concise timeline of recent activity.
# Useful for cross-session awareness across repos.
cc-status --project ~/giftlist               # last 30 min of this project's CC activity
cc-status --all-recent                       # last 15 min across all projects
cc-status --list                             # show all projects
cc-status --minutes 60 --project ~/gaylonphotos  # last hour of gaylonphotos activity
cc-status --sessions                         # list all named relay sessions (CC1, CC2, etc.)
cc-status --session CC2                      # last 30 min of CC2's activity
cc-status --session CC2 --minutes 60         # last hour of CC2
cc-status --lines 20                         # last 20 entries

# Note: --minutes is relative to the session's last activity, not current time. Session names are case-insensitive.
```

## Architecture

### Document Hierarchy
- `docs/gift-tracker-design-Claude.md` — **authoritative design spec (V3)**. If other docs conflict, this wins.
- `docs/gift-tracker-design.md` — original V1 design (historical reference, detailed context on import pipeline, accessibility rationale)
- `docs/gift-tracker-design-Codex.md` — V2 Codex redesign (historical reference)
- `docs/gift-tracker-implementation-plan-Codex.md` — phased delivery plan (still valid, schema order updated in V3)

### Runtime Constraints
- **Single process only** — SQLite with WAL mode, single-writer. No PM2 cluster mode, no multi-instance.
- **Two users only** — one admin (Gaylon), one gift manager. No public registration.
- **Sessions** — cookie-based with argon2id password hashing.

### Data Layer
SQLite (WAL, single-writer). Migrations live in `migrations/NNN-name.sql` and run at boot via `src/lib/server/migrate.ts`. The runner toggles `PRAGMA foreign_keys = OFF` before each migration's transaction and runs `PRAGMA foreign_key_check` after commit, so migrations needing the SQLite recreate-table pattern (e.g. 014, 015) are safe.

Current schema (v22) — tables grouped by domain:

- **Identity**: `users`, `sessions`, `external_tokens` (encrypted Google OAuth)
- **Recipients**: `people` (with `is_self` + `owner_user_id` for per-user privacy on personal packages), `person_aliases`
- **Occasions**: `occasions`, `person_occasions`, `occasion_skips` (per-iteration skips, td-927a2d)
- **Gifts**: `gifts` (full lifecycle, `archived_at` td-dc1846, `shipment_id` td-d08902), `vendors`, `shippers` (USPS / UPS / FedEx / Other / DHL / OnTrac / Lasership), `shipment_events`
- **Orders**: `orders` (1:N over `gifts`, td-3e9ae2), `order_shipments` (N:1 under `orders` for partial shipments, td-d08902)
- **Drafts / history**: `drafts`, `recently_viewed`
- **Imports**: `import_runs` (`source` ∈ {`amazon_email`, `tracking_email`}), `import_rows` (`email_type` includes `tracking_only`, `order_confirmation`; `disposition` includes `review` td-3d1ee6)
- **Matcher**: `matcher_llm_cache` (Haiku verdicts on weak gift-matches, td-1d01e9)
- **Ops**: `audit_log`, `job_runs`, `app_state`

### Route Structure
```
/login
/app/today              — manager home (dashboard) — Today + Open gifts + Skipped + Recently viewed
/app/people             — recipient list (in-flight gift owners surfaced first)
/app/people/[id]        — recipient detail + active gifts + Past-gifts history (year-grouped)
/app/packages           — all in-flight gifts incl. self-packages (per-user scoped)
/app/gifts/new          — add gift form (?person= prefill supported)
/app/gifts/[id]         — gift detail + status actions + Restore (when archived)
/app/gifts/[id]/edit    — gift edit form

/admin                                       — admin control center
/admin/people, /admin/people/[id], /new      — recipient CRUD + self-person + owner picker
/admin/occasions                             — shared/custom occasion CRUD
/admin/vendors, /admin/shippers              — lookup CRUD (with archive)
/admin/imports                               — landing page (Google Contacts + Amazon + Tracking tiles)
/admin/imports/contacts                      — Google Contacts import (birthday-filtered)
/admin/imports/amazon, /amazon/review        — Amazon email scan + commit review
/admin/imports/tracking, /tracking/review    — non-Amazon shipment-email scan + commit review (td-61017c)
/admin/settings                              — Google OAuth + notification + backup config
/admin/audit                                 — paginated audit log with source-aware import links
/admin/system                                — backup status, job history, manual triggers

/api/tracking/shippo                         — Shippo webhook (URL-token auth)
/healthz                                     — liveness + schema_version
```

Route policy: manager cannot reach `/admin/*` (enforced by `src/routes/admin/+layout.server.ts`). Admin can see both `/app/*` and `/admin/*`. Admin can preview-as-manager via `?previewAsManager=1`.

### Key Patterns
- **Status lifecycle**: `idea` → `planned` → `ordered` → `shipped` → `delivered` → `wrapped` → `given` (with `returned` as branch from post-`ordered`).
- **Today list "stay until given"** (td-9a7c2e): a person stays on `/app/today` until the gift is *given* (or `returned`). Wrapped gifts sitting on the closet shelf still need attention. Open-gift filter = `{planned, ordered, shipped, delivered, wrapped}`; HANDLED = `{given, returned}` only.
- **Skip iteration** (td-927a2d): `occasion_skips (po_id, year)` PK. "No row" = "not skipped" so undo is a delete. Filtered out of today + reminders via a single Set lookup.
- **Per-user self-package privacy** (td-68804e): `people.is_self` + `people.owner_user_id` strict-equality filter; `isPersonVisibleToUser(personId, userId)` is the canonical guard for any POST that accepts a person_id from the form.
- **Status mutations are button-driven**, not dropdown edits — fewer invalid transitions, cleaner audit trail.
- **Draft handling**: server-side `drafts` table, not browser-only localStorage — survives device switches and refreshes.
- **Audit logging**: every create, update, archive, status transition, scan, and import-commit writes a human-readable record. `entityType: 'import'` rows link source-aware to `/admin/imports/{amazon,tracking}/review`.
- **Soft deletes only**: no permanent deletes in the manager view; archive toggles `is_archived`. Past-gifts section on `/app/people/[id]` surfaces archived rows so admin can navigate in and Restore via the gift detail page.
- **Shippo registration mutex**: `tracking.ts` keeps a per-process `Map<giftId, Promise>` so concurrent calls (admin double-click, importer racing manual refresh) share one POST instead of double-billing $0.01.

## CSS Rules

**No Tailwind. No utility frameworks.** Hand-written component-scoped CSS using SvelteKit `<style>` blocks.

### Design Tokens (from Codex mockups)
The visual direction is warm, domestic, and calm — not clinical. Reference: `docs/gift-tracker-mockup-Codex.html` and associated Codex mockup files.

- **Backgrounds**: cream `#f5f1e8` (page), paper `#fffdf8` (cards)
- **Text**: ink `#1f2a24`, muted `#3d4a3f` (darkened from mockup `#5e675f` to meet AAA)
- **Primary**: evergreen `#2f5d50`, soft green `#e6efe9`
- **Attention**: amber `#bd7a2a`, soft amber `#fff2df`
- **Danger**: rose `#a54d43`
- **Borders**: warm line `#ddd2c2`
- **Shadows**: `0 6px 20px rgba(47, 35, 18, 0.08)`
- **Radius**: `18px` for cards, `14px` for buttons/inputs, `999px` for badges/pills
- **Fonts**: Georgia / "Times New Roman" for headings (serif warmth), "Avenir Next" / "Segoe UI" / system-ui for body (legibility)
- Class naming: `.component-name` pattern (`.today-card`, `.gift-detail`, `.people-list`)
- Destructive actions: modal confirmation dialogs, never toast notifications

### Accessibility Requirements
- Base font size: 18px minimum, key info (names, dates, statuses) at 20-24px
- **WCAG AAA contrast ratios (7:1) for all text** — including muted/secondary text
- Minimum 48x48px tap targets with generous spacing
- Color + text label for all status badges — never color alone
- Consistent layout: sticky header -> main content -> action buttons at bottom
- Bottom nav: 3 items max for manager (Today / People / Packages)

## Environment Variables

Required in `.env`:
- `DATABASE_PATH` — path to SQLite database file (defaults to `./data/gifttracker.db`)
- `AUTH_SECRET` — session cookie signing secret + AES-GCM key for encrypted external_tokens
- `BASE_URL` — public URL for outbound digest links (defaults to `http://localhost:5175` in dev)
- `ADMIN_PASSWORD`, `MANAGER_PASSWORD` — used by `npm run seed` only

OAuth (Google) — set up via `/admin/settings`:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`

Tracking (Shippo):
- `SHIPPO_API_KEY` — live or test key
- `SHIPPO_WEBHOOK_SECRET` — URL-token validated against `?token=` on the webhook route

Notifications:
- SMTP credentials (host, port, user, pass) or Resend API key
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Backup:
- `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_REGION`, `SPACES_ENDPOINT`

Cron tunables (any/all optional, defaults in `src/lib/server/scheduler.ts`):
- `REMINDER_CRON`, `AMAZON_SCAN_CRON`, `TRACKING_REFRESH_CRON`, `AMAZON_CLEANUP_CRON`, `TRACKING_EMAIL_SCAN_CRON`, `TRACKING_EMAIL_CLEANUP_CRON`, `BACKUP_CRON`, `CHRISTMAS_KICKOFF_CRON`
- `ENABLE_CRON=true` — required (along with `NODE_ENV=production`) for the scheduler to register at boot

`REMINDER_LEAD_DAYS` — global default lead time (21d) for the reminder digest. Per-occasion override via `occasions.reminder_days`.
