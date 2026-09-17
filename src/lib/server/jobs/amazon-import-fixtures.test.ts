/**
 * Wave 1 fixture regression suite (Codex review #7).
 *
 * Each test stages a realistic Amazon-import scenario against an
 * in-memory DB and exercises `commitReviewedRows` end-to-end. The LLM
 * is mocked — these tests target the deterministic commit + dedup
 * logic, not Anthropic. Mock returns are scenario-specific so each
 * fixture asserts a single behavior.
 *
 * Cases:
 *   1. order_placed_multi_item: 3 items / 2 recipients → 3 fresh gifts
 *   2. shipped_partial: shipment covers items 1+3 of a 4-item order
 *   3. shipped_no_item_enumeration: parser couldn't extract items →
 *      abstain path; no siblings advance
 *   4. shipped_reordered_items: Amazon enumerated items in a different
 *      order than order_placed → fingerprint dedup matches correctly
 *   5. duplicate_titles: order has 2 identical-title items at different
 *      indexes → fingerprint disambiguates by index fallback
 *   6. same_recipient_multiple_items: 3 items all going to one person
 *      → 3 gifts created for that recipient
 *   7. conflicting_override: admin pick differs from existing sibling's
 *      recipient → commit fails with explicit conflict
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	itemsJson,
	seedImportRow,
	seedImportRun,
	seedPerson,
	seedUser,
	setupTestDb,
	teardownTestDb
} from '../test-harness';
import { getDb } from '../db';

// Mock the LLM so tests are hermetic. Per-test we override via
// `vi.mocked(...).mockResolvedValue(...)`.
vi.mock('../llm-matcher', async () => {
	const actual = await vi.importActual<typeof import('../llm-matcher')>('../llm-matcher');
	return {
		...actual,
		llmMatchImportRow: vi.fn().mockResolvedValue(null),
		llmMatchShipment: vi.fn().mockResolvedValue(null)
	};
});

// Re-import after mock so we get the patched copy.
import { commitReviewedRows } from './amazon-import';
import { llmMatchShipment } from '../llm-matcher';

beforeEach(() => setupTestDb());
afterEach(() => teardownTestDb());

interface Cast {
	admin: { id: number };
	personA: ReturnType<typeof seedPerson>;
	personB: ReturnType<typeof seedPerson>;
	personC: ReturnType<typeof seedPerson>;
	runId: number;
}

function bootstrap(): Cast {
	const admin = seedUser({ username: 'admin' });
	const personA = seedPerson({ display_name: 'Alice', relationship: 'Daughter' });
	const personB = seedPerson({ display_name: 'Bob', relationship: 'Son' });
	const personC = seedPerson({ display_name: 'Carol', relationship: 'Niece' });
	const runId = seedImportRun({ actor_user_id: admin.id });
	return { admin, personA, personB, personC, runId };
}

describe('Wave 1 fixture corpus — amazon import commit + dedup', () => {
	it('1. order_placed multi-item: 3 items / 2 recipients → 3 gifts created', async () => {
		const { admin, personA, personB, runId } = bootstrap();
		const orderId = '111-1111111-1111111';
		const row = seedImportRow({
			import_run_id: runId,
			subject: `Your order #${orderId}`,
			email_type: 'order_placed',
			parsed_title: 'Endoscope Camera Kit',
			parsed_order_id: orderId,
			parsed_items_json: itemsJson([
				{ title: 'Endoscope Camera Kit' },
				{ title: 'Bluetooth Speaker JBL' },
				{ title: 'Stainless Steel Water Bottle 32oz' }
			])
		});
		const result = await commitReviewedRows(admin.id, [
			{
				rowId: row.id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personB.id },
					{ lineItemIndex: 2, assignedPersonId: personA.id }
				]
			}
		]);
		expect(result.giftsCreated).toBe(3);
		expect(result.rowsFailed).toBe(0);
		const gifts = getDb()
			.prepare<[string], { person_id: number; line_item_index: number; status: string }>(
				`SELECT person_id, line_item_index, status FROM gifts
				  WHERE order_id = ? AND is_archived = 0
				  ORDER BY line_item_index`
			)
			.all(orderId);
		expect(gifts).toEqual([
			{ person_id: personA.id, line_item_index: 0, status: 'ordered' },
			{ person_id: personB.id, line_item_index: 1, status: 'ordered' },
			{ person_id: personA.id, line_item_index: 2, status: 'ordered' }
		]);
	});

	it('2. shipped_partial: only the shipped items advance to shipped', async () => {
		const { admin, personA, personB, personC, runId } = bootstrap();
		const orderId = '222-2222222-2222222';
		// First commit order_placed with 4 items.
		const orderPlaced = seedImportRow({
			import_run_id: runId,
			email_type: 'order_placed',
			parsed_title: 'Endoscope Camera Kit',
			parsed_order_id: orderId,
			parsed_items_json: itemsJson([
				{ title: 'Endoscope Camera Kit' },
				{ title: 'Bluetooth Speaker JBL' },
				{ title: 'Stainless Steel Water Bottle 32oz' },
				{ title: 'Cable Management Box' }
			])
		});
		await commitReviewedRows(admin.id, [
			{
				rowId: orderPlaced.id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personB.id },
					{ lineItemIndex: 2, assignedPersonId: personC.id },
					{ lineItemIndex: 3, assignedPersonId: personA.id }
				]
			}
		]);
		// Now ship items 1 and 3 (Speaker + Cable box).
		const shippedRow = seedImportRow({
			import_run_id: runId,
			email_type: 'shipped',
			parsed_title: 'Bluetooth Speaker JBL',
			parsed_order_id: orderId,
			parsed_tracking_number: '1Z999AA',
			parsed_carrier: 'ups',
			parsed_items_json: itemsJson([
				{ title: 'Bluetooth Speaker JBL' },
				{ title: 'Cable Management Box' }
			])
		});
		await commitReviewedRows(admin.id, [
			{
				rowId: shippedRow.id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personB.id },
					{ lineItemIndex: 1, assignedPersonId: personA.id }
				]
			}
		]);
		const gifts = getDb()
			.prepare<[string], { person_id: number; status: string; title: string }>(
				`SELECT person_id, status, title FROM gifts
				  WHERE order_id = ? AND is_archived = 0
				  ORDER BY line_item_index`
			)
			.all(orderId);
		expect(gifts.length).toBe(4); // no duplicates
		const byTitle = Object.fromEntries(gifts.map((g) => [g.title, g.status]));
		expect(byTitle['Bluetooth Speaker JBL']).toBe('shipped');
		expect(byTitle['Cable Management Box']).toBe('shipped');
		expect(byTitle['Endoscope Camera Kit']).toBe('ordered'); // not in this shipment
		expect(byTitle['Stainless Steel Water Bottle 32oz']).toBe('ordered');
	});

	it('3. shipped with no item enumeration: shipment-decider abstains, no siblings advance', async () => {
		// Force the LLM to return null (no key / unavailable) — abstain path.
		vi.mocked(llmMatchShipment).mockResolvedValue(null);
		const { admin, personA, personB, runId } = bootstrap();
		const orderId = '333-3333333-3333333';
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Endoscope Camera Kit',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([
						{ title: 'Endoscope Camera Kit' },
						{ title: 'Bluetooth Speaker' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personB.id }
				]
			}
		]);
		// Ship without item enumeration (Amazon's terse "your package shipped" case).
		const shippedRow = seedImportRow({
			import_run_id: runId,
			email_type: 'shipped',
			parsed_title: 'Your package',
			parsed_order_id: orderId,
			parsed_items_json: null,
			parsed_tracking_number: '1Z999BB'
		});
		const result = await commitReviewedRows(admin.id, [
			{
				rowId: shippedRow.id,
				action: 'accept',
				assignedPersonId: personA.id
			}
		]);
		expect(result.rowsAbstained).toBe(1);
		// Neither sibling advanced.
		const statuses = getDb()
			.prepare<[string], { status: string; title: string }>(
				`SELECT status, title FROM gifts WHERE order_id = ? AND is_archived = 0`
			)
			.all(orderId);
		expect(statuses.every((s) => s.status === 'ordered')).toBe(true);
		// Unresolved tracking stays on the import; no order is guessed for a shipment.
		const shipments = getDb()
			.prepare<[], { tracking_number: string }>('SELECT tracking_number FROM order_shipments')
			.all();
		expect(shipments).toHaveLength(0);
	});

	it('4. shipped_reordered_items: Amazon flipped item order, fingerprint dedup still matches', async () => {
		const { admin, personA, personB, runId } = bootstrap();
		const orderId = '444-4444444-4444444';
		// order_placed: Endoscope at idx 0, Speaker at idx 1.
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Endoscope Camera Kit',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([
						{ title: 'Endoscope Camera Kit' },
						{ title: 'Bluetooth Speaker' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personB.id }
				]
			}
		]);
		// shipped: Amazon reordered — Speaker now at idx 0, Endoscope at idx 1.
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'shipped',
					parsed_title: 'Bluetooth Speaker',
					parsed_order_id: orderId,
					parsed_tracking_number: '1Z999CC',
					parsed_items_json: itemsJson([
						{ title: 'Bluetooth Speaker' },
						{ title: 'Endoscope Camera Kit' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personB.id },
					{ lineItemIndex: 1, assignedPersonId: personA.id }
				]
			}
		]);
		const gifts = getDb()
			.prepare<[string], { person_id: number; status: string; title: string }>(
				`SELECT person_id, status, title FROM gifts
				  WHERE order_id = ? AND is_archived = 0
				  ORDER BY line_item_index`
			)
			.all(orderId);
		expect(gifts.length).toBe(2); // no duplicates despite reorder
		// Both advanced to shipped.
		expect(gifts.every((g) => g.status === 'shipped')).toBe(true);
		// Recipients stable.
		const byTitle = Object.fromEntries(gifts.map((g) => [g.title, g.person_id]));
		expect(byTitle['Endoscope Camera Kit']).toBe(personA.id);
		expect(byTitle['Bluetooth Speaker']).toBe(personB.id);
	});

	it('5. duplicate_titles within ONE commit: both line items create distinct gifts', async () => {
		// Within a single commit pass, `existingSiblings` is loaded once
		// before the line-item loop. Two identical-title items in the
		// same commit therefore both create fresh gifts (fingerprint dedup
		// only fires against previously-persisted siblings, not against
		// items currently being created). DB unique index on
		// (order_pk, line_item_index) is the safety net.
		const { admin, personA, personB, runId } = bootstrap();
		const orderId = '555-5555555-5555555';
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Hallmark Card',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([
						{ title: 'Hallmark Card' },
						{ title: 'Hallmark Card' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personB.id }
				]
			}
		]);
		const gifts = getDb()
			.prepare<[string], { person_id: number; line_item_index: number }>(
				`SELECT person_id, line_item_index FROM gifts
				  WHERE order_id = ? AND is_archived = 0
				  ORDER BY line_item_index`
			)
			.all(orderId);
		expect(gifts.length).toBe(2);
		expect(gifts[0].person_id).toBe(personA.id);
		expect(gifts[1].person_id).toBe(personB.id);
		expect(gifts.map((g) => g.line_item_index)).toEqual([0, 1]);
	});

	it('5b. duplicate_titles across separate commits: second commit dedups to first', async () => {
		// When a SECOND row commits with the same title that was already
		// committed earlier (e.g. order_placed + shipped both reference
		// the gift), fingerprint dedup correctly links to the existing
		// sibling. Same-title-second-recipient on a re-commit raises a
		// recipient conflict (covered in #7).
		const { admin, personA, runId } = bootstrap();
		const orderId = '555-5555555-5555555';
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Hallmark Card',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([{ title: 'Hallmark Card' }])
				}).id,
				action: 'accept',
				lineItems: [{ lineItemIndex: 0, assignedPersonId: personA.id }]
			}
		]);
		// shipped row with the same title — should link, not create a 2nd gift.
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'shipped',
					parsed_title: 'Hallmark Card',
					parsed_order_id: orderId,
					parsed_tracking_number: '1Z999XYZ',
					parsed_items_json: itemsJson([{ title: 'Hallmark Card' }])
				}).id,
				action: 'accept',
				lineItems: [{ lineItemIndex: 0, assignedPersonId: personA.id }]
			}
		]);
		const gifts = getDb()
			.prepare<[string], { person_id: number; status: string }>(
				`SELECT person_id, status FROM gifts WHERE order_id = ? AND is_archived = 0`
			)
			.all(orderId);
		expect(gifts.length).toBe(1); // dedup worked
		expect(gifts[0].status).toBe('shipped'); // advanced
	});

	it('6. same_recipient_multiple_items: 3 items for one person → 3 distinct gifts', async () => {
		const { admin, personA, runId } = bootstrap();
		const orderId = '666-6666666-6666666';
		const result = await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Endoscope Camera Kit',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([
						{ title: 'Endoscope Camera Kit' },
						{ title: 'Bluetooth Speaker' },
						{ title: 'Stainless Water Bottle' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personA.id },
					{ lineItemIndex: 2, assignedPersonId: personA.id }
				]
			}
		]);
		expect(result.giftsCreated).toBe(3);
		const gifts = getDb()
			.prepare<[string, number], { line_item_index: number; title: string }>(
				`SELECT line_item_index, title FROM gifts
				  WHERE order_id = ? AND person_id = ? AND is_archived = 0
				  ORDER BY line_item_index`
			)
			.all(orderId, personA.id);
		expect(gifts.length).toBe(3);
		expect(gifts.map((g) => g.line_item_index)).toEqual([0, 1, 2]);
	});


 it('same-batch order confirmation and shipment re-plans after the purchase is created',async()=>{
 const {admin,personA,runId}=bootstrap(); const orderId='333-4444444-5555555';
 const purchase=seedImportRow({import_run_id:runId,email_type:'order_placed',parsed_order_id:orderId,parsed_items_json:itemsJson([{title:'Solo Item'}])});
 const shipped=seedImportRow({import_run_id:runId,email_type:'shipped',parsed_order_id:orderId,parsed_items_json:itemsJson([{title:'Solo Item'}])});
 const result=await commitReviewedRows(admin.id,[{rowId:shipped.id,action:'accept'},{rowId:purchase.id,action:'accept',lineItems:[{lineItemIndex:0,assignedPersonId:personA.id}]}]);
 expect(result.giftsCreated).toBe(1); expect(result.siblingsAdvanced).toBe(1); expect(result.rowsAbstained).toBe(0);
 expect(getDb().prepare('SELECT status FROM gifts WHERE order_id=?').get(orderId)).toEqual({status:'shipped'});
 });

	it('Codex P1: duplicate-title siblings across separate commits — disambiguate, don\'t collapse', async () => {
		// Order has two "Hallmark Card" items, one for Alice (idx 0), one
		// for Bob (idx 1). order_placed commits cleanly. Then a shipped
		// row arrives for the SAME two items. The naive fingerprint
		// dedup (Map<string, Gift> last-wins) would either link both
		// incoming items to the same existing gift or raise a false
		// recipient-conflict. The fix: store Gift[] per fingerprint and
		// disambiguate by line_item_index, then recipient.
		const { admin, personA, personB, runId } = bootstrap();
		const orderId = 'p1-codex-duplicate-titles';
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Hallmark Card',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([
						{ title: 'Hallmark Card' },
						{ title: 'Hallmark Card' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personB.id }
				]
			}
		]);
		// Now ship both items — same titles, same indexes, same
		// recipients. Both should link cleanly to the existing siblings.
		const shippedRow = seedImportRow({
			import_run_id: runId,
			email_type: 'shipped',
			parsed_title: 'Hallmark Card',
			parsed_order_id: orderId,
			parsed_tracking_number: '1Z999P1',
			parsed_items_json: itemsJson([
				{ title: 'Hallmark Card' },
				{ title: 'Hallmark Card' }
			])
		});
		const existing = getDb().prepare<[string], {id:number}>('SELECT id FROM gifts WHERE order_id=? ORDER BY line_item_index').all(orderId);
		const result = await commitReviewedRows(admin.id, [
			{
				rowId: shippedRow.id,
				action: 'accept',
				shipmentItems: [{itemIndex:0,action:'update',giftIds:[existing[0].id]}, {itemIndex:1,action:'update',giftIds:[existing[1].id]}]
			}
		]);
		expect(result.rowsFailed).toBe(0);
		expect(result.giftsCreated).toBe(0);
		expect(result.giftsLinked).toBe(2);
		const gifts = getDb()
			.prepare<[string], { person_id: number; status: string }>(
				`SELECT person_id, status FROM gifts
				  WHERE order_id = ? AND is_archived = 0
				  ORDER BY line_item_index`
			)
			.all(orderId);
		expect(gifts.length).toBe(2); // no dupes
		expect(gifts[0]).toEqual({ person_id: personA.id, status: 'shipped' });
		expect(gifts[1]).toEqual({ person_id: personB.id, status: 'shipped' });
	});

	it('Codex P1b: ambiguous duplicate-titles without explicit gifts stays pending', async () => {
		// Two same-title siblings, both assigned to the SAME recipient.
		// Then a shipped row commits with a line_item_index that DOESN'T
		// match either existing sibling's index. Fingerprint match
		// returns 2 candidates, line_item_index doesn't disambiguate,
		// recipient doesn't disambiguate (both for same person). Must
		// fail rather than silently grab one.
		const { admin, personA, runId } = bootstrap();
		const orderId = 'p1-codex-truly-ambiguous';
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Hallmark Card',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([
						{ title: 'Hallmark Card' },
						{ title: 'Hallmark Card' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personA.id }
				]
			}
		]);
		const shippedRow = seedImportRow({
			import_run_id: runId,
			email_type: 'shipped',
			parsed_title: 'Hallmark Card',
			parsed_order_id: orderId,
			parsed_tracking_number: '1Z999P1B',
			parsed_items_json: itemsJson([{ title: 'Hallmark Card' }])
		});
		const result = await commitReviewedRows(admin.id, [
			{
				rowId: shippedRow.id,
				action: 'accept',
				// idx=5 won't line up with the existing 0/1; both
				// existing are for personA so recipient doesn't help.
				lineItems: [{ lineItemIndex: 5, assignedPersonId: personA.id }]
			}
		]);
		expect(result.rowsFailed).toBe(0);
		expect(result.rowsAbstained).toBe(1);
		const row = getDb()
			.prepare<[number], { error_message: string | null }>(
				`SELECT error_message FROM import_rows WHERE id = ?`
			)
			.get(shippedRow.id);
		expect(row?.error_message ?? '').toMatch(/still need review/);
	});

	it('7. conflicting_override: legacy recipient-only input cannot reassign or create a shipment gift', async () => {
		const { admin, personA, personB, runId } = bootstrap();
		const orderId = '777-7777777-7777777';
		await commitReviewedRows(admin.id, [
			{
				rowId: seedImportRow({
					import_run_id: runId,
					email_type: 'order_placed',
					parsed_title: 'Endoscope Camera Kit',
					parsed_order_id: orderId,
					parsed_items_json: itemsJson([
						{ title: 'Endoscope Camera Kit' },
						{ title: 'Bluetooth Speaker' }
					])
				}).id,
				action: 'accept',
				lineItems: [
					{ lineItemIndex: 0, assignedPersonId: personA.id },
					{ lineItemIndex: 1, assignedPersonId: personB.id }
				]
			}
		]);
		// Now ship with a swapped recipient on the Endoscope item.
		const shippedRow = seedImportRow({
			import_run_id: runId,
			email_type: 'shipped',
			parsed_title: 'Endoscope Camera Kit',
			parsed_order_id: orderId,
			parsed_tracking_number: '1Z999DD',
			parsed_items_json: itemsJson([{ title: 'Endoscope Camera Kit' }])
		});
		const result = await commitReviewedRows(admin.id, [
			{
				rowId: shippedRow.id,
				action: 'accept',
				lineItems: [{ lineItemIndex: 0, assignedPersonId: personB.id }] // wrong person
			}
		]);
		expect(result.rowsFailed).toBe(0);
		const row = getDb()
			.prepare<[number], { disposition: string; error_message: string | null }>(
				`SELECT disposition, error_message FROM import_rows WHERE id = ?`
			)
			.get(shippedRow.id);
		expect(row?.disposition).toBe('accepted');
		expect(row?.error_message).toBeNull();
		// Existing gifts untouched.
		const gifts = getDb()
			.prepare<[string], { person_id: number; status: string }>(
				`SELECT person_id, status FROM gifts
				  WHERE order_id = ? AND is_archived = 0
				  ORDER BY line_item_index`
			)
			.all(orderId);
		expect(gifts.length).toBe(2);
		expect(gifts[0].person_id).toBe(personA.id);
		expect(gifts.map(g=>g.status)).toEqual(['shipped','ordered']);
	});
});
