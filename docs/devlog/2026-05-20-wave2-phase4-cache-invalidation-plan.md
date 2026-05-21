# Wave 2 Phase 4 — LLM matcher cache TTL sweep + invalidation (plan)

**Status:** planned, not started. Tracked in `td` (Phase 4, P1).
**Prereq:** Wave 1 shipped (commit `4a43a8c`, schema v26, live in prod 2026-05-20).
**Audit origin:** R6 in `docs/devlog/2026-05-17-llm-matcher-audit.md`.

## Context / why

The `matcher_llm_cache` table stores Opus 4.7 verdicts keyed by a
versioned context hash (mode + model + prompt_version + candidate ids +
person ids + items fingerprint + body hash + sibling-status for
shipment mode). It prevents re-billing the API for identical re-runs.

Two gaps remain after Wave 1:

1. **Stale verdicts only expire passively.** Migration 024 added
   `expires_at` (7-day TTL) and cache reads already filter
   `WHERE expires_at > CURRENT_TIMESTAMP`, so stale rows are *ignored*
   on read. But they're never deleted, so the table grows unbounded.

2. **No active invalidation.** If the admin corrects a match the LLM
   got wrong (commits with a different gift than the LLM picked), the
   wrong verdict stays cached and replays for up to 7 days. The admin
   sees the AI "keep suggesting the wrong thing even after I fixed it."
   This is the most user-visible gap and the highest-value piece of
   Phase 4.

Phase 4 is **non-mutating** (no gift state changes) — it only adds
cache maintenance + a manual control.

## What's already in place from Wave 1 (do NOT rebuild)

- `matcher_llm_cache` table with `cache_key` PK, `mode`, `model`,
  `prompt_version`, `response`, `created_at`, `expires_at`
  (migration 024). `expires_at` defaults to `datetime(now, '+7 days')`.
- `sweepExpiredCache()` already exists in `src/lib/server/llm-matcher.ts`
  — `DELETE FROM matcher_llm_cache WHERE expires_at <= CURRENT_TIMESTAMP`,
  returns `info.changes`. **It just isn't called from anywhere yet.**
- Cache reads (`readCache`) already filter on `expires_at`.

## Scope — three deliverables

### 4a. Sweep cron (wire up the existing `sweepExpiredCache`)

`sweepExpiredCache()` exists but is dead code. Call it from the weekly
cleanup cron so the table doesn't grow forever.

- File: `src/lib/server/scheduler.ts` — find where `amazon.cleanup_processed`
  (`AMAZON_CLEANUP_CRON`, default `15 3 * * 0`) is registered.
- Either fold a `sweepExpiredCache()` call into that job's handler, or
  register a tiny new job `matcher_cache.sweep` on the same Sunday
  cadence. Prefer folding in — one fewer job row in `job_runs`.
- Log the deleted-count via the existing job-run summary mechanism.
- The job handler lives in `src/lib/server/jobs/`. Check how
  `amazon.cleanup_processed` is implemented (likely `amazon-import.ts`
  `trashMessagesUnderLabel` path or a dedicated cleanup job) and add
  the sweep alongside it.

### 4b. Admin "Clear LLM cache" button on /admin/system

A manual nuke for when the admin knows they've changed the gift list
and wants fresh verdicts immediately instead of waiting out the TTL.

- New helper in `src/lib/server/llm-matcher.ts` (or a new
  `matcher-llm-cache.ts` if we want the CRUD isolated — the plan
  originally suggested extracting, but `llm-matcher.ts` is small enough
  that a `clearAllCache(): number` export there is fine):
  `DELETE FROM matcher_llm_cache` returning `info.changes`.
- Server action: `src/routes/admin/system/+page.server.ts` — add a
  `?/clearLlmCache` action that calls it, audit-logs the count, and
  redirects with a flash count.
- UI: `src/routes/admin/system/+page.svelte` — add a card/button next
  to the existing "Run reminders now" / "Run backup now" buttons.
  Show the current cache row count (a `SELECT COUNT(*)` in the page
  load) so the admin sees what they're clearing. Confirm-on-click is
  nice-to-have but not required (it's non-destructive to gift data).

### 4c. Auto-invalidate on admin override (the high-value one)

When the admin commits a row and picks a *different* gift than the LLM
chose (or picks "create new" when the LLM picked an existing gift),
delete that row's cache entry so the next scan re-evaluates instead of
replaying the now-known-wrong verdict.

**Design — store the cache key on the verdict so invalidation is trivial:**

1. Add `cache_key: string` to the `LlmMatchVerdict` interface in
   `src/lib/server/llm-matcher.ts`. Populate it in both
   `llmMatchImportRow` and `llmMatchShipment` (they already compute the
   key — just thread it into the returned object). This makes the key
   travel with the persisted `import_rows.llm_verdict_json`, so the
   commit path can invalidate without recomputing the whole
   `ImportMatchInput`.
   - Bump `PROMPT_VERSION` is NOT needed — adding a field to the
     response shape is backward-compatible (old cached rows without
     `cache_key` just won't be auto-invalidated; they expire on TTL).

2. New helper: `invalidateCacheKey(cacheKey: string): void` in
   `llm-matcher.ts` — `DELETE FROM matcher_llm_cache WHERE cache_key = ?`.

3. In `commitReviewedRows` (`src/lib/server/jobs/amazon-import.ts`),
   detect override and invalidate:
   - Parse the row's persisted `llm_verdict_json` (if present) to get
     `cache_key` + the LLM's per-item `matches[].giftId`.
   - **Single-item path:** override = `d.assignedGiftId` (or the
     resolved gift) differs from the LLM's `matches[0].giftId`.
   - **Multi-item path:** override = any `lineItem.assignedGiftId`
     differs from the corresponding `matches[itemIndex].giftId`.
   - Also count "admin picked create-new but LLM picked an existing
     gift" and "admin linked a gift but LLM picked none" as overrides.
   - On override, call `invalidateCacheKey(verdict.cache_key)`.
   - Do this AFTER the gift mutation succeeds (don't invalidate on a
     row that failed to commit).

**Why store-the-key beats recompute:** the commit path doesn't have the
candidate shortlist that was fed to the matcher (it was built at scan
time from then-current open gifts). Recomputing the key at commit time
would need to rebuild that exact shortlist, which may have changed.
Storing the key at generation time sidesteps the whole problem.

**Edge:** if `verdict.cache_key` is absent (pre-Phase-4 cached rows),
skip invalidation silently — the TTL still covers it.

## Files touched (summary)

| Concern | File |
|---|---|
| `sweepExpiredCache` (exists), new `clearAllCache`, `invalidateCacheKey`, `cache_key` on verdict | `src/lib/server/llm-matcher.ts` |
| Sweep cron wiring | `src/lib/server/scheduler.ts` + the cleanup job in `src/lib/server/jobs/` |
| Override detection + invalidation | `src/lib/server/jobs/amazon-import.ts` (`commitReviewedRows`) |
| Clear-cache action + button + count | `src/routes/admin/system/+page.{server.ts,svelte}` |

No migration needed — schema is already correct from Wave 1.

## Verification

- **4a sweep:** insert a cache row with `expires_at = datetime('now',
  '-1 day')`, run the cleanup job (or call the handler directly in a
  test), assert the row is gone and the job summary reports the count.
- **4b clear button:** unit-test `clearAllCache()` against the in-memory
  test harness (`src/lib/server/test-harness.ts`); seed N cache rows,
  call it, assert 0 remain and it returns N. Manual: click the button
  in dev, confirm the count flash.
- **4c auto-invalidate:** the meatiest test. Using the fixture harness:
  1. Seed an import row with a `llm_verdict_json` whose `matches[0].giftId`
     points at gift A and carries a known `cache_key`.
  2. Pre-seed a `matcher_llm_cache` row at that `cache_key`.
  3. Commit the row with `assignedGiftId = gift B` (override).
  4. Assert the cache row at that key is deleted.
  5. Negative case: commit with `assignedGiftId = gift A` (agreement) →
     cache row survives.
- `npm run check` 0 warnings, `npm test` green, `npm run build` clean.
- Deploy via `./scripts/deploy-to-DO.sh` (no migration, so no prod data
  risk — pure code + a new dead-code-now-live cron).

## Out of scope (stays in Phase 5 or later)

- `matcher_corrections` table + few-shot learning — that's Phase 5 (P2).
  Note: auto-invalidate (4c) and correction-learning (5) both trigger on
  the same "admin override" signal. When building Phase 5, the override
  detection from 4c can be reused to ALSO append a correction row — keep
  the detection logic factored so Phase 5 can hook it.
- Plural recipient hints, lifecycle-skip force-advance, `fetchEnrichedGift`
  query batching — noted in the 2026-05-19 devlog follow-ups, not Phase 4.
