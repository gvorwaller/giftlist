# AI Assistant Session Guide

## Session Startup (Required)
1. Read `cs.md` (this file) — hard rules that override defaults
2. Read `docs/agent-development-guide.md` — canonical cross-agent coding,
   data/side-effect safety, UI/UX, verification, and release workflow
3. Read `CLAUDE.md` — project architecture and patterns
4. Read `docs/gift-tracker-design-Claude.md` — authoritative design spec (V3)
5. Check recent devlog entries in `docs/devlog/`
6. Run `td usage --new-session` to see current tasks

---

## Core Principles

### No Assumptions
- **Never guess** when you can verify — read source code, check config files, test directly
- **Never assume the user's environment** — don't guess what device, browser, or OS they're using
- **Never assume infrastructure details** — read deploy scripts, config files, and connection strings instead of guessing
- **State uncertainty explicitly** — if you must hypothesize, say so and ask for confirmation
- **Ask when uncertain** — one question is cheaper than one wrong assumption

### No Quick Fixes
- Find root causes, not band-aids
- Implement maintainable solutions
- If a fix requires multiple rounds, slow down and trace the data flow

### Evidence-Based Debugging (MANDATORY)
When diagnosing errors, follow this methodology instead of guessing:

1. **Read the relevant source code** before forming any hypothesis
2. **Trace the data flow** — client -> API route -> server module -> database -> response
3. **Test each layer independently** — use curl, direct DB queries, or browser devtools
4. **Compare expected vs actual** at each boundary
5. **Never assume a cause** — verify with evidence first, then propose a fix

> "No guesses, only solid evidence, tracing the code carefully."

---

## Production Infrastructure

### DigitalOcean Droplet (Shared with gaylonphotos, madonnahist, birds)
- **SSH**: `ssh root@134.199.211.199`
- **Two instances** from this one repo, each with its own checkout, `.env`, and SQLite file:
  - `giftlist` — `/opt/giftlist`, port **3001**, <https://gifts.gaylon.photos>
  - `giftlist-cv` — `/opt/giftlist-cv`, port **3005**, <https://giftlist-cv.gaylon.photos> (PM2 config `ecosystem-cv.config.cjs`)
- Sibling ports: gaylonphotos=3000, madonnahist=3002, birds=3003
- **Process manager**: PM2 (NOT systemd)
  - Restart: `pm2 restart ecosystem.config.cjs --update-env` (or `ecosystem-cv.config.cjs`)
  - Logs: `pm2 logs giftlist --lines 30` / `pm2 logs giftlist-cv --lines 30`
- **Domains**: proxied through Cloudflare (HTTP only, NOT SSH)
- **Database**: SQLite at `<app dir>/data/gifttracker.db` per instance
- **Health**: `/healthz` returns `status`, `schema_version`, last backup/reminder times; 503 if the shipment schema is incomplete
- **Deploy script**: `./scripts/deploy-to-DO.sh` — pre-flight, push, then per instance: pre-deploy DB snapshot, pull, install, build, PM2 restart, health check. Deploys **both** instances by default; `--target <name>` for one.

### Deploying
**Always use `./scripts/deploy-to-DO.sh` to deploy, and only when explicitly asked.** Never manually SSH and run build commands. The script handles push, pull, install, build, PM2 restart, and health check for both instances.

### Critical: SSH Is NOT the Domain
The domain resolves to Cloudflare IPs, not the droplet. **Always use the IP `134.199.211.199` for SSH.** The deploy script already does this correctly — follow its example.

### Sessions Are Cookie-Based
Session cookies are httpOnly, secure, SameSite=Strict. Two fixed accounts only — no registration flow.

### Shared Droplet Awareness
Two giftlist instances co-locate with gaylonphotos, madonnahist, and birds on one droplet. Be mindful of:
- Memory usage — all apps share RAM
- Port conflicts — see the port list above
- PM2 process names — use distinct names to avoid confusion
- Nginx config — separate server blocks per subdomain

---

## Project-Specific Rules

### Accessibility Is Non-Negotiable
Every UI decision must pass this filter: **"Will this confuse the gift manager, or will this help her stay oriented and confident?"**

Key rules:
- **One task per screen** — no multi-panel complexity
- **Two taps max** from home to any information
- **Large text** — 18px minimum base, 20-24px for key info
- **Large tap targets** — 48x48px minimum with generous spacing
- **No gestures** — no swipe, long-press, or drag-and-drop. Visible labeled buttons only.
- **Recognition over recall** — show full context on every screen (who, what, which occasion)
- **Warm, simple language** — "Marcus's birthday is in 12 days" not "Event ID 3 in 12d"
- **No dead ends** — every screen has a clear next action
- **Soft deletes only** — no permanent deletes in manager view

### CSS & UI
- **No Tailwind. No utility frameworks.** Component-scoped `<style>` blocks only.
- **No toast notifications.** Use modal confirmation dialogs for destructive actions.
- **Warm domestic palette** — cream backgrounds (`#f5f1e8`), paper cards (`#fffdf8`), evergreen primary (`#2f5d50`), amber attention (`#bd7a2a`). NOT the BTC Dashboard clinical white/gray pattern.
- Card styling: paper background, `border-radius: 18px`, `border: 1px solid #ddd2c2`, soft shadow
- Serif headings (Georgia), sans body (Avenir Next / system-ui)
- WCAG AAA contrast ratios (7:1) for all text — **including muted text** (use `#3d4a3f` not `#5e675f`)
- Status badges always use color + text label — never color alone

### Data Integrity
**NEVER:**
- Create synthetic or placeholder data
- Use fallback data to mask broken code
- Add schema columns/fields that don't exist
- Use hidden default values for DB/env parameters
- Modify production data (either instance) without explicit user confirmation
- Delete records permanently from the manager interface
- Run a DB-touching test without `setupTestDb()` — a bare `getDb()` opens the real dev DB
- Point local code at a prod DB copy from `data/backup/prod/`

**ALWAYS:**
- Enable WAL mode on SQLite at startup
- Write human-readable audit log entries for all mutations
- Keep database writes short to avoid lock contention
- Use `db.transaction(...)` for multi-statement mutations (imports, commits)
- Snapshot the dev DB (`./scripts/backup-sqlite.sh --local-only`) before manual testing that writes to it
- Validate at system boundaries (API routes), trust internal code

### Outside Services Are Real (Even From Dev)
The dev server uses real credentials. These actions have effects outside this repo — do not trigger them without the user's go-ahead for that specific action:
- **Gmail** — Amazon/tracking scans move messages between `Giftlist/*` labels; `scripts/dev-relabel-amazon.ts` and `scripts/dev-wave1-iteration.sh` relabel the real mailbox
- **Anthropic** — LLM matcher calls are metered; clearing `matcher_llm_cache` forces fresh paid calls
- **Shippo** — each tracking registration is billed
- **Telegram / SMTP** — reminders and notifications send real messages
- **Google Contacts** — import reads the real address book

Unit/DB tests mock all of these. Never put real secrets into a test.

### Migrations
- New `migrations/NNN-name.sql` only — never DDL in app code. They run at boot on **both** prod instances.
- Test against `migrate.test.ts` and a snapshot copy of the dev DB before shipping.
- Never edit an already-deployed migration. Bump the schema version noted in `CLAUDE.md`.

### Status Lifecycle
Gift status transitions are **forward-only via explicit button actions**, not arbitrary dropdown edits:
`idea` -> `planned` -> `ordered` -> `shipped` -> `delivered` -> `wrapped` -> `given`
(`returned` branches from any post-`ordered` state)

Admin can override, but manager view enforces forward progression only.

---

## Development Workflow
- **Dev server port**: 5175 (5173 BTC Dashboard, 5174 gaylonphotos, 5176 madonnahist, 5178 birds)
- **Always `cd` back** to project root after operations
- **Use absolute paths** when possible to avoid directory confusion
- **Commits**: Only commit when explicitly asked. Push and deploy only when explicitly asked — an implementation request is not release authorization
- **Preserve unrelated work**: existing uncommitted changes belong to the user or another agent; don't reformat or commit them. Don't run `npm run format` over a dirty tree
- **Server restarts**: Ask the user to restart the dev server after config changes

### Verification Commands
- `npm run build` — production build (always run after code changes)
- `npm run check` — `svelte-kit sync && svelte-check` (type checking + Svelte diagnostics, 0 warnings baseline)
- `npm test` — Vitest; run for server, schema, auth, import, or shared-UI changes
- `git diff --check`
- Run these before committing. If `npm run check` reports new warnings, fix them before commit.
- Full testing method (browser + iOS Simulator pass, handoff checklist): `docs/agent-development-guide.md` §6–7

---

## State Tracking Tools
- `td` — task management CLI (`td usage --new-session` at session start). Do **not** `td close` your own completed work — use `td review` → `td approve` (approval must come from a different session than the implementer)
- `/nn` — append timestamped entry to today's devlog
- `/review` — adversarial review loop before commits
- `ctx` — export full context for session continuity

---

## Historical Failures (Learn From These)
*(Inherited from gaylonphotos — same infrastructure, same mistakes to avoid)*

- **2026-03-07**: Used `ssh root@gaylon.photos` — timed out because domain resolves to Cloudflare, not the droplet. Always use `root@134.199.211.199`.
- **2026-03-07**: Used `systemctl restart gaylonphotos` — failed because app uses PM2, not systemd. Always use `pm2 restart`.
- **2026-03-07**: Assumed user was on mobile from a screenshot — they were on Mac with a narrow browser window. Never assume the user's device.
- **2026-03-11**: Tried manual `ssh root@gaylon.photos` + `npm run build` to deploy — timed out, then host key failure. Deploy script handles everything correctly. Never deploy manually.
- **Missing `await`** (sibling repos): async function returned a Promise consumed as a value, yielding empty results. Always `await` async calls — and never `await` inside a synchronous `better-sqlite3` transaction body.
- **Missing import causing CPU spike** (sibling repos): a `ReferenceError` in a hot loop pegged CPU at 100%. Smoke-test after refactors.

### Key Principle
> Assumptions are the enemy. Read the code. Read the config. Test the layer. Only then diagnose.
