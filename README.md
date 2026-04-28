# Gift Tracker

A calm, mobile-first gift-giving tracker for keeping the people you love and the
occasions you care about in sight.

Two roles only — **admin** (Gaylon) and **manager** (Madonna). No public sign-up.

Live at **<https://gifts.gaylon.photos>**.

## Stack

- **SvelteKit 2** (TypeScript, adapter-node), runes-mode
- **better-sqlite3** with WAL — single-process, single-writer
- **argon2id** password hashing, server-side sessions, `SameSite=Lax` cookies
- **Google OAuth2** (Gmail + People API) for Contacts import and Amazon email parsing
- **node-cron** in-process scheduler (env-guarded; only runs when `NODE_ENV=production AND ENABLE_CRON=true`)
- **PM2** for process management on a shared DigitalOcean droplet behind Nginx + Cloudflare (Flexible SSL)
- **Telegram + nodemailer** for daily digest delivery

Accessibility is a core constraint, not a polish item — Lighthouse 100/100/100/98 against `/login` in prod.

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
| Schema | `migrations/*.sql` |
| Type definitions | `src/lib/server/types.ts` |
| Auth | `src/lib/server/{auth,session}.ts` |
| Job orchestration | `src/lib/server/jobs/{runner,reminders,amazon-import,christmas-kickoff}.ts` |
| Notification channels | `src/lib/server/{notify,notify-email,notify-telegram}.ts` |
| Cron scheduler | `src/lib/server/scheduler.ts` |
| Audit log | `src/lib/server/audit.ts`, `/admin/audit` |
| Occasion management | `src/lib/server/occasions.ts`, `/admin/occasions` |
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
  - `reminders.daily` — `0 8 * * *`
  - `amazon.scan` — `30 7 * * *` (before reminders so the digest sees fresh pending counts)
  - `amazon.cleanup_processed` — `15 3 * * 0`
  - `christmas.kickoff` — `0 8 1 9 *` (Sept 1 — gift-shopping kickoff)
