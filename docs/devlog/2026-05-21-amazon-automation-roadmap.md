# Amazon import automation roadmap (Phase 4 → Auto-accept → Phase 5)

**Status:** planned 2026-05-21, coding in progress. Reference for the
three remaining matcher tasks, to be shipped together (~1 day) so the
project can "run itself."

## Context

The Amazon import pipeline already auto-scans daily, auto-matches with
Opus, auto-files noise to Processed, and (as of 2026-05-21) drops
recurring non-gift items via exclusion keywords (td-8360f4). The remaining
manual bottleneck is the **review → commit** step — every staged row waits
for a human Commit. Goal (Gaylon's north star): make the app do the rest
automatically so he's not a full-time Amazon-mail monitor. Madonna is
settling into the Manager role; cutting the admin's daily upkeep is a
genuine quality-of-life win.

Three open tasks share one spine, so they build in order:

| Task | Pri | Needs |
|---|---|---|
| td-27f36d — Phase 4: cache sweep + invalidation | P1 | **override-detection** + `cache_key` on the verdict |
| td-dbaa0c — Auto-accept high-confidence matches | P1 | per-match **confidence** + clean recipient + Wave 1 safety |
| td-4bfb59 — Phase 5: learn from corrections | P2 | the **same override-detection** signal → corrections table |

**The shared spine** is one helper — "did the admin's commit disagree with
the LLM's pick?" — with three consumers: Phase 4 invalidates the stale
cache entry, Phase 5 appends a correction example, and Auto-accept's *undo*
path feeds both. Build it once in a new
`src/lib/server/matcher-feedback.ts` rather than scattering it through
`commitReviewedRows`.

**Two coupling facts that drive the ordering:**
- Auto-accept must NOT trust a stale cache — a wrong cached verdict would
  auto-commit the same mistake for 7 days. Phase 4's invalidation (4c) is a
  genuine safety prerequisite. → **Phase 4 first.**
- Auto-accept's mistakes surface as an *undo* (admin archives /
  re-transitions a wrongly auto-accepted gift), away from the commit path.
  That undo must route through the same `detectOverride` signal, or the
  system learns from manual overrides but stays blind to its own automatic
  errors.

## Current state (verified — do NOT rebuild)

- `LlmMatchVerdict` (`src/lib/server/llm-matcher.ts:53`): `matches: [{itemIndex, giftId|null, confidence:'high'|'medium'|'low', reason}]`, `unmatched_items`, `safe_to_apply`, `summary`, `model`, `prompt_version`, `created_at`. **No row-level confidence** — gate on every match being `high`. **No `cache_key` field yet.**
- `importCacheKey` / `shipmentCacheKey` (`llm-matcher.ts:228`,`:258`) compute the key at verdict-gen time but it isn't stored in the verdict.
- `sweepExpiredCache()` (`llm-matcher.ts:554`) exists, exported, **never called**. No `clearAllCache()` yet. `readCache` filters `expires_at > CURRENT_TIMESTAMP`; `writeCache` sets `+7 days`. Table `matcher_llm_cache` (mig 024): `cache_key` PK, `mode`, `model`, `prompt_version`, `response`, `created_at`, `expires_at`.
- Corrections plumbing **already wired** (Wave 1): `MatcherCorrection {emailTitle, giftTitle, personDisplayName}` (`llm-matcher.ts:91`), rendered in `buildImportUserMessage` (`:382`) and `buildShipmentUserMessage` (`:434`); every caller passes `corrections: []` (`amazon-import.ts:241`, `shipment-decider.ts:105`). Phase 5 only needs a data source.
- `commitReviewedRows(userId, decisions)` (`amazon-import.ts:625`): `CommitRowInput {rowId, action:'accept'|'skip', assignedPersonId?, assignedGiftId?, saveAsAlias?, lineItems?:[{lineItemIndex, assignedPersonId, assignedGiftId?}]}`. The row is re-fetched in the accept loop but its `llm_verdict_json` is **never compared** to the admin pick today — that's the override hook.
- `runAmazonScan` (`amazon-import.ts:101`) Phase-3 insert ends ~`:309`, before `setRunStatus('ready_for_review')` and the auto-skip label move — the auto-accept hook point.
- Scheduler pattern (`scheduler.ts:78`): `expr(envKey, default)` + `cron.schedule`, gated by `ENABLE_CRON=true && NODE_ENV=production`.
- Review actions (`review/+page.server.ts`): commit, skipAll, reevaluateMatches, retryFailedByOrder, reassign, resolveHeld, excludeItem. Confidence badges already render per match in `+page.svelte`.
- Admin/system action pattern (`admin/system/+page.server.ts:77` runBackupNow) for the clear-cache button.
- Reversibility: `archiveGift(id, archived, actorUserId)` (`gifts.ts:308`), `transitionGift`/`canTransition` (`gift-status.ts`), `logAudit` (`audit.ts:23`).

---

## Phase A — Phase 4: cache sweep + invalidation + the shared spine (td-27f36d)

Non-mutating to gift data; lays the keystone. Prior detail:
`docs/devlog/2026-05-20-wave2-phase4-cache-invalidation-plan.md`.

- **New `src/lib/server/matcher-feedback.ts`** — the spine:
  - `detectOverride(row, decision): OverrideEvent | null` → `{ rowId, cacheKey, action: 'override'|'fill-in'|'reject'|'agree', items:[{itemIndex, llmGiftId, adminGiftId}] }`. Parses `row.llm_verdict_json`, compares per-item LLM `matches[i].giftId` to the admin's `assignedGiftId` / `lineItems[i].assignedGiftId` (plus "create-new vs LLM-picked-existing", "linked vs LLM-picked-none"). Single + multi-item.
  - `invalidateCacheKey(cacheKey)` → `DELETE FROM matcher_llm_cache WHERE cache_key = ?`.
  - `clearAllCache(): number`; re-export `sweepExpiredCache()`.
- **4c — thread `cache_key` onto the verdict**: add `cache_key: string` to `LlmMatchVerdict`; populate in `llmMatchImportRow`/`llmMatchShipment` (they already compute it). Backward-compatible — old cached rows lack it, fall through to TTL. Lets invalidation work without rebuilding the candidate shortlist.
- **4a — sweep cron**: call `sweepExpiredCache()` from weekly `amazon.cleanup_processed` (`scheduler.ts`); log deleted count.
- **4b — admin "Clear LLM cache"**: `?/clearLlmCache` action (mirror `runBackupNow`) + card/button + `SELECT COUNT(*)` in the load.
- **Wire invalidation**: in `commitReviewedRows`, after a successful gift mutation: `const ev = detectOverride(row, d); if (ev && ev.action !== 'agree') invalidateCacheKey(ev.cacheKey)`.

Files: `matcher-feedback.ts` (new), `llm-matcher.ts`, `jobs/amazon-import.ts`, `scheduler.ts`, `admin/system/+page.{server.ts,svelte}`. No migration.

Verify: harness tests for `detectOverride` (override/fill-in/reject/agree, single + multi), `invalidateCacheKey`, `clearAllCache`; sweep deletes an expired row; manual clear-cache flash. check/test/build clean.

## Phase B — Auto-accept high-confidence matches (td-dbaa0c)

Depends on Phase A. Ship in two steps so trust is earned first.

- **Gate** — `isAutoAcceptable(row): AutoAcceptDecision | null` in `matcher-feedback.ts`. Auto-acceptable iff ALL: every non-excluded item's `matches[i].confidence === 'high'` with non-null `giftId` (or a confident "create new"); single unambiguous recipient (hint/order-id agree); not a shipment row the shipment-decider abstained on (respect `safe_to_apply` — never auto-advance held status); Wave 1 dedup remains the backstop.
- **B1 — manual "Commit all high-confidence" button**: `?/commitHighConfidence` action builds `CommitRowInput[]` from auto-acceptable rows → existing `commitReviewedRows`. Button in the review batch toolbar showing the count. Lets Gaylon one-click + watch hit-rate.
- **B2 — automatic in the daily scan**: after Phase-3 insert in `runAmazonScan` (before `ready_for_review` + label move), `autoAcceptHighConfidenceRows(runId, userId)` → decisions → `commitReviewedRows` → fold committed message-ids into the label move. Behind an **admin toggle** (`app_state` flag, default off until B1 trusted). Audit `amazon_auto_accept` per row.
- **Reversibility + visibility**: undo via `archiveGift` / back-`transitionGift`, routed through `detectOverride`. Surface auto-accepts via commit flash + audit/digest line so they're never invisible.

Files: `matcher-feedback.ts`, `jobs/amazon-import.ts`, `review/+page.{server.ts,svelte}`, `admin/system/*` (toggle), `app_state` flag (no migration — K/V).

Verify: harness — high-confidence unambiguous order auto-accepts; low/medium/mixed/shipment-abstain stay pending; zero duplicates/mis-files; undo emits an override event. Live dev smoke (button first), then toggle the cron path.

## Phase C — Phase 5: learn from corrections (td-4bfb59)

Depends on Phase A. Smallest — prompt slot already built.

- **5a — migration** `028-matcher-corrections.sql`: `matcher_corrections (id, source_email_title, source_email_subject, chosen_gift_id, chosen_gift_title, chosen_person_id, chosen_person_name, action, created_at)`.
- **5b — append**: in `commitReviewedRows`, when `detectOverride` returns non-`agree`, append a `matcher_corrections` row (same call site as Phase-4 invalidation). Auto-accept undo appends too.
- **5c — read-recent**: `listRecentCorrections(5)` → `MatcherCorrection[]` → into the already-rendered slot (replace `[]` at `amazon-import.ts:241`, `shipment-decider.ts:105`). Prompt < ~800 tokens; names internal-only (note already present).

Files: `migrations/028-matcher-corrections.sql` (new), `matcher-corrections.ts` (new), `matcher-feedback.ts`, `jobs/amazon-import.ts`, `shipment-decider.ts`.

Verify: harness — override commit appends a correction; prompt-build test asserts last-5 corrections render. check/test/build clean.

---

## Deploy

Each phase deploys via `./scripts/deploy-to-DO.sh` (pre-deploy DB
snapshot). A & B add no migration; C adds mig 028 (additive). Cadence:
A + B1 together → watch a few days → flip B2 (cron) → C last.

## Out of scope / decide-while-coding
- Whether auto-accept covers self/personal packages as well as gifts.
- Auto-accept digest channel (Telegram/email exist) vs. audit-log + flash only.
- Tracking-importer auto-accept (no item titles to match) — not in this roadmap.
