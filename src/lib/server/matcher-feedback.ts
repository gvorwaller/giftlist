import { getDb } from './db';
import { sweepExpiredCache, type LlmMatchVerdict } from './llm-matcher';
import type { ImportRow } from './types';

/**
 * Wave 2 shared spine (Phase 4 / auto-accept / Phase 5).
 *
 * One signal — "did the admin's commit disagree with the LLM's pick?" —
 * with three consumers:
 *   - Phase 4 (td-27f36d): invalidate the now-known-wrong cache entry so it
 *     stops replaying for the 7-day TTL.
 *   - Auto-accept (td-dbaa0c): its UNDO path re-runs detectOverride so the
 *     system learns from its own automatic mistakes, not just manual ones.
 *   - Phase 5 (td-4bfb59): append a matcher_corrections row from the same
 *     per-item deltas.
 *
 * Keeping it in one module (rather than inline in commitReviewedRows) means
 * all three plug into the same detector with one shape.
 */

export type OverrideAction = 'agree' | 'override' | 'fill-in' | 'reject';

export interface OverrideItemDelta {
	itemIndex: number;
	/** Gift the LLM picked for this item, or null if it picked "no match". */
	llmGiftId: number | null;
	/** Gift the admin committed for this item, or null if they created new. */
	adminGiftId: number | null;
}

export interface OverrideEvent {
	rowId: number;
	/** Verdict cache key, or null for pre-Phase-4 verdicts (no key persisted). */
	cacheKey: string | null;
	/** Aggregate across items: 'agree' = admin matched the LLM on every item. */
	action: OverrideAction;
	/** Per-item deltas that the admin actually committed (excluded items skipped). */
	items: OverrideItemDelta[];
}

/** Minimal shape detectOverride reads — CommitRowInput is assignable to it,
 *  so callers pass their decision directly without a circular import. */
export interface OverrideDecisionInput {
	assignedGiftId?: number;
	lineItems?: Array<{ lineItemIndex: number; assignedGiftId?: number }>;
}

function parseVerdict(json: string | null): LlmMatchVerdict | null {
	if (!json) return null;
	try {
		const obj = JSON.parse(json);
		if (obj && typeof obj === 'object' && Array.isArray(obj.matches)) {
			return obj as LlmMatchVerdict;
		}
	} catch {
		// fall through
	}
	return null;
}

/** Precedence when items disagree in different ways: a flat-out wrong pick
 *  (override) is a stronger "the LLM was wrong" signal than a missed pick. */
function strongest(a: OverrideAction, b: OverrideAction): OverrideAction {
	const rank: Record<OverrideAction, number> = { agree: 0, 'fill-in': 1, reject: 2, override: 3 };
	return rank[a] >= rank[b] ? a : b;
}

function classify(llmGiftId: number | null, adminGiftId: number | null): OverrideAction {
	if (llmGiftId === adminGiftId) return 'agree'; // same gift, or both null (create-new agreed)
	if (llmGiftId != null && adminGiftId != null) return 'override'; // picked a different existing gift
	if (llmGiftId == null && adminGiftId != null) return 'fill-in'; // LLM saw nothing, admin linked one
	return 'reject'; // LLM picked an existing gift, admin created new instead
}

/**
 * Compare the admin's committed decision against the persisted LLM verdict.
 * Returns null when the row has no verdict to compare against. `cacheKey` is
 * null for pre-Phase-4 verdicts (written before cache_key was threaded onto
 * the verdict) — callers skip invalidation in that case; the TTL covers it.
 */
export function detectOverride(
	row: ImportRow,
	decision: OverrideDecisionInput
): OverrideEvent | null {
	const verdict = parseVerdict(row.llm_verdict_json);
	if (!verdict) return null;

	// Admin's chosen gift per item index. Multi-item rows key by
	// lineItemIndex; single-item rows are item 0. null = "create new".
	const adminByIndex = new Map<number, number | null>();
	if (decision.lineItems && decision.lineItems.length > 0) {
		for (const li of decision.lineItems) {
			adminByIndex.set(li.lineItemIndex, li.assignedGiftId ?? null);
		}
	} else {
		adminByIndex.set(0, decision.assignedGiftId ?? null);
	}

	// Walk the items the admin actually COMMITTED (excluded items have no
	// picker, so they never appear here and aren't disagreements). The LLM's
	// pick for each is its matches[] entry if present, else null — which
	// covers items the model surfaced only via `unmatched_items`, or omitted
	// entirely (Codex P2). That way an admin filling in a gift the LLM
	// couldn't place still counts as a correction and invalidates the cache.
	const matchByIndex = new Map(verdict.matches.map((m) => [m.itemIndex, m.giftId]));
	const items: OverrideItemDelta[] = [];
	let action: OverrideAction = 'agree';
	for (const [itemIndex, adminGiftId] of adminByIndex) {
		const llmGiftId = matchByIndex.get(itemIndex) ?? null;
		const itemAction = classify(llmGiftId, adminGiftId);
		if (itemAction !== 'agree') {
			items.push({ itemIndex, llmGiftId, adminGiftId });
			action = strongest(action, itemAction);
		}
	}

	return { rowId: row.id, cacheKey: verdict.cache_key ?? null, action, items };
}

// ── Cache maintenance ──────────────────────────────────────────────────

/** Delete a single cache entry (Phase 4: invalidate-on-override). No-op on
 *  null/empty key so callers don't have to guard pre-Phase-4 verdicts. */
export function invalidateCacheKey(cacheKey: string | null | undefined): void {
	if (!cacheKey) return;
	try {
		getDb().prepare(`DELETE FROM matcher_llm_cache WHERE cache_key = ?`).run(cacheKey);
	} catch (err) {
		console.warn('[matcher-feedback] cache invalidate failed (non-fatal):', err);
	}
}

/** Nuke the whole matcher cache (Phase 4: admin "Clear LLM cache" button).
 *  Returns the number of rows deleted. */
export function clearAllCache(): number {
	const info = getDb().prepare(`DELETE FROM matcher_llm_cache`).run();
	return info.changes;
}

/** Re-export so cron/admin callers have a single cache-maintenance surface. */
export { sweepExpiredCache };

/** Current cache row count (for the admin page's "Clear (N)" label). */
export function countCacheRows(): number {
	const row = getDb()
		.prepare<[], { cnt: number }>(`SELECT COUNT(*) AS cnt FROM matcher_llm_cache`)
		.get();
	return row?.cnt ?? 0;
}
