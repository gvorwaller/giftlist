# Giftlist repository development guide

This is the canonical, tool-agnostic workflow for coding, testing, reviewing,
and releasing changes in this repository. It applies to human contributors and
AI coding agents, including Claude Code, Codex, Gemini, and Grok. Adapted from
the birds repo's guide for giftlist's stack (SvelteKit + SQLite, two prod
instances, live Gmail/LLM/Shippo integrations).

The short instruction to give an agent is:

> Follow `docs/agent-development-guide.md` for this change. Read the required
> repository context first, protect existing data and outside services,
> implement only the requested scope, and return the verification evidence
> without committing or deploying unless I explicitly ask.

This guide organizes the workflow. [`../cs.md`](../cs.md) remains the authority
for project-specific safety, infrastructure, data, and UI rules.

## 1. Required startup

Before diagnosing or editing:

1. Read `cs.md` completely.
2. Read this guide completely.
3. Run `td usage --new-session` at the beginning of a new agent conversation;
   use `td usage -q` after that. Read the named ticket with `td show <id>` and
   inspect its dependencies when they may affect the work.
4. Read the latest relevant entry in `docs/devlog/`. For design questions, the
   authoritative spec is `docs/gift-tracker-design-Claude.md`.
5. Read the relevant source and tests before proposing a cause or solution.
6. Inspect the repository state:

   ```sh
   git status --short --branch
   git diff --stat
   git diff --check
   ```

   Existing changes belong to the user or another agent. Preserve them, do not
   reformat them incidentally, and do not include them in a commit.

7. State the intended scope and the evidence needed to call it complete. If the
   request leaves a product decision genuinely unresolved, ask one focused
   question instead of inventing behavior.

Repository context is applied in this order: the user's current request and
explicit decisions; `cs.md` hard rules; the accepted ticket/specification;
this workflow; then current source and tests as implementation evidence. If a
document is stale, report the conflict and use live code/data to establish the
current state. Do not silently reinterpret the requested product behavior.

## 2. Scope and change discipline

- Make the smallest coherent change that satisfies the accepted behavior. Do
  not bundle opportunistic cleanup, dependency updates, redesigns, or unrelated
  ticket work.
- Diagnose from evidence: trace browser/client -> route/form action -> server
  module -> SQL or provider -> stored state -> rendered response. Verify each
  relevant boundary before changing code.
- Prefer shared helpers and components when the same contract is already used
  in more than one place. Do not create a broad abstraction for one call site.
- Preserve existing query parameters, authorization (admin vs manager, per-user
  self-package privacy), empty/error states, and no-JavaScript form behavior
  unless the task explicitly changes them.
- Never fix a presentation problem by silently reducing data, adding a hidden
  row cap, changing a default, or substituting fallback data. Missing data is
  not evidence of absence.
- Use targeted editing. Avoid repository-wide formatters in a dirty worktree
  (`npm run format` rewrites everything). Format or check only touched files.
- Do not commit, push, deploy, mutate production data, or trigger an outside
  side effect (section 3) unless the user explicitly authorizes that action.
  An implementation request does not imply release authorization.

## 3. Protecting data and outside services

### Production (two instances)

Production is never a test fixture. Both instances run from this repo on the
shared droplet, each with its own `.env` and SQLite file:

| Instance      | Dir                | Port | URL                                 |
| ------------- | ------------------ | ---- | ----------------------------------- |
| `giftlist`    | `/opt/giftlist`    | 3001 | <https://gifts.gaylon.photos>       |
| `giftlist-cv` | `/opt/giftlist-cv` | 3005 | <https://giftlist-cv.gaylon.photos> |

- Default production access is read-only diagnosis and post-release smoke
  verification.
- Do not run `INSERT`, `UPDATE`, `DELETE`, DDL, `sqlite3 .restore`, a manual
  job trigger (`/admin/system`), an import scan/commit, a cache clear, the
  auto-accept toggle, or any admin mutation on either instance without
  explicit authorization for that production effect.
- A requested deployment authorizes the migrations in the intended release,
  which run at boot via `src/lib/server/migrate.ts`. It does not authorize
  unrelated manual SQL or a one-off data repair.
- For diagnostic SQL on the droplet, open the DB read-only
  (`sqlite3 -readonly <path>`) and report counts as dated snapshots, not
  permanent product facts.
- Never print, commit, copy, or document prod `.env` values, including the
  copy that `scripts/backup-sqlite.sh` pulls into `data/backup/prod/`.

### Outside services (side effects even from the local dev server)

The local dev server talks to real services with real credentials. These are
outward-facing actions; do not trigger them without the user's go-ahead for
that specific action:

- **Gmail** — Amazon and tracking scans (`amazon-import.ts`,
  `tracking-import.ts`) move messages between `Giftlist/*` labels in the real
  mailbox. `scripts/dev-relabel-amazon.ts` and
  `scripts/dev-wave1-iteration.sh` also relabel real Gmail.
- **Anthropic** — the LLM matcher calls Opus on scans/review loads (metered
  cost). Clearing `matcher_llm_cache` forces fresh paid calls.
- **Shippo** — tracking registration costs money per POST (`tracking.ts`).
- **Telegram / SMTP** — reminder digests and notifications send real messages.
- **Google Contacts** — the contacts import reads the real address book.

The scheduler only starts with `NODE_ENV=production` and `ENABLE_CRON=true`, so
the dev server does not run cron jobs on its own — but a button or form
action in the dev UI calls the same code paths as prod.

### The local dev database

`data/gifttracker.db` (from `DATABASE_PATH` in `.env`) is the local working
database. It is not a disposable fixture: it holds realistic people,
occasions, gifts, import history, and an encrypted Google OAuth token.

- Before any manual test that writes to it (form submits, import commits,
  status changes), snapshot it with `./scripts/backup-sqlite.sh --local-only`
  and state how to restore. Do not delete or replace it without explicit
  authorization.
- Do not point the dev server or scripts at a prod DB copy from
  `data/backup/prod/`. Prod `AUTH_SECRET` encrypts `external_tokens`, so a
  restored prod DB either fails to decrypt or, with the prod secret, acts on
  the real prod Google account.
- Never use fallback or synthetic rows to make a page render.

### Automated tests

Vitest DB tests must isolate themselves with `setupTestDb()` /
`teardownTestDb()` from `src/lib/server/test-harness.ts`, which creates a fresh
migrated SQLite file under the OS temp dir and points `DATABASE_PATH` at it.
Every test that touches the DB must:

1. Call `setupTestDb()` before calling `getDb()`. A bare `getDb()` in a test
   opens `./data/gifttracker.db`, the real dev DB.
2. Build its own rows with the harness factories (`seedUser`, etc.). Never
   depend on rows from the dev DB.
3. Tear down in `afterEach`/`afterAll` so a failing test leaves nothing behind.
4. Make no live provider calls. Mock Gmail, Anthropic, Shippo, Telegram, SMTP,
   and Google APIs, following the existing patterns (e.g.
   `amazon-import-fixtures.test.ts` mocks the LLM per scenario). Never put
   real secrets into a test.

### Migrations

- Schema changes go in a new `migrations/NNN-name.sql`. Never perform DDL from
  app code outside the migration runner.
- Migrations run automatically at boot on both prod instances, so test every
  new migration against a copy of the dev DB (snapshot first) as well as via
  `migrate.test.ts`, including the application behavior that consumes it.
- Table rebuilds use the SQLite recreate-table pattern; the runner already
  disables foreign keys around each migration and runs `foreign_key_check`
  after commit.
- Never edit a migration that has already been deployed. Update the schema
  version in `CLAUDE.md` when you add one.
- Keep expensive or externally metered data backfills separate from schema
  changes, with explicit authorization.

## 4. Server, SQL, auth, and provider conventions

- Validate untrusted input at route/form-action boundaries. Return explicit
  `fail()`/4xx errors for malformed, unknown, unauthorized, or missing values.
- `better-sqlite3` is synchronous: use prepared, parameterized statements and
  `db.transaction(...)` for multi-statement mutations. Keep write transactions
  short (single-writer WAL). Never `await` inside a transaction body.
- SQLite type boundary: JSON columns return as strings (parse with a guard);
  booleans are `0`/`1`; dates are TEXT. Coerce at the boundary.
- Apply filters and account scope in SQL before counts, ordering, and
  pagination. Do not fetch broad data and hide it in the UI.
- Role and privacy rules:
  - Managers cannot reach `/admin/*` (enforced in
    `src/routes/admin/+layout.server.ts`). Admin may preview as manager.
  - Any POST that accepts a `person_id` must check
    `isPersonVisibleToUser(personId, userId)` — self-packages are private.
  - Test admin, manager, and other-user/self-package cases when a change
    touches scope.
- Every mutation writes a human-readable `audit_log` entry. Soft deletes only
  in the manager view; status changes are button-driven, forward-only.
- Respect the Shippo registration mutex and the LLM cache-key versioning
  described in `CLAUDE.md`; do not bypass either to "simplify".
- Never log tokens, API keys, passwords, OAuth tokens, session cookies, raw
  email bodies, or `.env` values.

## 5. UI/UX approach

The manager is the primary user, and accessibility is the core design
constraint (`cs.md` → Accessibility Is Non-Negotiable; design spec section 11).
Before changing visible behavior, inspect the current page, the shared
components it uses, and the relevant mockup in `docs/`. Extend the existing
visual language; do not introduce a page-specific design system.

- Svelte 5/SvelteKit patterns already in the repo. Component-scoped CSS with
  the documented tokens. No Tailwind or utility framework.
- Mobile-first. Check 390x844 and a desktop width around 1200px; add 320px for
  dense layouts. No horizontal page overflow.
- 18px base text, 20–24px for key info, 48x48px tap targets, WCAG AAA (7:1)
  contrast including muted text. Status always has a text label.
- No gestures, no toasts. Destructive actions use a modal confirmation.
- One task per screen, two taps max from home, no dead ends, warm plain
  language.
- Prefer native links, forms, buttons, and headings. Preserve refresh,
  Back/Forward, focus order, visible focus, and accessible names.

## 6. Testing method

Choose evidence by risk; different layers prove different things.

| Layer                    | What it proves                                   | Standard use                              |
| ------------------------ | ------------------------------------------------ | ----------------------------------------- |
| Pure unit test           | Parsers, matchers, deciders, policy              | Every extracted rule or regression        |
| Harness DB test          | SQL shape, migrations, constraints, scope, dedup | Every meaningful DB/query/schema change   |
| Browser journey (dev DB) | Rendering, navigation, focus, responsive layout  | Every meaningful user-visible change      |
| Read-only prod smoke     | Deployed revision, live config, `/healthz`       | After an explicitly authorized deployment |

### A. Baseline and regression coverage

- Run the nearest existing tests before editing when that is quick.
- Reproduce the failure at the real layer and record URL, role, data state,
  viewport, and the observed vs expected behavior.
- For bug fixes, write a test that fails for the demonstrated mechanism. Run
  exact files while iterating:

  ```sh
  npx vitest run src/lib/server/changed.test.ts --reporter=verbose
  ```

### B. User-visible changes

Run `npm run dev` (port 5175) against the dev DB (snapshot first if you will
write). Test the affected journey as admin and as manager. Verify the actual
content (not just HTTP 200), keyboard use, phone and desktop layout, console
errors, and refresh/Back. For Safari-specific behavior, the global
`safaridriver` notes in `~/.claude/CLAUDE.md` apply.

For taps, focus/blur, the on-screen keyboard, or sticky/fixed UI, do a Mobile
Safari pass on the iOS Simulator with the `axe` CLI (no Xcode project or MCP
server needed; proven in the birds repo, td-327dd6):

```sh
U=$(xcrun simctl list devices | awk -F'[()]' '/iPhone 16 Pro \(/{print $2; exit}')
xcrun simctl boot "$U"; xcrun simctl bootstatus "$U" -b
xcrun simctl openurl "$U" "http://localhost:5175/login"
axe screenshot --udid "$U" --output /tmp/ios-1.png      # look before every tap
axe batch --udid "$U" --step "tap -x 201 -y 416" --step "sleep 1"
```

- Web content is not in `axe describe-ui`; tap by coordinates from the latest
  screenshot (pixels ÷ 3 on an iPhone 16 Pro). Re-screenshot after anything
  that moves the page.
- Wait inside `axe batch` with `--step "sleep N"`.
- Sign in with the dev accounts from `.env`; do not echo the passwords into
  devlogs or ticket notes.
- `xcrun simctl shutdown "$U"` when done.

Report it as an iOS Simulator result. Do not claim physical-iPhone or
installed-PWA verification from a simulator or desktop browser run; list it as
outstanding.

### C. Repository gates

After code changes:

```sh
npm run check     # 0 errors, 0 warnings baseline
npm run build
npm test          # for server, schema, auth, import, or shared-UI changes
git diff --check
```

For a narrow isolated change, focused tests plus check/build may be enough —
say that the full suite was not run. Use `npx prettier --check <touched files>`
when formatting is in doubt. Treat new warnings, unhandled rejections,
unexpected skips, and console errors as failures.

### D. Review the final diff

```sh
git status --short --branch
git diff --stat
git diff -- <intended paths>
```

Confirm the diff holds only the intended work: no secrets, debug logging,
generated artifacts, hidden caps, or unrelated formatting.

## 7. Completion and review

An implementation agent saying "done" means ready for review, not accepted.
The final handoff states:

- behavior implemented and paths changed;
- tests run, with pass/fail/skip counts;
- whether harness DB tests, the browser/simulator, and both roles were
  exercised;
- whether the dev DB was written (and the snapshot to restore from);
- which outside services, if any, were contacted and with what authorization;
- `npm run check`, `npm run build`, and `git diff --check` results;
- anything not tested and why;
- explicitly: not committed, not deployed, and no production data changed,
  unless those actions were separately authorized and verified.

Log evidence with `td log <id> --result "..."`. Submit completed work through
`td review` → an independent `td approve`; the implementing session must not
self-approve or `td close` its own work. For risky, scope-touching, migration,
or importer/matcher work, run `/review` or seek an independent diff review.

## 8. Commit and release procedure

Only begin this section after an explicit instruction to commit or deploy.

1. Reconfirm the exact release scope and preserve unrelated work.
2. Add a devlog entry (`/nn`) when requested or part of the release work.
3. Re-run focused tests, `npm run check`, `npm run build`, and
   `git diff --check` against the final contents.
4. Commit only intended files. Push only when authorized.
5. Deploy only with `./scripts/deploy-to-DO.sh`. It deploys **both** instances
   by default; use `--target giftlist` or `--target giftlist-cv` only when the
   user asks for one. Never deploy manually.
6. Confirm the script's pre-deploy DB snapshot, the deployed SHA, PM2 status,
   and `/healthz` (`status: ok`, expected `schema_version`) for each instance.
7. Do read-only smoke checks of every changed surface on each deployed
   instance. Verify rendered meaning, not merely 200.
8. Report commit SHA, deployed SHA per instance, health output, smoke
   evidence, and final local/origin state. Never call work shipped before
   these checks pass.
