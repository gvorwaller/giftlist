/**
 * Codex P2 regression: multi-item-aware shortlist ranking.
 *
 * Before this fix, `rankCandidatesForImport` was called with the
 * email's `parsed_title` (which is just `items[0].title`). Multi-item
 * emails with N items therefore never surfaced candidates relevant to
 * items 1..N. The new `rankCandidatesForItems` ranks against every
 * item title and unions the per-item top-K.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rankCandidatesForItems } from './gift-matcher';
import { seedGift, seedPerson, setupTestDb, teardownTestDb } from './test-harness';

beforeEach(() => setupTestDb());
afterEach(() => teardownTestDb());

describe('rankCandidatesForItems — Codex P2', () => {
	it('pools candidates across every item title in a multi-item email', () => {
		const personA = seedPerson({ display_name: 'Alice' });
		const personB = seedPerson({ display_name: 'Bob' });
		const personC = seedPerson({ display_name: 'Carol' });
		// Three open gift ideas, one matching each item in a hypothetical
		// 3-item Amazon order.
		seedGift({ person_id: personA.id, title: 'Endoscope camera inspection kit', status: 'idea' });
		seedGift({ person_id: personB.id, title: 'Bluetooth speaker JBL Flip', status: 'planned' });
		seedGift({ person_id: personC.id, title: 'Stainless steel water bottle', status: 'idea' });

		const candidates = rankCandidatesForItems(
			[
				'Endoscope USB inspection probe — high res',
				'JBL Flip 5 Portable Bluetooth Speaker',
				'Insulated Stainless Steel Water Bottle 32oz'
			],
			null,
			10
		);

		const titles = candidates.map((c) => c.title);
		expect(titles).toContain('Endoscope camera inspection kit');
		expect(titles).toContain('Bluetooth speaker JBL Flip');
		expect(titles).toContain('Stainless steel water bottle');
	});

	it('returns empty when no items provided', () => {
		seedPerson({ display_name: 'Alice' });
		expect(rankCandidatesForItems([], null, 10)).toEqual([]);
	});

	it('falls back to single-item ranking when only one title is given', () => {
		const personA = seedPerson({ display_name: 'Alice' });
		seedGift({ person_id: personA.id, title: 'Endoscope camera kit', status: 'idea' });
		const candidates = rankCandidatesForItems(['Endoscope USB inspection'], null, 5);
		expect(candidates.length).toBe(1);
		expect(candidates[0].title).toBe('Endoscope camera kit');
	});

	it('Codex2 P2a: item-2 candidate survives when item-0 has many near-duplicates', () => {
		// Regression: original max-score implementation let item-0's
		// 20+ near-duplicates crowd out item-2's outlier candidate.
		// Per-item top-K guarantees every item has its own slot.
		const personA = seedPerson({ display_name: 'Alice' });
		// 20 gifts that share many tokens with item 0's title.
		for (let i = 0; i < 20; i++) {
			seedGift({
				person_id: personA.id,
				title: `Endoscope camera kit variant ${i}`,
				status: 'idea'
			});
		}
		// One outlier gift that only aligns with item 2's title.
		const outlier = seedGift({
			person_id: personA.id,
			title: 'Stainless steel water bottle insulated',
			status: 'idea'
		});
		const candidates = rankCandidatesForItems(
			[
				'Endoscope USB inspection probe',
				'Phone charging cable',
				'Insulated stainless steel water bottle 32oz'
			],
			null,
			20
		);
		const ids = candidates.map((c) => c.giftId);
		expect(ids).toContain(outlier.id);
	});

	it('Codex3 P2: hint-person with many gifts does not crowd out other recipients\' per-item outliers', async () => {
		// Multi-recipient order: 3 items going to 3 different people.
		// findGiftPersonByOrderId returns ONE person (the hint). If that
		// person has many open gift ideas, the algorithm must still
		// surface per-item outliers for the other 2 recipients in the
		// shortlist so the LLM can match them.
		const hintPerson = seedPerson({ display_name: 'Madonna' });
		const otherB = seedPerson({ display_name: 'Bob' });
		const otherC = seedPerson({ display_name: 'Carol' });
		// 25 unrelated open gifts for the hint person.
		for (let i = 0; i < 25; i++) {
			seedGift({
				person_id: hintPerson.id,
				title: `Random idea ${i} miscellany`,
				status: 'idea'
			});
		}
		// Outlier gifts for Bob and Carol that uniquely match items 1 and 2.
		const bobOutlier = seedGift({
			person_id: otherB.id,
			title: 'Endoscope camera kit for drains',
			status: 'idea'
		});
		const carolOutlier = seedGift({
			person_id: otherC.id,
			title: 'Stainless steel water bottle insulated',
			status: 'idea'
		});
		const candidates = rankCandidatesForItems(
			[
				'Hallmark card', // item 0 — no strong match anywhere
				'Endoscope USB inspection probe', // item 1 — matches Bob
				'Insulated steel water bottle 32oz' // item 2 — matches Carol
			],
			hintPerson.id, // hint = Madonna
			20
		);
		const ids = candidates.map((c) => c.giftId);
		expect(ids).toContain(bobOutlier.id);
		expect(ids).toContain(carolOutlier.id);
	});

	it('floats recipient-hint matches to the top of the shortlist', () => {
		const personA = seedPerson({ display_name: 'Alice' });
		const personB = seedPerson({ display_name: 'Bob' });
		// Gift for Alice with weak title overlap; gift for Bob with strong overlap.
		seedGift({ person_id: personA.id, title: 'Generic miscellaneous thing', status: 'idea' });
		const strong = seedGift({
			person_id: personB.id,
			title: 'Endoscope camera kit',
			status: 'idea'
		});
		// Hint = Alice. Both gifts return; Alice's hint-matched gift comes first
		// despite its weak title overlap, then Bob's strong-score gift.
		const candidates = rankCandidatesForItems(['Endoscope inspection'], personA.id, 5);
		expect(candidates[0].personId).toBe(personA.id);
		// Bob's stronger-scored gift still appears, just below the hint.
		expect(candidates.map((c) => c.giftId)).toContain(strong.id);
	});
});
