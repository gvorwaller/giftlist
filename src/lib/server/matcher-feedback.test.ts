import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from './test-harness';
import { getDb } from './db';
import {
	clearAllCache,
	countCacheRows,
	detectOverride,
	invalidateCacheKey,
	sweepExpiredCache,
	type OverrideDecisionInput
} from './matcher-feedback';
import type { ImportRow } from './types';

interface MatchSpec {
	itemIndex: number;
	giftId: number | null;
}

function verdictJson(matches: MatchSpec[], cacheKey?: string): string {
	return JSON.stringify({
		matches: matches.map((m) => ({
			itemIndex: m.itemIndex,
			giftId: m.giftId,
			confidence: 'high',
			reason: ''
		})),
		unmatched_items: [],
		safe_to_apply: true,
		summary: '',
		model: 'claude-opus-4-7',
		prompt_version: 'v1',
		created_at: '2026-05-21T00:00:00Z',
		...(cacheKey ? { cache_key: cacheKey } : {})
	});
}

function row(json: string | null): ImportRow {
	return { id: 1, llm_verdict_json: json } as unknown as ImportRow;
}

function decide(d: OverrideDecisionInput): OverrideDecisionInput {
	return d;
}

describe('detectOverride (pure)', () => {
	it('agree — single item, admin linked the LLM pick', () => {
		const ev = detectOverride(row(verdictJson([{ itemIndex: 0, giftId: 7 }])), decide({ assignedGiftId: 7 }));
		expect(ev?.action).toBe('agree');
		expect(ev?.items).toEqual([]);
	});

	it('agree — both chose create-new (LLM null, admin no link)', () => {
		const ev = detectOverride(row(verdictJson([{ itemIndex: 0, giftId: null }])), decide({}));
		expect(ev?.action).toBe('agree');
	});

	it('override — admin linked a different existing gift', () => {
		const ev = detectOverride(row(verdictJson([{ itemIndex: 0, giftId: 7 }])), decide({ assignedGiftId: 9 }));
		expect(ev?.action).toBe('override');
		expect(ev?.items).toEqual([{ itemIndex: 0, llmGiftId: 7, adminGiftId: 9 }]);
	});

	it('reject — LLM picked an existing gift, admin created new', () => {
		const ev = detectOverride(row(verdictJson([{ itemIndex: 0, giftId: 7 }])), decide({}));
		expect(ev?.action).toBe('reject');
		expect(ev?.items).toEqual([{ itemIndex: 0, llmGiftId: 7, adminGiftId: null }]);
	});

	it('fill-in — LLM saw no match, admin linked one', () => {
		const ev = detectOverride(row(verdictJson([{ itemIndex: 0, giftId: null }])), decide({ assignedGiftId: 5 }));
		expect(ev?.action).toBe('fill-in');
	});

	it('multi-item — one item disagrees → override, only that delta reported', () => {
		const ev = detectOverride(
			row(verdictJson([{ itemIndex: 0, giftId: 1 }, { itemIndex: 1, giftId: 2 }])),
			decide({
				lineItems: [
					{ lineItemIndex: 0, assignedGiftId: 1 },
					{ lineItemIndex: 1, assignedGiftId: 3 }
				]
			})
		);
		expect(ev?.action).toBe('override');
		expect(ev?.items).toEqual([{ itemIndex: 1, llmGiftId: 2, adminGiftId: 3 }]);
	});

	it('excluded item (not committed) is skipped, not treated as a disagreement', () => {
		// Verdict has matches for items 0 and 1, but the admin only committed
		// item 0 (item 1 was excluded by keyword → no picker → not in lineItems).
		const ev = detectOverride(
			row(verdictJson([{ itemIndex: 0, giftId: 1 }, { itemIndex: 1, giftId: 2 }])),
			decide({ lineItems: [{ lineItemIndex: 0, assignedGiftId: 1 }] })
		);
		expect(ev?.action).toBe('agree');
		expect(ev?.items).toEqual([]);
	});

	it('treats an item the LLM left in unmatched_items as a fill-in when the admin links it (Codex P2)', () => {
		// LLM placed no match for item 0 — it only appears in unmatched_items.
		const json = JSON.stringify({
			matches: [],
			unmatched_items: [0],
			safe_to_apply: false,
			summary: '',
			model: 'm',
			prompt_version: 'v1',
			created_at: '',
			cache_key: 'k9'
		});
		const ev = detectOverride(row(json), decide({ assignedGiftId: 5 }));
		expect(ev?.action).toBe('fill-in');
		expect(ev?.items).toEqual([{ itemIndex: 0, llmGiftId: null, adminGiftId: 5 }]);
		expect(ev?.cacheKey).toBe('k9');
	});

	it('returns null when the row has no verdict', () => {
		expect(detectOverride(row(null), decide({ assignedGiftId: 1 }))).toBeNull();
	});

	it('cacheKey is threaded through, null when the verdict lacks one', () => {
		const withKey = detectOverride(row(verdictJson([{ itemIndex: 0, giftId: 7 }], 'abc123')), decide({ assignedGiftId: 9 }));
		expect(withKey?.cacheKey).toBe('abc123');
		const without = detectOverride(row(verdictJson([{ itemIndex: 0, giftId: 7 }])), decide({ assignedGiftId: 9 }));
		expect(without?.cacheKey).toBeNull();
	});
});

describe('cache maintenance (DB)', () => {
	beforeEach(() => setupTestDb());
	afterEach(() => teardownTestDb());

	it('invalidateCacheKey deletes one entry; no-op on null/empty', () => {
		getDb()
			.prepare(
				`INSERT INTO matcher_llm_cache (cache_key, mode, model, prompt_version, response, expires_at)
				 VALUES ('k1','import','m','v1','{}', datetime('now','+7 days')),
				        ('k2','import','m','v1','{}', datetime('now','+7 days'))`
			)
			.run();
		expect(countCacheRows()).toBe(2);
		invalidateCacheKey('k1');
		expect(countCacheRows()).toBe(1);
		invalidateCacheKey(null); // no throw, no change
		invalidateCacheKey('');
		expect(countCacheRows()).toBe(1);
	});

	it('clearAllCache deletes everything and returns the count', () => {
		getDb()
			.prepare(
				`INSERT INTO matcher_llm_cache (cache_key, mode, model, prompt_version, response, expires_at)
				 VALUES ('a','import','m','v1','{}', datetime('now','+7 days')),
				        ('b','shipment','m','v1','{}', datetime('now','+7 days')),
				        ('c','import','m','v1','{}', datetime('now','+7 days'))`
			)
			.run();
		expect(clearAllCache()).toBe(3);
		expect(countCacheRows()).toBe(0);
	});

	it('sweepExpiredCache deletes only expired rows', () => {
		getDb()
			.prepare(
				`INSERT INTO matcher_llm_cache (cache_key, mode, model, prompt_version, response, expires_at)
				 VALUES ('stale','import','m','v1','{}', datetime('now','-1 day')),
				        ('fresh','import','m','v1','{}', datetime('now','+1 day'))`
			)
			.run();
		expect(sweepExpiredCache()).toBe(1);
		expect(countCacheRows()).toBe(1);
	});
});
