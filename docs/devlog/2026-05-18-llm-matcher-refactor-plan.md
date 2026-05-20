# Plan — LLM Matcher Refactor (Dispatch audit, 2026-05-17; Codex review folded in 2026-05-18)

## Codex review (2026-05-18) — all 8 findings folded in

CC2 sent this plan to Codex via claude-relay. All 8 findings were
evaluated and accepted as valid; none were pushed back on. Material
changes from the prior version:

1. **Cache key rebuilt** (Codex #1) — versioned by mode + model +
   prompt_version + candidate IDs + person IDs + items fingerprint +
   recipient hint, not just `sha1(needle + titles)`.
2. **Shipment matching has an abstain state** (Codex #2) — LLM returns
   `safe_to_apply: bool`; uncertain verdicts hold sibling status, route
   the row to `disposition='review'`. The old "advance ALL" fallback
   is removed and NOT replaced with "LLM decides" — both are unsafe.
3. **Commit-time dedup tightened** (Codex #3) — recipient-only
   fallback dropped. Match by `order_pk + line_item_index` OR by
   deterministic item fingerprint (title+price+position); fail loudly
   otherwise.
4. **DB invariants added** (Codex #4) — partial unique index on
   active `(order_pk, line_item_index)`. Belt-and-suspenders against
   matcher bugs and double-commit races.
5. **LLM ranks a curated shortlist, not the universe** (Codex #5) —
   heuristic is repurposed from "STRONG-pass gate" to "top-20
   candidate ranker". Recipient-hint priority floats relevant gifts
   up. LLM never sees the full open-gift list.
6. **Decision contract enriched** (Codex #6) — model output is
   `{ matches[], unmatched_items[], confidence, safe_to_apply,
   reasons }` enforced via tool_use, not loose `{bestIndex, reason}`.
7. **Fixture regression corpus required** (Codex #7) — sanitized
   real-email fixtures with golden expectations land before any code
   in Wave 1. Becomes the primary regression suite; manual smoke is
   the secondary check.
8. **Diagram fixed** (Codex #8) — old "≥0.6, clear winner" text
   removed; new shortlist-then-LLM diagram matches the prose.

## Context

Dispatch's audit (`docs/devlog/2026-05-17-llm-matcher-audit.md`) confirms what the
user's testing surfaced today: the LLM is a vestigial second-opinion on a
narrow slice of weak heuristic results, not the actual matcher. The heuristic
in `gift-matcher.ts` does all real work; the LLM only sees title-only context,
only fires on weak heuristic hits, only runs when admin clicks a button, and
never participates in the highest-stakes path (`matchSiblingsToShipment` in
`orders.ts`, which mutates gift status on partial shipments).

The user has agreed the refactor is necessary. Cost is not a constraint
(≈$0.45/mo at full Sonnet pricing per the audit's estimate). Volume is dozens
of orders/month, not thousands — every match decision can afford an LLM call.

Two threads should be folded together while this area is open:

1. **The audit's R1–R7** — make the LLM the primary matcher with rich context,
   not a post-hoc reviewer.
2. **Task #10** — `commitMultiItemAccept` in `amazon-import.ts:646` doesn't
   dedupe against existing siblings before creating gifts. Surfaced in the
   user's screenshot earlier this session: a SHIPPED row for a multi-item
   order will silently create duplicates if the order_placed email was
   already committed. Same code path, same concern (matching commit-time
   intent against existing state), should ship in the same refactor.

## Approach

**Architecture shift (revised post-Codex review):** Heuristic is repurposed
from a pass/fail gate to a **candidate-shortlist ranker**. LLM is the
authoritative matcher BUT can return `uncertain` on the highest-stakes
paths (shipment matching), in which case the system holds state mutation
and queues the row for admin review rather than guessing. Both
email-to-gift match (amazon-import staging) and shipment-to-siblings
match (`matchSiblingsToShipment`) follow the same shape:

1. **Candidate generation** — narrow to a curated shortlist (≤20 by
   default). Per-pipeline filters below.
2. **Heuristic ranking** — score candidates, hand the LLM top-20 with
   their scores as a prior.
3. **LLM ranking + verdict** — returns structured output:
   `{ matches: [{ itemIndex, giftId | null, confidence }],
   unmatched_items: [...], safe_to_apply: bool, reasons: {...} }`.
4. **Policy gate** — `safe_to_apply == false` OR `confidence < threshold`
   on a shipment path → write the shipment record but DO NOT advance
   sibling status; mark the import row for review. Import-staging path
   is more permissive (verdict shown to admin who explicitly commits).

**Heuristic threshold (revised twice):** the old STRONG-pass-through path
is removed entirely. Per-Codex #5, "let the heuristic decide" was the
wrong instinct given we're paying for Opus. Heuristic is now purely a
ranker — it produces an ordered candidate list, never auto-accepts.
LLM always gets called on staged rows that have any plausible
candidates. (The escape-hatch optimization "skip LLM if there are zero
heuristic candidates" stays — no candidates means no match to confirm.)

**Candidate generation per pipeline:**
- **Import-time matching** (`amazon-import.ts`): open gifts (`status IN
  ('idea','planned')`, not archived) ranked by heuristic, top 20. If
  `parsed_order_id` already maps to a gift via `findGiftPersonByOrderId`,
  float that gift's recipient's gifts to the top of the shortlist.
- **Shipment matching** (`matchSiblingsToShipment`): only the order's
  siblings, no outside gifts. Heuristic ranks shipment-email items
  against siblings; LLM confirms / abstains.
- **Commit-time dedup**: deterministic only — no LLM. See Phase 3.

**Cache key (rebuilt per Codex #1):**
```
sha1(
  mode +                    // 'import' | 'shipment'
  model +                   // 'claude-opus-4-7'
  prompt_version +          // 'v1' bumps on prompt edits
  needle_normalized +
  candidate_ids_sorted +    // gift IDs, not titles
  candidate_person_ids_sorted +
  items_fingerprint +       // sha1 of normalized items[]
  recipient_hint_person_id  // 0 when no hint
)
```
A change in any input → new cache row. Old verdicts can't replay across
materially different situations.

```
┌──────────────────────────────────────────────────────────────────┐
│  amazon-import: stage email → narrow candidates → call LLM       │
│                                                                  │
│       ┌─────────────────────────────────────────┐                │
│  ────►│  Candidate generation                   │                │
│       │  (open gifts, recipient-hint priority,  │                │
│       │   top-20 by heuristic score)            │                │
│       └─────────────────────────────────────────┘                │
│                          │                                       │
│                          ▼ (shortlist of ≤20)                    │
│       ┌─────────────────────────────────────────┐                │
│       │  llm-matcher.ts (NEW)                   │                │
│       │  Input: enriched email context + curated│                │
│       │         shortlist + few-shot from       │                │
│       │         recent corrections              │                │
│       │  Output: { matches[], unmatched_items[],│                │
│       │           safe_to_apply, confidence,    │                │
│       │           reasons }  — tool_use enforced│                │
│       └─────────────────────────────────────────┘                │
│                          │                                       │
│                          ▼                                       │
│       Store verdict in import_rows.llm_verdict_json              │
│       Cache by versioned key (mode+model+prompt_version+...)     │
│       in matcher_llm_cache with expires_at = NOW + 7 days        │
└──────────────────────────────────────────────────────────────────┘
```

The page-load path is unchanged for cached cases — it reads
`import_rows.llm_verdict_json` (already populated at import time)
instead of running the heuristic blind.

`commitMultiItemAccept` and `applyLifecycleEvent` consume the SAME
verdict shape and respect `safe_to_apply` before mutating gift state.

## Phases

Restructured after user pushback: **shipping Phase 1 alone gives you a
review page with LLM verdict badges but no way to validate them without
committing rows — which mutates state irreversibly. Phases 4-5 don't
mutate, but they're not what you care about.** The honest unit of
"testable" is Phase 1 + 2 + 3 together: matcher + shipment matcher +
commit-time dedup. Below they're regrouped into two waves, each
end-to-end testable as a self-contained release. Phase numbers in
section headers preserve the audit mapping.

### Testing strategy (the key change)

Real test data in `Giftlist/Amazon/Inbox` is destroyed on commit (rows
become accepted; Gmail messages move to Processed). To avoid burning the
9 fresh emails the user wants to test against:

1. **Local dev DB snapshot before each test run.** `scripts/backup-sqlite.sh
   --local-only` writes `data/backup/gifttracker.db` via SQLite's online
   backup API. Restore is `cp` over the live DB with the dev server
   stopped. The backup script is idempotent and fast (<1s on this size).
2. **Local Gmail label snapshot, not real OAuth state.** Add a dev-only
   helper that re-stamps `Giftlist/Amazon/Processed` messages back to
   `Giftlist/Amazon/Inbox` via Gmail's `batchModify`. Re-runs every
   test iteration so the same 9 emails keep being fresh. (No prod
   surface; only documented in test instructions.)
3. **One real prod smoke after wave 1** ships locally: re-stage one
   email via the existing Re-split form (or a single Gmail label flip),
   verify behavior, commit the row, confirm no duplicate.

The pre-deploy script already creates a prod-side snapshot
(`data/backup/pre-deploy-<utc>.db`) so the rollback path is real if
needed: `ssh root@... → sqlite3 .restore` followed by `pm2 restart`.

### Wave 1 — Matcher refactor (Phases 1 + 2 + 3 combined)

Ships together because none of them is meaningfully testable on its own.
Single deploy, single rollback target if needed. All three touch the
same hot code path (`amazon-import.ts` import + commit) and have to
agree on the LLM context schema.

**Phase 1 — Enriched LLM-as-primary, auto-triggered at import (R1, R3, R5)**

- Enrich the prompt with full structured context (see R1 above).
- Call the LLM during `runAmazonScan`, immediately after staging each
  row whose heuristic confidence is not the new strict STRONG (score
  == 1.0, sole high-scoring candidate). Persist verdict on the row.
- Switch to `claude-opus-4-7` (user-confirmed model choice).
- Replace JSON-via-regex with API tool_use for enforced output shape.
- Keep the "Re-evaluate" button as a force-refresh-cache action.

**Phase 2 — LLM-assisted shipment matching with abstain (R4 + Codex #2)**

- Extend `matchSiblingsToShipment` to call the LLM when heuristic
  returns zero or ambiguous matches.
- **Critical safety addition (Codex #2):** LLM output includes
  `safe_to_apply: bool` and per-match `confidence`. When false or
  below threshold, the system:
  - Creates / updates the `order_shipments` row (tracking info is
    real data and should be preserved).
  - Attaches no gifts to the shipment.
  - Does NOT advance any sibling status.
  - Routes the import row to `disposition='review'` (the same review
    queue infra from td-3d1ee6) with the candidate verdict serialized
    so admin can resolve.
- Replaces the silent "advance ALL siblings" fallback at
  `amazon-import.ts:769` with: LLM verdict if confident, hold for
  review otherwise. **Removes the bad path; does not replace it with
  a different bad path** (per user's "rock solid" goal — Codex was
  right that "LLM decides" without an abstain state is just trading
  one wrong-answer source for another).
- Highest-stakes path in the whole audit: this is where wrong answers
  directly mutate gift status. Bias toward false negatives (hold for
  review) over false positives (advance wrongly).

**Phase 3 — Commit-time dedup (task #10, tightened per Codex #3+#4)**

Deterministic matching only — no LLM in this path. The user's earlier
choice ("refuse to commit; surface the conflict") is preserved and made
stricter:

- Match key: `order_pk + line_item_index` exact (deterministic).
- **Fallback removed (Codex #3):** the earlier "order_pk + chosen
  recipient with one un-consumed sibling" fallback is dropped. It
  failed when an order had 2 items for the same recipient or when
  Amazon reordered items between emails. Replacement: deterministic
  **item fingerprint** = `sha1(normalized_title + price_cents +
  line_item_index)`. Match by fingerprint when line_item_index alone
  doesn't agree. If neither matches, fail the row and require review.
- **DB-level invariant added (Codex #4):** new migration adds a
  partial unique index `CREATE UNIQUE INDEX gifts_order_lineitem_active
  ON gifts(order_pk, line_item_index) WHERE is_archived = 0 AND
  order_pk IS NOT NULL`. Even with perfect matcher logic, a double-
  commit race or retry CAN'T create duplicates — the DB rejects the
  second insert. Caller catches the unique-violation and routes to
  the existing failure path.
- **Transactional wrap:** `commitMultiItemAccept` runs inside
  `db.transaction(() => { ... })` so partial failure rolls back all
  sibling creates for the row.
- Recipient-mismatch conflict (existing sibling at line_item_index
  has different person_id than admin's pick): fail with explicit
  message — no silent override, no duplicate creation.
- Surfaces in UI: replace "Accept → create / advance gift" with two
  computed states per row: "Accept → advance N existing gifts" or
  "Accept → create N new gifts" (counted at load time against
  `parsed_order_id` siblings).

### Wave 2 — Refinements (Phases 4 + 5)

Non-mutating; ship after wave 1 has been live and observed.

**Phase 4 — Cache TTL + invalidation (R6)**

(Unchanged from prior plan — TTL column, sweep on existing weekly cron,
admin "Clear LLM cache" button on `/admin/system`, auto-invalidate on
admin override at commit time.)

**Phase 5 — Learn from admin corrections (R7)**

(Unchanged from prior plan — `matcher_corrections` table, append on
explicit `assignedGiftId` decisions, include last 5 as few-shot
examples in the system prompt.)

### Phase 1 — Enriched LLM as primary matcher, auto-triggered at import

- **R1** Enrich the prompt with: parsed title, email subject, **the full
  parsed line-item array** (already extracted into `parsed_items_json`
  by `amazon-parser.ts` — title + price per item, no truncation), parsed
  price, vendor, recipient name (Amazon's stripped name if any), parsed
  order id. For each candidate gift: title, person display name +
  relationship, occasion (resolved to "Birthday" / "Christmas 2026" /
  etc.), notes, current status. If the parser failed to extract items
  (rare — confirmation/marketing edge cases), include up to 4000 chars
  of the raw body as fallback. The 500-char limit from the audit was
  wrong: shipping notifications for 5+ items routinely run past that.
  Structured items beat a truncated body excerpt either way.
- **R3** Call the LLM during `runAmazonScan`, immediately after staging each
  row whose heuristic confidence is not STRONG. Persist the verdict on the
  `import_rows` row so the review page is synchronous.
- **R5** Switch to `claude-opus-4-7`. Reasoning-heavy ambiguous matching
  is Opus's strength; audit's volume estimate (~150 calls/month) puts
  full-Opus cost at roughly $5–10/mo — well within the "cost is not a
  constraint" envelope.
- Move prompt construction into a tool-use call so JSON parsing is
  enforced by the API, not by `parseDecision`'s tolerant regex.
- Keep the "Re-evaluate weak matches with AI" button — repurpose it to
  "Re-run AI matcher for this run" (force-refresh cache).
- Replace `matcher-llm.ts` with `llm-matcher.ts` (or rename in place). The
  existing module is small enough to rewrite cleanly; the new one will
  expose `llmMatchEmailToGift(row, openGifts, recentCorrections)` returning
  a `LlmMatchVerdict` shape that the review page already understands via
  `llmVerdict` (extend the existing field rather than invent a new one).

Schema:
- Migration `023-import-row-llm-verdict.sql`: add
  `import_rows.llm_verdict_json TEXT` (nullable). Caches the structured
  verdict the LLM returned so the review page doesn't need a synchronous
  cache lookup. Keeps `matcher_llm_cache` for the cross-row cache layer.

Critical files:
- `src/lib/server/llm-matcher.ts` (rewrite/replace `matcher-llm.ts`)
- `src/lib/server/gift-matcher.ts` (gate: only return STRONG; weak/none
  defers to LLM)
- `src/lib/server/jobs/amazon-import.ts:166-208` (post-parse, pre-insert:
  call the LLM, stash verdict in the insert)
- `src/routes/admin/imports/amazon/review/+page.server.ts:65-88` (read
  cached verdict instead of recomputing)
- `src/routes/admin/imports/amazon/review/+page.svelte:359-401` (no UI
  change beyond label tweaks — the badge story already works)

Reuse:
- `listGiftsForOrder` (`src/lib/server/orders.ts:107`) — but for the
  candidate pool we need ALL open gifts (idea/planned/ordered), not just
  one order's siblings. Extract a `listOpenGiftCandidates()` helper.
- `findGiftPersonByOrderId` (`amazon-import.ts:277`) stays for the
  recipient-hint flow.

### Phase 2 — LLM-assisted shipment matching (R4)

`matchSiblingsToShipment` in `orders.ts:260` currently does title overlap
only. Replace its fuzzy-match loop with: try heuristic first; if items
were enumerated but no fuzzy match landed (the warn case at
`amazon-import.ts:769`), call the LLM with siblings + shipment email body
+ items array and ask which siblings are in this shipment.

The current heuristic-only fallback ("advance ALL siblings") is the
behavior that causes the user's worry about duplicates and incorrect
status advancement. LLM-assisted matching here is the highest-leverage
fix in the whole audit.

Critical files:
- `src/lib/server/orders.ts:260-284` — extend signature with optional
  `shipmentBody` and `useLlm` flags.
- `src/lib/server/jobs/amazon-import.ts:759-775` — call the upgraded
  helper; remove the all-fallback when LLM is available (LLM verdict is
  authoritative for the no-match case).
- `src/lib/server/orders.test.ts` — add LLM-assisted cases (mock the
  fetch call).

### Phase 3 — Commit-time dedup (task #10)

`commitMultiItemAccept` in `amazon-import.ts:646-725` must look up
existing siblings before creating. Approach (after the user's choice
"Refuse to commit; surface the conflict"):

For each line item:
1. Find existing sibling by `order_pk + line_item_index` (exact match).
2. If found and `existing.person_id === li.assignedPersonId`: link
   (route through the existing link-branch at lines 674-700). Skip the
   create.
3. If found but `existing.person_id !== li.assignedPersonId`: surface the
   conflict — mark the row `disposition='failed'` with
   `error_message='Recipient mismatch: line item N existing gift Y was
   created for person A; you chose person B. Resolve via the gift edit
   page before committing.'`. No silent override.
4. If no sibling at this `line_item_index` but `order_pk` has siblings AND
   exactly one un-consumed sibling has matching `person_id`: link to it
   (Amazon may reorder items between order_placed and shipped emails).
5. Otherwise: create new (current behavior).

Critical files:
- `src/lib/server/jobs/amazon-import.ts:646-725` — patch
  `commitMultiItemAccept`.
- `src/lib/server/jobs/amazon-import.test.ts` (new) — unit-test the four
  branches: exact-index match, recipient mismatch, recipient
  disambiguation, no existing gifts.

UI ergonomics:
- The review page's "Accept → create / advance gift" radio label is
  confusing. Replace with two states determined at load time per row:
  "Accept → advance N existing gifts" or "Accept → create N new gifts"
  (count derived from sibling lookup against `parsed_order_id`).

### Phase 4 — Cache TTL + invalidation (R6)

- Migration `024-matcher-cache-expires.sql`: add
  `matcher_llm_cache.expires_at TEXT` (default `datetime('now', '+7
  days')`). Add an index.
- Cache reads filter `expires_at > CURRENT_TIMESTAMP`.
- Cleanup cron: extend the existing weekly `amazon.cleanup_processed`
  hook (`scheduler.ts`) to also `DELETE FROM matcher_llm_cache WHERE
  expires_at <= CURRENT_TIMESTAMP`. Cheap, sweep ad-hoc on the same
  schedule.
- Admin UI: add a "Clear LLM cache" button on `/admin/system` (next to
  "Run reminders now"). Hits a new `?/clearLlmCache` action.
- Auto-invalidate on admin override: when `commitReviewedRows` sees a
  decision with explicit `assignedGiftId` that differs from the LLM's
  verdict, delete the cache row for that (email title, candidate set).
  Implemented inline in the commit loop, no separate trigger.

Critical files:
- `src/lib/server/matcher-llm-cache.ts` (new) — extract the cache CRUD
  out of `llm-matcher.ts` so the cron + admin UI can share it.
- `src/routes/admin/system/+page.{server.ts,svelte}` — new action.
- `src/lib/server/scheduler.ts` — sweep hook.

### Phase 5 — Learn from admin corrections (R7)

- Migration `025-matcher-corrections.sql`: new table
  `matcher_corrections (id, source_email_title, source_email_subject,
  chosen_gift_id, chosen_gift_title, chosen_person_id,
  chosen_person_name, action, created_at)`.
- Hook: every commit decision with an explicit `assignedGiftId` or
  override of LLM verdict appends a row.
- Inclusion: when `llm-matcher.ts` builds the system prompt, fetch the
  last 5 corrections by `created_at DESC` and inline them as few-shot
  examples. Keeps the prompt under the audit's 800-token estimate.

Critical files:
- `src/lib/server/matcher-corrections.ts` (new) — append + recent reader.
- `src/lib/server/llm-matcher.ts` — read recent corrections, include in
  prompt.
- `src/lib/server/jobs/amazon-import.ts` — append on commit path with
  explicit overrides.

## LLM decision contract (added per Codex #6)

The LLM is called via Anthropic tool_use with a single tool whose
input_schema enforces:

```ts
interface LlmMatchVerdict {
  /** Per-item match decision. One entry per email line item. */
  matches: Array<{
    itemIndex: number;
    giftId: number | null;     // null = no candidate matches
    confidence: 'high' | 'medium' | 'low';
    reason: string;            // one sentence
  }>;
  /** Items the model could not place. Indices into the email's items[]. */
  unmatched_items: number[];
  /**
   * Whether the caller should auto-apply this verdict to mutate state.
   * false on the shipment path = create shipment row, do not advance
   * siblings, queue row for admin review. Always false when ANY match
   * has confidence='low' or unmatched_items is non-empty on a shipment
   * call.
   */
  safe_to_apply: boolean;
  /** Overall reasoning summary. */
  summary: string;
}
```

Policy gates (in caller, not in prompt):

| Path | `safe_to_apply` false | Any match `confidence='low'` |
|---|---|---|
| Import (staging) | Show verdict on review page; admin commits | Same — admin in the loop |
| Commit-time dedup | N/A (no LLM in this path) | N/A |
| Shipment matching | Create shipment, hold siblings, queue review | Create shipment, hold siblings, queue review |

The asymmetry is deliberate: the import path is always admin-gated
(admin clicks Commit), so the LLM can be more permissive. The
shipment path mutates gift status as a side effect of admin
committing a shipped-email row, so the LLM must abstain on
ambiguity.

## Open design decisions (resolved or to-confirm)

Resolved during planning:
- Heuristic role: ranker that produces top-20 shortlist, not a pass/fail
  gate. LLM always called on staged rows with plausible candidates.
  (Revised after Codex #5 — original "STRONG bypasses LLM" idea
  reversed.)
- Body context: send the full structured `parsed_items_json` array,
  fall back to up to 4000 chars of raw body only if items parsing
  failed. (Audit's 500-char limit rejected by user.)
- Phase grouping: 1+2+3 ship as Wave 1 (testable as a unit); 4+5
  ship as Wave 2 (non-mutating). (User pushback on shipping
  un-testable partial phases.)
- Model: `claude-opus-4-7`. (User-confirmed.)
- Caching: versioned key with full context (mode + model +
  prompt_version + candidate IDs + person IDs + items fingerprint +
  recipient hint) + TTL + manual invalidation. (Codex #1.)
- Shipment-match safety: LLM returns `safe_to_apply`; uncertain
  verdicts hold sibling status and route the row to review. No
  "advance all" fallback, no "LLM rubber-stamps". (Codex #2.)
- Commit dedup keys: `order_pk + line_item_index` OR item
  fingerprint; recipient-only fallback dropped. DB enforces unique
  index. (Codex #3 + #4.)
- Conflict on recipient mismatch in `commitMultiItemAccept`: surface
  and refuse. (User's explicit choice earlier this session.)

To confirm before Wave 1 ships:
- Should the LLM also see the *currently chosen recipient* on the review
  row, or only the auto-matched one? (Tradeoff: more context vs. risk of
  the LLM rubber-stamping a wrong human pick.) Default: include
  `match_person_id` but not admin overrides.
- The "few-shot from corrections" (Wave 2) includes person names. If the
  user ever sanitizes the DB / hands the project off, those leak via the
  prompt. Acceptable in single-admin scope? Default: yes; flag in
  prompt as "internal-only context".

## Verification

### Wave 1 (Phases 1+2+3) — done locally before any prod deploy

**Fixture regression corpus (added per Codex #7):** before any code in
Wave 1 lands, build `tests/fixtures/amazon/` with sanitized real
Amazon emails covering:

- `order_placed_multi_item.eml` — 3+ items, 2+ recipients
- `shipped_partial.eml` — covers items 1+3 of a 4-item order
- `shipped_no_item_enumeration.eml` — email body lacks the items list
- `delivered_full.eml` — shipping notification for all items
- `delivered_no_items.eml` — delivery confirmation without enumeration
- `shipped_reordered_items.eml` — Amazon listed items in a different
  order than the order_placed email
- `duplicate_titles.eml` — order with 2 identical-title items at
  different line indexes
- `same_recipient_multiple_items.eml` — 3 items all going to one person
- `conflicting_override.eml` — admin-pick differs from existing
  sibling's recipient

Pull from `~/giftlist/data/` (test DBs) or scrub real samples in
`Giftlist/Amazon/Processed`. Sanitize PII (replace names/addresses
with fixtures).

Each fixture has a paired `expected.json` with the canonical decision:
which gifts created, which advanced, which rows flagged `review`,
which fail with conflict. The unit suite parses fixtures and runs the
full import + commit pipeline against an in-memory SQLite — no Gmail,
no Anthropic API (mocked).

This is now the primary regression suite. Manual smoke is the
secondary check, not the primary one.

Pre-test setup for end-to-end smoke (one-time per iteration):
1. `./scripts/backup-sqlite.sh --local-only` — snapshot local dev DB.
2. Helper script `scripts/dev-relabel-amazon.ts` (NEW, dev-only):
   move all messages in `Giftlist/Amazon/Processed` back to
   `Giftlist/Amazon/Inbox` so the 9 test emails are fresh each
   iteration. Uses the same Gmail OAuth tokens already in dev DB.
3. `npm run dev` against the restored DB.

Test loop:
1. Sign in as admin → `/admin/imports/amazon` → Scan now.
2. Verify staged rows show LLM verdict badges immediately (no admin
   button required). Read `console.log` and the `llm_verdict_json`
   column to confirm Opus was called with the rich prompt.
3. For a multi-item order: pick recipients in the per-line-item
   pickers → click Commit selected → verify the right gifts are
   created (no duplicates against pre-existing siblings if any).
4. For a shipment row: commit it → verify only the matching siblings
   advance status, not all of them.
5. Deliberately mismatch a recipient on a shipped row that has
   existing order_placed siblings → verify the row fails with the
   conflict message instead of silently duplicating.
6. If anything's wrong: restore DB snapshot, relabel Gmail, iterate.

Static checks: `npm run check` (0 warnings), `npm test` (currently 73
green; add cases for the four new commit-dedup branches + the LLM
shipment-match fallback + the new STRONG threshold).

Prod smoke (after local passes):
- `./scripts/deploy-to-DO.sh` (it snapshots the prod DB pre-deploy).
- Re-stage one email via the Re-split form to get a fresh test row in
  prod without touching the rest of the inbox.
- Commit that row, watch behavior, confirm no duplicate created.
- If anything looks off in prod, the deploy script's
  `pre-deploy-<utc>.db` snapshot is the rollback target —
  `ssh root@... && sqlite3 ... .restore /path/to/snapshot && pm2 restart`.

### Wave 2 (Phases 4+5) — small, can rely on unit tests + console

- Phase 4: insert a cache row with `expires_at = datetime('now',
  '-1 day')` → verify miss + recomputation; click "Clear LLM cache"
  in admin UI → verify table empty.
- Phase 5: commit a decision that overrides an LLM verdict → verify
  `matcher_corrections` row appended → next LLM call's mocked-fetch
  body contains that example as a few-shot.

## Critical files (consolidated)

| Concern | File |
|---|---|
| Rewritten LLM matcher (rich context, tool-use, Sonnet) | `src/lib/server/llm-matcher.ts` (replaces `matcher-llm.ts`) |
| Heuristic gated to STRONG-only | `src/lib/server/gift-matcher.ts` |
| Auto-trigger at import | `src/lib/server/jobs/amazon-import.ts:100-260` |
| Verdict storage | Migration `023-import-row-llm-verdict.sql`, `import_rows.llm_verdict_json` |
| Shipment-match LLM assist | `src/lib/server/orders.ts:260-284`, `src/lib/server/jobs/amazon-import.ts:759-775` |
| Commit-time dedup | `src/lib/server/jobs/amazon-import.ts:646-725` |
| Cache CRUD + TTL | `src/lib/server/matcher-llm-cache.ts` (new), migration `024-matcher-cache-expires.sql` |
| Cache cleanup cron | `src/lib/server/scheduler.ts` |
| Corrections log | `src/lib/server/matcher-corrections.ts` (new), migration `025-matcher-corrections.sql` |
| Review UI label cleanup ("advance N existing" vs "create N new") | `src/routes/admin/imports/amazon/review/+page.svelte`, `+page.server.ts` |
| Admin "clear LLM cache" | `src/routes/admin/system/+page.{server.ts,svelte}` |

## Reused utilities

- `listGiftsForOrder` — `src/lib/server/orders.ts:107`
- `matchSiblingsToShipment` — `src/lib/server/orders.ts:260` (extended)
- `findGiftPersonByOrderId` — `src/lib/server/jobs/amazon-import.ts:277`
- `commitReviewedRows` framework — `src/lib/server/jobs/amazon-import.ts:361`
  (no signature change; per-decision logic patched)
- `logAudit` — `src/lib/server/audit.ts:23`
- Schema migration runner (FK-toggle pattern) — `src/lib/server/migrate.ts`
- `claude-api` skill (in user's `~/.claude/skills/`) — reference for
  Sonnet prompt construction with caching enabled.

## Out of scope

- Tracking-import path (`jobs/tracking-import.ts`) keeps its own
  order_id-based matching for now. It doesn't fuzzy-match titles
  (carriers don't send item-level data), so the LLM has nothing to
  consume there. Revisit only if a real-world miss surfaces.
- Personal-package (non-gift) flow.
- Replacing the heuristic entirely. Even with LLM as primary, the
  STRONG-match heuristic shortcut saves ≈80% of API calls on clean
  Amazon emails where titles match cleanly.
