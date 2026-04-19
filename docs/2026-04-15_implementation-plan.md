# Gift Tracker — Implementation Plan

**Date:** 2026-04-15
**Status:** Approved
**Design Spec:** `docs/gift-tracker-design-Claude.md` (V3, authoritative)

## Context

Gift Tracker is a mobile-first web app for a gift manager and an admin. No code exists yet — this is greenfield. The authoritative V3 design spec is complete at `docs/gift-tracker-design-Claude.md`. The referenced implementation plan file (`docs/gift-tracker-implementation-plan-Codex.md`) does not exist and needs to be created.

Two #GBV scope changes promote features from "Not MVP" to Phase 1:
1. **Google Contacts import** — populate `people` table from gaylon@vorwaller.net contacts
2. **Amazon email parsing** — extract gift details from Amazon order emails in a Gmail folder

Both require Google OAuth2 infrastructure (Gmail API + People/Contacts API).

---

## Technical Decisions

### Data layer: better-sqlite3 + thin typed wrapper (confirmed)
- 10 tables, 2 users, low traffic — ORM abstraction tax exceeds benefit
- One `db.ts` file with WAL mode + typed helper functions (`getPersonById(id): Person | undefined`)
- Numbered SQL migration files (`migrations/001-initial-schema.sql`) with a simple runner tracking version in `app_state`
- Type safety via TypeScript interfaces, not ORM schema definitions

### Google auth: User OAuth2 with offline refresh token
- Gmail API requires user consent — service accounts can't read a personal inbox without Workspace domain delegation
- Admin clicks "Connect Google Account" once in `/admin/settings` → OAuth2 flow → refresh token stored encrypted in `external_tokens` table
- Scopes: `contacts.readonly` + `gmail.readonly` (both read-only)
- Google Cloud project stays in "Testing" mode (1 test user, no verification needed)

### Amazon email parsing: On-demand admin scan with folder lifecycle (confirmed)
- Gmail forwarding rule routes Amazon emails to a labeled folder (e.g., `Amazon-Gifts`)
- Admin clicks "Scan Amazon Emails" → system reads that Gmail label → parses emails → shows review screen
- Parser identifies: gift order confirmations, shipping notifications, delivery confirmations
- After scanning, processed emails are moved to a sub-label (e.g., `Amazon-Gifts/Processed`)
- Admin can trigger a purge of the processed sub-label
- Parser format is a **placeholder until build time** — will iterate on real email samples then
- Never auto-creates gifts without admin review

### Name matching: Exact first, Levenshtein fallback, aliases for persistence
- Exact match on `full_name` → `display_name` → `person_aliases.alias_name`
- Fuzzy match via Levenshtein (threshold 3) as fallback
- When admin manually assigns an unmatched name, store in `person_aliases` for future auto-matching

---

## Phase Breakdown

### Phase 0: Project Scaffold
**Goal:** Running SvelteKit dev server with database, before any features.

1. Init git repo + `.gitignore`
2. `npm create svelte@latest` — TypeScript, adapter-node, port 5174
3. Install: `better-sqlite3`, `@types/better-sqlite3`, `argon2`
4. `src/lib/server/db.ts` — connection with WAL + foreign keys
5. Migration runner + `migrations/001-initial-schema.sql` (all 10 core tables per Section 15)
6. `src/lib/server/types.ts` — TypeScript interfaces for all rows
7. `src/hooks.server.ts` skeleton
8. `src/app.css` — global design tokens (warm palette, fonts, spacing)
9. `src/lib/components/BottomNav.svelte` shell
10. `scripts/deploy-to-DO.sh` skeleton + `ecosystem.config.cjs`

**Verify:** `npm run dev` serves a page, DB file created with tables, `npm run check` clean.

**Key files:** `src/lib/server/db.ts`, `migrations/001-initial-schema.sql`, `svelte.config.js`, `src/app.css`

---

### Phase 1: Authentication and Roles
**Goal:** Two accounts can log in, sessions persist, route guards enforce role separation.

1. Seed script (`scripts/seed-users.ts`) — creates admin + manager with argon2id hashes
2. `/login` — form with large inputs (48px targets), warm styling
3. `src/hooks.server.ts` — cookie-based session validation, attach `event.locals.user`
4. `src/lib/server/session.ts` — create/validate/destroy sessions. Cookies: HttpOnly, Secure, SameSite=Strict
5. Route guards: `/app/*` requires manager or admin, `/admin/*` requires admin only
6. Logout endpoint: `POST /api/logout`
7. Role-based redirects: manager → `/app/today`, admin → `/admin`
8. Update `users.last_login_at` on login

**Verify:** Both users can log in. Manager blocked from `/admin/*`. Cookie persists.

---

### Phase 2: People + Google Contacts Import
**Goal:** People table populated via Google Contacts and/or manual entry. Both roles can browse people.

Contacts import is the natural way to initially populate `people` — building manual entry first then immediately replacing it with import wastes effort.

*Google OAuth infrastructure (shared with Phase 4):*
1. Google Cloud project setup (People API + Gmail API enabled, OAuth consent screen)
2. `external_tokens` table added via `migrations/002-external-tokens.sql`
3. `src/lib/server/google-auth.ts` — OAuth2 helpers
4. `/admin/settings/google/connect` + `/callback` routes

*Contacts import (confirmed: birthday-filtered):*
5. `src/lib/server/contacts-import.ts` — fetch contacts from Google People API, **filter to only contacts with a valid birthday date**, map to `people` fields (display_name, full_name, address), deduplicate by full_name
6. Auto-create `person_occasions` entries: each imported contact gets a Birthday occasion linked with the correct month/day from their Google Contact birthday field
7. `/admin/imports/contacts` — preview + confirm UI showing filtered contacts with their birthdays
8. Support re-sync: compare existing people against contacts, surface new contacts with birthdays, don't overwrite manual edits
9. `migrations/002-seed-occasions.sql` — seed standard occasions (Birthday, Christmas, etc.)

*People views:*
10. `/app/people` (manager) — large list sorted by upcoming occasion, search
11. `/app/people/[id]` (manager) — person detail with next occasion, last gift, "Add Gift" button
12. `/admin/people` — admin people list with search, add person, needs-cleanup section
13. `/admin/people/[id]` — admin person edit with occasion management
14. `/admin/people/new` — manual person creation
15. Record `recently_viewed` on person detail load

**Key files:** `src/lib/server/google-auth.ts`, `src/lib/server/contacts-import.ts`, `src/routes/app/people/`

---

### Phase 3: Gifts, Drafts, Today Screen
**Goal:** Manager can create/track gifts, see actionable Today screen. Drafts auto-save.

*Gift CRUD:*
1. `/app/gifts/new` — creation form (Who, What, Where + collapsed More Details)
2. Server-side draft save: debounced 2s POST to `/api/drafts`, one active draft per user
3. Draft recovery: pre-populate form from draft < 7 days old
4. Gift creation writes audit log, deletes draft

*Gift detail + status:*
5. `/app/gifts/[id]` — detail page with forward-only status buttons
6. `src/lib/server/gift-status.ts` — transition logic (idea→planned→ordered→shipped→delivered→wrapped→given, returned branches post-ordered)
7. Record `recently_viewed` on gift detail load

*Today screen:*
8. `/app/today` — the emotional center:
   - Next Best Action (nearest occasion without a handled gift)
   - Coming Up Soon (2-5 upcoming occasions)
   - Packages On The Way (shipped gifts with tracking)
   - Recently Viewed (last 2-3 items)
   - Resume Last Task (draft < 7 days)
   - Empty state: "Everything that matters right now is handled."

*Packages:*
9. `/app/packages` — gifts with status ordered/shipped/delivered

*Middleware:*
10. Update `last_seen_at` + `last_seen_path` on every page load

**Key files:** `src/routes/app/gifts/`, `src/lib/server/gift-status.ts`, `src/routes/app/today/`

---

### Phase 4: Amazon Email Parsing
**Goal:** Admin can scan Amazon emails, parse gift details, match recipients, create gifts through review workflow.

*Schema:*
1. `migrations/003-import-tables.sql` — `import_runs`, `import_rows`, `person_aliases`

*Gmail + parsing:*
2. `src/lib/server/gmail-reader.ts` — fetch from designated Gmail label (e.g., `Amazon-Gifts`)
3. `src/lib/server/amazon-parser.ts` — **placeholder module** with interface defined; real parsing logic built iteratively against sample emails at build time. Extracts: item title, order ID, price, tracking, email type (order/shipped/delivered), recipient from gift comments.
4. `src/lib/server/name-matcher.ts` — exact → alias → fuzzy matching pipeline

*Email lifecycle:*
5. After scanning, move processed emails from source label to sub-label (e.g., `Amazon-Gifts/Processed`)
6. Admin-initiated purge of processed sub-label emails

*Admin UI:*
7. `/admin/imports/amazon` — "Scan Amazon Emails" button, last scan timestamp, count of processed emails in archive
8. `/admin/imports/amazon/review` — review screen with match/assign/skip per row, "Purge Processed" button
9. Alias learning: "Save this name as alias for [person]?" on manual assignment
10. Duplicate detection by `order_id`
11. Group related emails (order → shipped → delivered) by order ID into a single gift timeline

**Key files:** `src/lib/server/amazon-parser.ts`, `src/lib/server/name-matcher.ts`, `src/routes/admin/imports/amazon/`

---

### Phase 5: Notifications, Jobs, Admin Home
**Goal:** Daily reminder digests, admin control center, system observability.

1. `src/lib/server/reminder-job.ts` — query upcoming occasions, compose digest
2. `src/lib/server/notify-email.ts` + `notify-telegram.ts` — delivery channels
3. `src/lib/server/job-runner.ts` — lock-based executor, logs to `job_runs`
4. Three cron jobs: daily reminders, nightly backup to Spaces, weekly backup verification
5. `/admin` — control center (Priority Action, System Snapshot, Needs Review, Manager Context, Operations, Quick Actions)
6. `/admin/settings` — notification config (email, Telegram, reminder lead time)
7. `/healthz` endpoint
8. `/admin/system` — backup status, job history

---

### Phase 6: Audit Log, Polish, Deploy
**Goal:** Complete admin tools, polish UX, ship to production.

1. `/admin/audit` — filterable audit log viewer
2. Batch occasion assignment on admin people list
3. Empty/loading/error states for all screens
4. Confirmation dialogs for destructive actions
5. Complete `scripts/deploy-to-DO.sh` — push, pull, install, build, PM2 restart, health check
6. Nginx server block + Cloudflare DNS
7. Accessibility audit: tap targets, contrast, status badges, language, navigation

---

## Phase Dependencies

```
Phase 0 (Scaffold)
    ↓
Phase 1 (Auth)
    ↓
Phase 2 (People + Google Contacts)
    ↓
Phase 3 (Gifts + Drafts + Today)
   ↙     ↘
Phase 4    Phase 5
(Amazon)   (Notifications + Admin Home)
   ↘     ↙
Phase 6 (Audit + Polish + Deploy)
```

Phases 4 and 5 are independent — can be built in either order or in parallel.

---

## Responsive Strategy

**Manager screens**: Stay single-column on all screen sizes. Tablet width (768px+) means more breathing room — larger fonts, more whitespace, bigger buttons — not more panels or density. The one-task-per-screen principle holds regardless of viewport. This protects the manager's focused experience.

**Admin screens**: Add a `@media (min-width: 768px)` breakpoint with tablet-optimized layouts:
- **Admin Home**: metric grid shifts from 1-column to 2x2, Needs Review + Manager Context side by side
- **Admin People list**: master-detail pattern — people list on left, person edit on right
- **Admin Imports (Amazon review)**: wider review rows with more inline context, fewer expand/collapse interactions
- **Admin Audit log**: table layout with visible columns (actor, action, entity, date) instead of stacked cards
- **Admin Settings**: form fields in two-column grid where natural (e.g., email + Telegram side by side)

**Bottom nav**: Stays as bottom nav on all sizes for both roles. No sidebar conversion — keeps the interaction pattern consistent across devices.

**Implementation**: CSS media queries in component-scoped `<style>` blocks. No layout framework. Built mobile-first, tablet enhancements added per-component during the phase that builds each screen.

---

## Verification Strategy

Each phase ends with:
- `npm run check` passes clean (0 warnings)
- `npm run build` succeeds
- Manual browser test on `localhost:5174` covering the golden path
- Mobile viewport test (375px width)
- Accessibility spot-check (font sizes, tap targets, contrast, status labels)

Final pre-deploy:
- Full accessibility audit against Section 11 checklist
- Test both user roles end-to-end
- Test on actual mobile device
- Smoke test on production after first deploy

---

## Resolved Decisions

1. **Data layer**: better-sqlite3 + thin typed wrapper (confirmed)
2. **Google Contacts scope**: Import only contacts with a valid birthday date. Auto-create Birthday person_occasions with correct month/day from the contact.
3. **Amazon email workflow**: Gmail forwarding rule routes Amazon emails to a labeled folder. App scans the label, parses gift-related emails + follow-ups (shipped/delivered). Processed emails moved to a sub-label. Admin-initiated purge of archive.
4. **Amazon parser format**: Placeholder until build time — will iterate on real email samples collaboratively.
5. **Domain/subdomain**: TBD — will figure out when we reach deployment phase. Same DO droplet as gaylon.photos.
