# LLM Matcher Audit — May 17, 2026

## Current State

The LLM (Haiku) is a post-hoc second opinion on a narrow slice of cases, not the primary matcher. The token-overlap heuristic in `gift-matcher.ts` does all the heavy lifting. The LLM is only consulted when the heuristic returns a "weak" confidence (score 0.3–0.6). Strong matches and misses bypass it entirely.

## Problem 1: Title-Only Context

The LLM prompt in `matcher-llm.ts:113-128` sends only the parsed email title and candidate gift titles. It does NOT see:

- Recipient/person name (e.g., "for Benjamin")
- Occasion (birthday, Christmas)
- Gift notes the admin wrote
- Email subject line or body
- Vendor, price, order ID
- Other gifts on the same order
- Shipping address

This is like asking someone to match packages to people while blindfolded. The heuristic is doing token overlap on titles — the LLM should be doing semantic matching with full context.

## Problem 2: LLM Only Fires on Weak Heuristic Results

The LLM cannot recover from heuristic MISSES. If the heuristic returns `none` (anchor gate failed or no token overlap), the LLM is never asked. Example: gift titled "Phone charging cables for Mom" will never match Amazon title "Anker 4-Pack USB-C to Lightning Cable 6ft MFi Certified" because there's zero token overlap. But a human (or an LLM with context) would match it instantly.

## Problem 3: Manual Trigger Only

The LLM only runs when the admin clicks "Re-evaluate weak matches with AI" on the review page. Despite devlog mentions of import-time evaluation, there is no LLM call in `jobs/amazon-import.ts`. Fresh review pages show heuristic-only results.

## Problem 4: Most Consequential Matching Has No LLM

`matchSiblingsToShipment()` in `orders.ts` — which decides which gifts to advance to shipped/delivered when a partial shipment arrives — is pure heuristic. This is the path where wrong answers directly mutate gift status. No LLM involvement at all.

## Problem 5: No System Prompt, No Examples

The prompt is zero-shot with no system message. No few-shot examples of tricky matches. No structured output enforcement beyond "respond with strict JSON." The instruction to "when in doubt, return null" biases toward false negatives.

## Problem 6: Cache Persistence of Bad Verdicts

The SHA1-keyed cache in `matcher_llm_cache` stores wrong answers permanently. There's no TTL, no manual invalidation UI, no way to retrain from admin corrections.

---

## Recommendations (for Claude Code implementation)

### R1: Enrich the LLM prompt with full context

Pass to the LLM:

- Parsed email title (already present)
- Candidate gift titles (already present)
- **NEW: Recipient name for each candidate** (from the people join)
- **NEW: Occasion** (birthday, Christmas, etc.)
- **NEW: Gift notes** (admin's free-text description)
- **NEW: Email subject line** (often contains "Your Amazon.com order of..." with item names)
- **NEW: Email body snippet** (first 500 chars — often has item details the title truncates)
- **NEW: Price** (if parsed from email)
- **NEW: Other gifts for the same person** (context for "is this plausibly a gift for this person?")

Update the prompt to be a system+user message pair. Add 2-3 few-shot examples of tricky matches (brand-name mismatch, generic title, multi-item order). Use structured output or tool_use for reliable JSON parsing.

### R2: Run LLM on ALL unmatched imports, not just weak heuristic results

After the heuristic runs, if confidence is `none` or `weak`, invoke the LLM with the FULL candidate pool (not just the heuristic's top-5). The LLM's semantic understanding can find matches the token-overlap heuristic fundamentally cannot. The heuristic is a fast pre-filter for strong matches; the LLM is the real matcher for everything else.

### R3: Auto-trigger LLM at import time

Call the LLM during `jobs/amazon-import.ts` after staging each row, not only when the admin clicks a button. The review page should show LLM verdicts immediately. Keep the "Re-evaluate" button for manual re-runs after gift list changes.

### R4: Add LLM to sibling-to-shipment matching

`matchSiblingsToShipment()` should call the LLM when the heuristic is uncertain, with the same enriched context. This is the highest-stakes matching path — it mutates gift status.

### R5: Upgrade from Haiku to Sonnet for matching

Haiku is fast and cheap but this is a reasoning-heavy task with ambiguous inputs. Sonnet would significantly improve match quality. At the volume this app handles (dozens of orders per month, not thousands), the cost difference is negligible.

### R6: Add cache invalidation

- TTL on cache entries (e.g., 7 days) so stale verdicts expire
- Admin UI to clear cache for a specific run or globally
- Auto-invalidate when the admin manually overrides a match (the correction is signal)

### R7: Learn from admin corrections

When the admin manually links a gift to an order (overriding or filling in a match), log that as training signal. Include recent corrections as few-shot examples in future prompts: "The admin previously matched [email title X] to [gift Y for person Z] — use this as a reference for similar items."

---

## Cost Estimate

At current Sonnet pricing (~$3/M input, $15/M output):

- Average prompt with full context: ~800 tokens input, ~50 tokens output
- Per match attempt: ~$0.003
- 50 orders/month × 3 items average = 150 match attempts = ~$0.45/month
- Even at 10× this volume: $4.50/month

Cost is not a constraint. Optimize for match quality.

---

## Implementation Priority

1. R1 (enrich prompt) + R3 (auto-trigger) — biggest bang, addresses the core weakness
2. R2 (run on all unmatched) — lets the LLM find what the heuristic misses
3. R5 (upgrade to Sonnet) — easy config change, meaningful quality improvement
4. R4 (sibling matching) — highest-stakes path
5. R6 + R7 (cache + learning) — refinement layer

---

*Audit performed by Dispatch (Claude Opus), reviewing git history, devlog, and source code. Intended as a work order for Claude Code.*
