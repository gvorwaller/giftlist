import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planShipmentAdvance } from './shipment-decider';
import type { Gift, ImportRow } from './types';
import type { ParsedAmazonItem } from './amazon-parser';

// Stub the LLM call so we can assert the inputs it receives.
vi.mock('./llm-matcher', async () => {
	const actual = await vi.importActual<typeof import('./llm-matcher')>('./llm-matcher');
	return {
		...actual,
		llmMatchShipment: vi.fn().mockResolvedValue(null)
	};
});
import { llmMatchShipment } from './llm-matcher';
import { seedGift, seedImportRun, seedImportRow, seedPerson, seedUser, setupTestDb, teardownTestDb } from './test-harness';
import { upsertOrderByOrderId, listGiftsForOrder } from './orders';

function gift(id: number, title: string, person_id = 100 + id): Gift {
	return {
		id,
		person_id,
		occasion_id: null,
		occasion_year: null,
		title,
		source: null,
		source_url: null,
		order_id: '113-0000000-0000000',
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

function item(idx: number, title: string, priceCents: number | null = null): ParsedAmazonItem & { itemIndex: number } {
	return { itemIndex: idx, title, priceCents, quantity: 1 };
}

function row(): ImportRow {
	return {
		id: 1,
		import_run_id: 1,
		source_message_id: 'msg-1',
		source_thread_id: null,
		subject: 'Your package shipped',
		received_at: '2026-05-18 12:00:00',
		from_address: 'ship-confirm@amazon.com',
		email_type: 'shipped',
		parsed_title: 'Endoscope Camera Kit',
		parsed_order_id: '113-0000000-0000000',
		parsed_price_cents: null,
		parsed_tracking_number: '1Z999AA',
		parsed_carrier: 'ups',
		parsed_recipient_name: null,
		parsed_shipping_address: null,
		parsed_gift_message: null,
		parsed_sender_domain: 'amazon.com',
		parsed_amazon_tracking_url: null,
		parsed_items_json: null,
		parsed_body_excerpt: null,
		match_person_id: null,
		match_confidence: null,
		match_candidates_json: null,
		llm_verdict_json: null,
		disposition: 'pending',
		gift_id: null,
		error_message: null,
		created_at: '2026-01-01',
		updated_at: '2026-01-01'
	};
}

describe('planShipmentAdvance — Codex P4 (body fallback plumbing)', () => {
	beforeEach(() => {
		setupTestDb();
		vi.mocked(llmMatchShipment).mockReset();
		vi.mocked(llmMatchShipment).mockResolvedValue(null);
	});
	afterEach(() => teardownTestDb());

	it('passes row.parsed_body_excerpt into llmMatchShipment as shipmentBodyFallback', async () => {
		const admin = seedUser({ username: 'admin' });
		const personA = seedPerson({ display_name: 'Alice' });
		const orderId = 'p4-codex-body-fallback';
		const orderPk = upsertOrderByOrderId({ order_id: orderId });
		// One sibling so siblings.length > 0 (otherwise the function
		// short-circuits before reaching the LLM branch).
		seedGift({
			person_id: personA.id,
			title: 'Endoscope camera kit',
			order_pk: orderPk,
			order_id: orderId,
			line_item_index: 0,
			status: 'ordered'
		});
		const runId = seedImportRun({ actor_user_id: admin.id });
		const r = seedImportRow({
			import_run_id: runId,
			email_type: 'shipped',
			parsed_order_id: orderId,
			parsed_items_json: null,
			parsed_body_excerpt: 'Body text describing the shipment of an Endoscope kit'
		});
		const siblings = listGiftsForOrder(orderPk);
		await planShipmentAdvance({ row: r, orderPk, siblings, items: [] });
		expect(llmMatchShipment).toHaveBeenCalledOnce();
		const call = vi.mocked(llmMatchShipment).mock.calls[0][0];
		expect(call.shipmentBodyFallback).toBe(
			'Body text describing the shipment of an Endoscope kit'
		);
	});
});

describe('planShipmentAdvance — Wave 1 Phase 2', () => {
	it('returns safe-with-empty when the order has no siblings', async () => {
		const plan = await planShipmentAdvance({
			row: row(),
			orderPk: 1,
			siblings: [],
			items: [item(0, 'Endoscope Camera Kit')]
		});
		expect(plan.kind).toBe('safe');
		if (plan.kind === 'safe') {
			expect(plan.matchedSiblingIds).toEqual([]);
		}
	});

	it('returns safe via heuristic when every shipped item pairs cleanly with a sibling', async () => {
		const siblings = [
			gift(1, 'Endoscope Camera Kit', 50),
			gift(2, 'Bluetooth Speaker JBL', 60)
		];
		const plan = await planShipmentAdvance({
			row: row(),
			orderPk: 1,
			siblings,
			items: [
				item(0, 'Endoscope USB inspection probe — high res'),
				item(1, 'Bluetooth Speaker JBL Flip 5 Portable')
			]
		});
		expect(plan.kind).toBe('safe');
		if (plan.kind === 'safe') {
			expect(plan.source).toBe('heuristic');
			expect(plan.matchedSiblingIds.sort()).toEqual([1, 2]);
		}
	});
});
