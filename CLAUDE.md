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

Mobile-first gift tracking web app with two roles: a gift manager (primary user) and an admin. Tracks gift purchases, shipments, and upcoming gift-giving occasions. Built with SvelteKit (TypeScript, adapter-node), SQLite (via better-sqlite3 thin wrapper), hosted on a shared DigitalOcean droplet behind Nginx + Cloudflare.

**Accessibility is a core design constraint, not a nice-to-have.** See design spec Section 11 for detailed guidelines.

Implementation follows the 6-phase plan in `docs/gift-tracker-implementation-plan-Codex.md`.

## Commands

```bash
# Dev server — runs on port 5174 (5173 is BTC Dashboard, 3000 is gaylonphotos)
npm run dev

# Production build
npm run build
node build/index.js

# Type checking + Svelte diagnostics (0 warnings baseline — fix any new warnings)
npm run check

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
SQLite database with WAL mode enabled at startup. Schema creation order per implementation plan Section 5:
1. `users` — two accounts, admin + manager roles
2. `people` — gift recipients (called "recipients" in design doc)
3. `events` — occasions (birthdays, holidays, etc.)
4. `gifts` — core entity with full status lifecycle
5. `drafts` — server-side draft persistence for unfinished gift entries
6. `audit_log` — human-readable log of all mutations
7. `job_runs` — background job execution records
8. `app_state` — app-level config/state

Deferred tables (Phase 6+): `import_runs`, `import_rows`, `aliases`, `external_tokens`

### Route Structure
```
/login
/app/today              — manager home (dashboard)
/app/people             — recipient list
/app/people/[id]        — recipient detail + gift history
/app/gifts/new          — add gift form
/app/gifts/[id]         — gift detail + status actions

/admin                  — admin control center
/admin/people           — recipient CRUD
/admin/people/[id]      — recipient edit + occasion management
/admin/imports          — CSV import (Phase 6)
/admin/settings         — notification config
/admin/audit            — activity log
/admin/system           — backup status, job history
```

Route policy: manager cannot see `/admin/*`. Admin can see both `/app/*` and `/admin/*`.

### Key Patterns
- **Status lifecycle**: `idea` -> `planned` -> `ordered` -> `shipped` -> `delivered` -> `wrapped` -> `given` (with `returned` as branch from post-`ordered`)
- **Status mutations are button-driven**, not dropdown edits — fewer invalid transitions, cleaner audit trail
- **Draft handling**: server-side `drafts` table, not browser-only localStorage — survives device switches and refreshes
- **Audit logging**: every create, update, archive, and status transition writes a human-readable record
- **Soft deletes only**: no permanent deletes in the manager view — admin can recover

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
- `DATABASE_PATH` — path to SQLite database file
- `AUTH_SECRET` — session cookie signing secret
- Notification config (Phase 4): SMTP credentials or Resend API key, Telegram bot token + chat ID
- Backup config (Phase 4): `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_REGION`, `SPACES_ENDPOINT`
