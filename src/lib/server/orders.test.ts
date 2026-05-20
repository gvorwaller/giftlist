import { describe, it, expect } from 'vitest';
import { matchSiblingsToShipment } from './orders';
import type { Gift } from './types';

// Minimal Gift factory — matchSiblingsToShipment only reads id, title,
// person_id, so the other fields can be stubbed.
function gift(id: number, title: string): Gift {
	return {
		id,
		person_id: 100 + id,
		occasion_id: null,
		occasion_year: null,
		title,
		source: null,
		source_url: null,
		order_id: null,
		tracking_number: null,
		carrier: null,
		price_cents: null,
		status: 'ordered',
		ordered_at: null,
		shipped_at: null,
		delivered_at: null,
		notes: null,
		is_idea: 0,
		is_archived: 0,
		vendor_id: null,
		shipper_id: null,
		tracking_status: null,
		tracking_status_at: null,
		tracking_estimated_delivery: null,
		tracking_provider_id: null,
		amazon_tracking_url: null,
		order_pk: 1,
		line_item_index: id - 1,
		shipment_id: null,
		archived_at: null,
		created_at: '2026-01-01',
		updated_at: '2026-01-01'
	};
}

describe('matchSiblingsToShipment — Wave 1 (post-Codex review)', () => {
	it('abstains (returns empty) when the email enumerated no item titles', () => {
		// Wave 1: the prior "advance ALL siblings" fallback is gone. When
		// items aren't enumerated, the heuristic stays silent and the caller
		// routes the row to the LLM / review queue rather than guessing.
		const siblings = [gift(1, 'Endoscope Kit'), gift(2, 'Bluetooth Headphones')];
		const result = matchSiblingsToShipment(siblings, []);
		expect(result.itemsHadTitles).toBe(false);
		expect(result.matched).toHaveLength(0);
		expect(result.heuristicCertain).toBe(false);
	});

	it('narrows siblings to those matching the shipped item titles', () => {
		// 3-item / 3-recipient order; shipping email covers items 1 and 3.
		const siblings = [
			gift(1, 'Endoscope Camera Kit'),
			gift(2, 'Bluetooth Speaker'),
			gift(3, 'Stainless Steel Water Bottle')
		];
		const shippedTitles = [
			'Endoscope USB inspection probe — high res',
			'Insulated Stainless Steel Water Bottle 32oz'
		];
		const result = matchSiblingsToShipment(siblings, shippedTitles);
		expect(result.itemsHadTitles).toBe(true);
		const matchedIds = result.matched.map((g) => g.id).sort();
		expect(matchedIds).toEqual([1, 3]);
		expect(result.heuristicCertain).toBe(true);
	});

	it('returns empty matched array when items present but none align', () => {
		// Email lists items but heuristic rejects all matches. Caller will
		// consult the LLM (Phase 2) — this function does not fall back.
		const siblings = [gift(1, 'Endoscope Camera Kit')];
		const shippedTitles = ['Generic Gift Card'];
		const result = matchSiblingsToShipment(siblings, shippedTitles);
		expect(result.itemsHadTitles).toBe(true);
		expect(result.matched).toHaveLength(0);
		expect(result.heuristicCertain).toBe(false);
	});

	it('handles single-item shipping notification matching one of N siblings', () => {
		const siblings = [
			gift(1, 'Endoscope Camera Kit'),
			gift(2, 'Bluetooth Speaker JBL'),
			gift(3, 'Stainless Steel Water Bottle')
		];
		const result = matchSiblingsToShipment(siblings, [
			'Bluetooth Speaker JBL Flip 5 Portable'
		]);
		expect(result.itemsHadTitles).toBe(true);
		expect(result.matched.map((g) => g.id)).toEqual([2]);
		expect(result.heuristicCertain).toBe(true);
	});
});
