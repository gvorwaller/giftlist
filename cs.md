# AI Assistant Session Guide

## Session Startup (Required)
1. Read `cs.md` (this file) — hard rules that override defaults
2. Read `CLAUDE.md` — project architecture and patterns
3. Check recent devlog entries in `docs/devlog/`
4. Run `td usage --new-session` to see current tasks

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

### DigitalOcean Droplet (Shared with gaylonphotos)
- **SSH**: `ssh root@134.199.211.199`
- **App directory**: `/opt/giftlist`
- **App port**: 3001 (gaylonphotos uses 3000)
- **Process manager**: PM2 (NOT systemd)
  - Restart: `pm2 restart ecosystem.config.cjs --update-env`
  - Logs: `pm2 logs giftlist --lines 30`
- **Domain**: TBD — separate subdomain, proxied through Cloudflare (HTTP only, NOT SSH)
- **Database**: SQLite file at `/opt/giftlist/data/gifttracker.db`
- **Deploy script**: `./scripts/deploy-to-DO.sh` — pushes, pulls on droplet, builds, restarts PM2

### Deploying
**Always use `./scripts/deploy-to-DO.sh` to deploy.** Never manually SSH and run build commands. The script handles push, pull, install, build, PM2 restart, and health check.

### Critical: SSH Is NOT the Domain
The domain resolves to Cloudflare IPs, not the droplet. **Always use the IP `134.199.211.199` for SSH.** The deploy script already does this correctly — follow its example.

### Sessions Are Cookie-Based
Session cookies are httpOnly, secure, SameSite=Strict. Two fixed accounts only — no registration flow.

### Shared Droplet Awareness
This app co-locates with gaylonphotos on the same 1 GB (or 2 GB) droplet. Be mindful of:
- Memory usage — both apps share RAM
- Port conflicts — gaylonphotos is on 3000, this app on 3001
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
- Modify production data without explicit user confirmation
- Delete records permanently from the manager interface

**ALWAYS:**
- Enable WAL mode on SQLite at startup
- Write human-readable audit log entries for all mutations
- Keep database writes short to avoid lock contention
- Validate at system boundaries (API routes), trust internal code

### Status Lifecycle
Gift status transitions are **forward-only via explicit button actions**, not arbitrary dropdown edits:
`idea` -> `planned` -> `ordered` -> `shipped` -> `delivered` -> `wrapped` -> `given`
(`returned` branches from any post-`ordered` state)

Admin can override, but manager view enforces forward progression only.

---

## Development Workflow
- **Dev server port**: 5174 (5173 is BTC Dashboard)
- **Always `cd` back** to project root after operations
- **Use absolute paths** when possible to avoid directory confusion
- **Commits**: Only commit when explicitly asked

### Verification Commands
- `npm run build` — production build (always run after code changes)
- `npm run check` — `svelte-kit sync && svelte-check` (type checking + Svelte diagnostics, 0 warnings baseline)
- Run both before committing. If `npm run check` reports new warnings, fix them before commit.

---

## State Tracking Tools
- `td` — task management CLI
- `nn` — append timestamped entry to today's devlog
- `ctx` — export full context for session continuity

---

## Historical Failures (Learn From These)
*(Inherited from gaylonphotos — same infrastructure, same mistakes to avoid)*

- **2026-03-07**: Used `ssh root@gaylon.photos` — timed out because domain resolves to Cloudflare, not the droplet. Always use `root@134.199.211.199`.
- **2026-03-07**: Used `systemctl restart gaylonphotos` — failed because app uses PM2, not systemd. Always use `pm2 restart`.
- **2026-03-07**: Assumed user was on mobile from a screenshot — they were on Mac with a narrow browser window. Never assume the user's device.
- **2026-03-11**: Tried manual `ssh root@gaylon.photos` + `npm run build` to deploy — timed out, then host key failure. Deploy script handles everything correctly. Never deploy manually.

### Key Principle
> Assumptions are the enemy. Read the code. Read the config. Test the layer. Only then diagnose.
