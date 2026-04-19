# Gift Tracker — Claude Design Document (V3)

**Version:** 3.0
**Date:** April 6, 2026
**Lineage:** Original design (V1) -> Codex redesign (V2) -> Claude review (V3)
**Purpose:** Authoritative MVP design incorporating Codex's scope reductions with structural corrections from Claude review.

---

## 1. Product Goal

Gift Tracker is a mobile-first web app that helps one primary household gift manager stay oriented around one question:

**What needs attention next?**

The product should reduce memory burden, minimize decision fatigue, and let the admin quietly maintain the system without exposing operational complexity to the manager.

This design assumes:

- One household
- Two internal users: `manager` and `admin`
- Low traffic
- Mobile-first usage
- Hosting on a single DigitalOcean droplet

---

## 2. Product Strategy

### 2.1 Roles

| Role | Primary Goal | Allowed Surface |
|------|--------------|-----------------|
| `manager` | See what is coming up and record gift progress | Simplified app only |
| `admin` | Maintain people, imports, notifications, and system health | Full admin console |

### 2.2 Product Split

The app is intentionally divided into two different experiences.

**Manager experience**

- Today
- Person detail
- Gift detail
- Add gift

**Admin experience**

- People management
- Occasion management
- Import/reconciliation
- Notifications
- Audit log
- Backup status

The manager should never see admin complexity by default.

---

## 3. MVP Scope

### 3.1 Must Have

- Authentication for two fixed accounts
- Today screen with prioritized actions
- People list and person detail
- Gift create/edit
- Gift status progression
- Occasion reminders
- Shipment tracking links
- Admin people management
- Audit log
- SQLite backups to DigitalOcean Spaces

### 3.2 Should Have

- Saved gift ideas
- Draft recovery (with staleness threshold)
- Soft delete / archive
- Admin anomaly flags
- Recently viewed section on Today screen

### 3.3 Not MVP

- Gmail parsing
- Google Contacts integration #GBV - I want this in PHase 1;  imports from gaylon@vorwaller.net google contacts, initial setup, and periodic updates, or one-off pulls
- Amazon CSV fuzzy staging workflow
- Multi-step notification tuning UI
- Calendar as a manager-facing primary view
- Multi-household support
- Carrier API polling

These can be added later without changing the core UX.

---

## 4. Core UX Principles

### 4.1 For the Manager

- One primary action per screen
- Recognition over recall
- Calm language, never alarmist
- Fewer choices, clearer defaults
- Forward-only progress controls where possible
- Draft-safe interaction

### 4.2 For the Admin

- Efficient batch operations
- Clear auditability
- Explicit system status
- Reversible changes
- All advanced workflows isolated from the manager

---

## 5. Information Architecture

### 5.1 Manager Navigation

Bottom nav with only 3 items:

- `Today`
- `People`
- `Packages`

There is no visible `Admin` entry in the manager account.

### 5.2 Admin Navigation

Bottom nav with 4 items:

- `Home`
- `People`
- `Imports`
- `Settings`

Admin pages can use denser controls because the admin is not the accessibility-constrained user.

> **V3 change:** Renamed admin "Today" to "Home" to avoid ambiguity with the manager's Today screen. The admin landing page is a control center, not a gift-tracking view.

---

## 6. Primary Manager Flows

### 6.1 Today

This is the default landing screen and the emotional center of the app.

Screen order:

1. **Next Best Action**
   One large card with one clear action.
   Example: "Marcus's birthday is April 20. No gift is marked bought yet."

2. **Coming Up Soon**
   2 to 5 upcoming occasions.

3. **Packages On The Way**
   Active shipments with expected delivery date.

4. **Recently Viewed**
   The last 2-3 things she looked at, helping her pick up where she left off. Shows person name and what she was viewing (gift detail, person page, etc.).

5. **Resume Last Task**
   If a draft exists and is less than 7 days old, show a single continue action. Drafts older than 7 days are not surfaced here — admin can dismiss or complete stale drafts from the admin console.

When there is nothing urgent:

"Everything that matters right now is handled."

> **V3 changes:**
> - Added "Recently Viewed" section (from original design doc Section 11.4). This is one of the more valuable accessibility features for a user who may forget what she was doing.
> - Added 7-day staleness threshold for draft recovery. A months-old abandoned draft resurfacing every visit is confusing, not helpful.

### 6.2 People

- Large, simple list
- Relationship shown as secondary text
- Optional search
- Sort by upcoming occasion, not alphabet, by default

### 6.3 Person Detail

Show:

- Person name
- Relationship
- Next occasion
- Last gift
- Saved ideas
- One primary button: `Add Gift`

Secondary sections:

- Gift history
- Notes

### 6.4 Add Gift

Default form fields:

- Who is it for?
- What is it?
- Where did you buy it?

Collapsed `More Details` section:

- Occasion
- Price
- Order ID
- Tracking number
- Notes

The form should auto-save locally and server-side as a draft.

### 6.5 Gift Detail

Gift detail should answer:

- Who is this for?
- What is it?
- What happens next?

Primary actions should be progressive:

- `Mark Bought`
- `Mark Shipped`
- `Mark Arrived`
- `Mark Wrapped`
- `Mark Given`

Avoid generic status dropdowns in the manager UI.

---

## 7. Simplified Gift Status Model

Internal state may remain detailed, but the manager-facing model should be compact.

| Internal State | Manager Label |
|---------------|---------------|
| `idea` | Idea saved |
| `planned` | Chosen |
| `ordered` | Bought |
| `shipped` | On the way |
| `delivered` | Arrived |
| `wrapped` | Ready |
| `given` | Given |
| `returned` | Returned |

Rules:

- Manager should see plain-language labels
- Manager actions should only move forward
- Admin can make corrections in the back office

---

## 8. Data Model

### 8.1 People

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| display_name | text | Manager-facing name, e.g. "Mom" |
| full_name | text nullable | Formal/shipping name |
| relationship | text nullable | |
| default_shipping_address | text nullable | |
| notes | text nullable | Preferences, sizes, avoidances |
| is_archived | boolean | soft delete |
| created_at | datetime | |
| updated_at | datetime | |

### 8.2 Occasions

Global occasion definitions. Shared holidays (Christmas, Mother's Day) exist once, not duplicated per person.

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| title | text | e.g. "Birthday", "Christmas" |
| kind | text | `birthday`, `holiday`, `anniversary`, `custom` |
| recurrence | text | `annual`, `one_time` |
| month | integer nullable | for annual |
| day | integer nullable | for annual |
| date | date nullable | for one-time |
| reminder_days | integer | default 21 |
| created_at | datetime | |
| updated_at | datetime | |

> **V3 change:** Restored normalized Occasions table from the original design. Codex merged occasions directly onto people (events with person_id FK), which meant "Christmas" had to be created 10 separate times for 10 people. Normalized tables are cleaner and have zero performance impact at this scale.

### 8.3 Person-Occasions

Links people to their relevant occasions. Not every person gets every occasion.

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| person_id | integer FK | -> people.id |
| occasion_id | integer FK | -> occasions.id |
| is_active | boolean | can deactivate without deleting |
| notes | text nullable | per-person occasion notes ("Marcus prefers experience gifts for birthdays") |

Unique constraint on (person_id, occasion_id).

Admin UI should support batch-assigning a shared occasion (e.g. Christmas) to multiple people at once.

### 8.4 Gifts

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| person_id | integer FK | |
| occasion_id | integer FK nullable | |
| occasion_year | integer nullable | |
| title | text | |
| source | text | "Amazon", "Etsy", etc. |
| source_url | text nullable | |
| order_id | text nullable | |
| tracking_number | text nullable | |
| carrier | text nullable | |
| price_cents | integer nullable | |
| status | text | |
| ordered_at | date nullable | |
| shipped_at | date nullable | |
| delivered_at | date nullable | |
| notes | text nullable | |
| is_idea | boolean | convenience flag for querying |
| is_archived | boolean | soft delete |
| created_at | datetime | |
| updated_at | datetime | |

### 8.5 Drafts

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| user_id | integer FK | |
| draft_type | text | `gift` |
| payload_json | text | |
| created_at | datetime | for staleness checks |
| updated_at | datetime | |

> **V3 change:** Added `created_at` to support the 7-day staleness threshold for manager-facing draft recovery.

### 8.6 Audit Log

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| actor_user_id | integer FK | |
| entity_type | text | |
| entity_id | integer | |
| action | text | |
| summary | text | human-readable |
| created_at | datetime | |

### 8.7 Users

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| username | text unique | |
| password_hash | text | argon2id |
| role | text | `manager` or `admin` |
| display_name | text | |
| last_login_at | datetime nullable | |
| last_seen_path | text nullable | for admin context |
| last_seen_at | datetime nullable | for recently-viewed and inactivity alerts |
| created_at | datetime | |

> **V3 change:** Added `last_seen_at` to support the "Recently Viewed" feature and inactivity alerting. `last_seen_path` was already present from Codex.

### 8.8 Recently Viewed

Tracks the last few items the manager looked at, powering the Today screen's "Recently Viewed" section.

| Field | Type | Notes |
|------|------|------|
| id | integer PK | |
| user_id | integer FK | |
| entity_type | text | `person`, `gift` |
| entity_id | integer | |
| label | text | display label at time of view, e.g. "Marcus" or "AirPods Max for Sarah" |
| viewed_at | datetime | |

Capped at 10 rows per user. On insert, delete oldest beyond cap.

### 8.9 Future Tables

Defer until needed:

- `import_runs`
- `import_rows`
- `person_aliases`
- `notification_preferences`
- `external_tokens`

---

## 9. Notification Design

### 9.1 MVP Behavior

Run one scheduled daily reminder job.

The job:

- calculates upcoming occasions
- checks whether a relevant gift exists in a handled state
- sends a simple digest to admin

### 9.2 MVP Channels

- Email
- Telegram

### 9.3 Message Tone

Use calm wording:

- "Marcus's birthday is in 12 days. No gift is marked bought yet."
- "AirPods Max for Sarah is expected to arrive tomorrow."

Do not use words like `URGENT` in manager-visible copy.

### 9.4 Notification Settings

For MVP, admin settings should be minimal:

- email destination
- telegram on/off
- reminder lead time
- weekly summary on/off

Avoid per-tier tuning UI in v1.

---

## 10. Import Strategy

### 10.1 MVP Position

Imports are not part of the core manager workflow.

The system should treat manual entry as primary truth in MVP.

### 10.2 Phase 2 Import

#GBV I want email parsing for Amazon orders.  Planned workflow is to have manager mark Amazon orders as 'gift', with 'receipient name' in gift comments.  The Amazon emails will be routed to a fixed gmail folder under gaylon@vorwaller.net.  From these, can get all gift details.  Would need matching with reciipient names in the db.  I want this on the first iteration of the app.

Add a simple admin reconciliation import:

- upload CSV
- parse rows
- detect duplicates by order ID + title
- show unmatched rows
- allow manual assign

Do not ship fuzzy staging, tier systems, or auto-creation rules until real sample data proves they are needed.

### 10.3 Order ID Strategy

Keep `order_id` in the data model now so future import enrichment is possible without redesign.

---

## 11. Accessibility and Visual Design

### 11.1 Layout Rules

- 18px base body size minimum
- 48x48 touch targets minimum
- One sticky header
- One primary CTA per screen
- Strong spacing between sections

### 11.2 Visual Direction

The UI should feel warm, domestic, and composed.

- Cream paper background (`#f5f1e8`)
- Paper white cards (`#fffdf8`)
- Evergreen primary (`#2f5d50`)
- Amber attention (`#bd7a2a`)
- Deep ink text (`#1f2a24`)
- Muted text (`#3d4a3f`) — darkened from Codex mockup to meet WCAG AAA 7:1
- Warm borders (`#ddd2c2`)
- Soft shadows (`0 6px 20px rgba(47, 35, 18, 0.08)`)
- Card radius `18px`, button/input radius `14px`

Typography:

- Headings: Georgia / "Times New Roman" (serif warmth)
- Body: "Avenir Next" / "Segoe UI" / system-ui (legibility)

### 11.3 Status Representation

Never use color alone.

Each status block must include:

- icon
- label
- supporting sentence

### 11.4 Language Standard

Use `People` in navigation and `Gift` in actions.

Avoid mixing `recipient`, `person`, and `contact` in manager-facing screens.

---

## 12. Deployment on DigitalOcean

### 12.1 Hosting Stack

- SvelteKit with `adapter-node`
- SQLite with WAL mode enabled
- Nginx reverse proxy
- PM2 process supervision
- Cloudflare proxying (matches existing gaylonphotos setup)
- DigitalOcean Spaces for backups

### 12.2 Security

- Store secrets in environment or root-owned config file
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Strict`
- argon2id for password hashing

### 12.3 SQLite Guidance

- Enable WAL mode
- Use short transactions
- Keep scheduled jobs single-instance
- Perform hot backups with `.backup`

### 12.4 Scheduled Jobs

Three cron jobs are enough:

1. daily reminders
2. nightly backup to Spaces
3. weekly backup verification / restore check

Each job should:

- write to a log
- acquire a lock file
- fail safely

### 12.5 Observability

Minimal but sufficient:

- `/healthz` endpoint
- process uptime check
- last successful backup timestamp
- last successful reminder run timestamp

---

## 13. Admin Home (Control Center)

The admin landing page surfaces system health and manager context. Sections in order:

1. **Priority Action** — one card with the single most important admin task (e.g. "Taylor Nguyen has no occasion assigned").

2. **System Snapshot** — metric grid: upcoming events needing gifts, records needing cleanup, failed jobs, last backup time.

3. **Needs Review** — items requiring admin attention: incomplete person records, stale drafts (older than 7 days), import exceptions.

4. **Manager Context** — last login time, what screens the manager visited, anomaly detection (backward status moves, duplicates, rapid repeat edits).

5. **Operations** — backup health, reminder job status. Only show indicators for actual system states (healthy/warning/error). Do not use error-colored indicators for intentional design decisions.

6. **Quick Actions** — buttons for People Manager, Import Review, Backup Status.

> **V3 change:** Operations section no longer uses a red dot for "Imports remain a secondary tool." Red means broken. Intentional design decisions should not appear as system alerts.

---

## 14. Recommended Build Order

1. Auth and roles
2. Today screen (including Recently Viewed)
3. People list and person detail
4. Add/edit gift with draft save (including staleness threshold)
5. Gift detail and forward-only actions
6. Reminder job
7. Admin people tools (with batch occasion assignment)
8. Audit log
9. Backup status page
10. Imports later

---

## 15. Schema Creation Order

Create tables in this order:

1. `users`
2. `people`
3. `occasions`
4. `person_occasions`
5. `gifts`
6. `drafts`
7. `recently_viewed`
8. `audit_log`
9. `job_runs`
10. `app_state`

Defer until later:

- `import_runs`
- `import_rows`
- `person_aliases`
- `notification_preferences`
- `external_tokens`

---

## 16. Success Criteria

The MVP succeeds if:

- the manager can open the app and understand what matters within 5 seconds
- adding a gift takes under 30 seconds
- the admin can quietly correct mistakes without confusing the manager
- the app runs reliably on one small DO host with no extra infrastructure

---

## 17. V3 Change Summary

Changes from Codex V2:

1. **Restored normalized Occasions + Person-Occasions tables** — Codex denormalized occasions onto people. Restored the join-table approach so shared holidays exist once, not duplicated per person. Zero performance impact at this scale, cleaner data model.
2. **Added "Recently Viewed" section to Today screen** — from original design doc Section 11.4. Tracks last 2-3 items the manager viewed. Valuable for a user who may forget what she was doing.
3. **Added 7-day draft staleness threshold** — drafts older than 7 days are not surfaced on the manager's Today screen. Admin can dismiss or complete stale drafts.
4. **Renamed admin nav "Today" to "Home"** — avoids ambiguity with the manager's Today screen. The admin landing is a control center, not a gift-tracking view.
5. **Removed red indicator for intentional design decisions** — the "Imports remain a secondary tool" item in admin Operations no longer uses a red/error indicator. Red means broken.
6. **Removed Cloudflare SSL directive** — Codex specified "Do not use Cloudflare Flexible SSL." This app shares a droplet with gaylonphotos which already uses Cloudflare. SSL configuration is an infrastructure concern, not an app design decision. Removed from spec.
7. **Darkened muted text color** — `#5e675f` -> `#3d4a3f` to meet WCAG AAA 7:1 contrast ratio against cream backgrounds.
8. **Added `recently_viewed` table and `last_seen_at` to users** — data model support for the Recently Viewed feature and inactivity alerting.
9. **Added `created_at` to drafts table** — supports staleness threshold logic.
