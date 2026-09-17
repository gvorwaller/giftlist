import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
	setupTestDb,
	teardownTestDb,
	seedUser,
	seedPerson,
	seedGift,
	seedImportRun,
	seedImportRow,
	itemsJson
} from './test-harness';
import { getDb } from './db';
import { commitReviewedRows } from './jobs/amazon-import';
vi.mock('./gmail-reader', async () => ({
	...(await vi.importActual('./gmail-reader')),
	batchMoveToLabel: vi.fn()
}));
import { batchMoveToLabel } from './gmail-reader';
beforeEach(() => {
	setupTestDb();
	vi.clearAllMocks();
});
afterEach(teardownTestDb);
const cardsOrder = '113-2783402-5371454';
const glovesOrder = '113-1189617-2562657';
const card = 'Mcduldul Son In Law Birthday Card, Happy Birthday Gift for Him Men';
const otherCard = 'Turypaty Happy 40th Birthday Music Card Gifts Pop Up 3D Cake Firework Light';
const gloves = 'ForPro Disposable Vinyl Gloves, 3.9 Mil, Powder & Latex-Free, Food Safe';
function fixture(type: 'shipped' | 'delivered' = 'shipped') {
	const user = seedUser({ username: 'admin' });
	const steve = seedPerson({ display_name: 'Steve Pereira' });
	const other = seedPerson({ display_name: 'Other recipient' });
	const a = seedGift({ person_id: steve.id, title: card, status: 'ordered', order_id: cardsOrder });
	const b = seedGift({
		person_id: other.id,
		title: otherCard,
		status: 'ordered',
		order_id: cardsOrder
	});
	const run = seedImportRun({ actor_user_id: user.id });
	const row = seedImportRow({
		import_run_id: run,
		email_type: type,
		parsed_order_id: glovesOrder,
		parsed_items_json: itemsJson([{ title: gloves }, { title: card }, { title: otherCard }])
	});
	// Available on new scans; old rows retain their single reference and require manual selection.
	getDb()
		.prepare('UPDATE import_rows SET parsed_order_ids_json = ? WHERE id = ?')
		.run(JSON.stringify([glovesOrder, cardsOrder]), row.id);
	return { user, steve, other, a, b, row };
}
it('combined-order shipment advances both known cards while the gloves stay pending; retry does not create gifts', async () => {
	const { user, a, b, row } = fixture();
	const first = await commitReviewedRows(user.id, [{ rowId: row.id, action: 'accept' }]);
	expect(first.siblingsAdvanced).toBe(2);
	expect(getDb().prepare('SELECT title,status,order_id FROM gifts ORDER BY id').all()).toEqual([
		{ title: card, status: 'shipped', order_id: cardsOrder },
		{ title: otherCard, status: 'shipped', order_id: cardsOrder }
	]);
	expect(getDb().prepare('SELECT disposition FROM import_rows WHERE id=?').get(row.id)).toEqual({
		disposition: 'pending'
	});
	expect(batchMoveToLabel).not.toHaveBeenCalledWith(
		user.id,
		[row.source_message_id],
		expect.anything(),
		expect.anything()
	);
	const retry = await commitReviewedRows(user.id, [
		{ rowId: row.id, action: 'accept', shipmentItems: [{ itemIndex: 0, action: 'ignore' }] }
	]);
	expect(retry.giftsCreated).toBe(0);
	expect(retry.siblingsAdvanced).toBe(0);
	expect(
		getDb()
			.prepare(
				'SELECT gift_id FROM import_item_resolutions WHERE gift_id IS NOT NULL ORDER BY item_index'
			)
			.all()
	).toEqual([{ gift_id: a.id }, { gift_id: b.id }]);
	expect(getDb().prepare('SELECT disposition FROM import_rows WHERE id=?').get(row.id)).toEqual({
		disposition: 'accepted'
	});
});
it('delivery catches up directly from ordered using event time, without inventing a shipped date', async () => {
	const { user, a, row } = fixture('delivered');
	await commitReviewedRows(user.id, [{ rowId: row.id, action: 'accept' }]);
	expect(
		getDb().prepare('SELECT status,shipped_at,delivered_at FROM gifts WHERE id=?').get(a.id)
	).toEqual({ status: 'delivered', shipped_at: null, delivered_at: '2026-05-19 12:00:00' });
});

import { planShipment } from './shipment-reconciliation';
import { buildAutoAcceptDecisions } from './jobs/amazon-import';
import type { ImportRow } from './types';
const freshRow = (id: number) =>
	getDb().prepare<[number], ImportRow>('SELECT * FROM import_rows WHERE id=?').get(id)!;
const giftState = (id: number) =>
	getDb()
		.prepare('SELECT person_id,status,order_id,occasion_year,is_archived FROM gifts WHERE id=?')
		.get(id);

it('manual choice can link a differently described gift across orders without reparenting it', async () => {
	const { user, a, row } = fixture();
	const result = await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [
				{ itemIndex: 0, action: 'update', giftIds: [a.id] },
				{ itemIndex: 1, action: 'ignore' },
				{ itemIndex: 2, action: 'pending' }
			]
		}
	]);
	expect(result.rowsFailed).toBe(0);
	expect(result.giftsCreated).toBe(0);
	expect(giftState(a.id)).toMatchObject({
		person_id: a.person_id,
		status: 'shipped',
		order_id: cardsOrder,
		occasion_year: 2026
	});
});
it('archived duplicates block automatic guessing and stay archived; explicit active-gift selection works', async () => {
	const { user, steve, a, row } = fixture();
	const archived = seedGift({
		person_id: steve.id,
		title: card,
		status: 'ordered',
		order_id: glovesOrder,
		is_archived: 1
	});
	const plan = planShipment(freshRow(row.id), user.id);
	expect(plan.items[1].giftId).toBeNull();
	expect(plan.items[1].reason).toContain('archived');
	await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [{ itemIndex: 1, action: 'update', giftIds: [a.id] }]
		}
	]);
	expect(giftState(a.id)).toMatchObject({ status: 'shipped' });
	expect(giftState(archived.id)).toMatchObject({ status: 'ordered', is_archived: 1 });
});
it('ambiguous same-title gifts for different people remain pending until named gifts are chosen', async () => {
	const { user, other, a, row } = fixture();
	const duplicate = seedGift({
		person_id: other.id,
		title: card,
		status: 'ordered',
		order_id: cardsOrder
	});
	expect(planShipment(freshRow(row.id), user.id).items[1].giftId).toBeNull();
	await commitReviewedRows(user.id, [{ rowId: row.id, action: 'accept' }]);
	expect(giftState(a.id)).toMatchObject({ status: 'ordered' });
	await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [{ itemIndex: 1, action: 'update', giftIds: [duplicate.id] }]
		}
	]);
	expect(giftState(duplicate.id)).toMatchObject({ status: 'shipped', person_id: other.id });
	expect(giftState(a.id)).toMatchObject({ status: 'ordered' });
});
it('quantity two requires two distinct gift selections, supports separate recipients, and rolls back incomplete selections', async () => {
	const { user, other, a, row } = fixture();
	const second = seedGift({
		person_id: other.id,
		title: card,
		status: 'ordered',
		order_id: cardsOrder
	});
	getDb()
		.prepare('UPDATE import_rows SET parsed_items_json=? WHERE id=?')
		.run(itemsJson([{ title: card, quantity: 2 }]), row.id);
	expect(planShipment(freshRow(row.id), user.id).items[0].giftId).toBeNull();
	const bad = await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [{ itemIndex: 0, action: 'update', giftIds: [a.id] }]
		}
	]);
	expect(bad.rowsFailed).toBe(1);
	expect(giftState(a.id)).toMatchObject({ status: 'ordered' });
	const good = await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [{ itemIndex: 0, action: 'update', giftIds: [a.id, second.id] }]
		}
	]);
	expect(good.rowsFailed).toBe(0);
	expect(good.siblingsAdvanced).toBe(2);
	expect(
		getDb().prepare('SELECT COUNT(*) n FROM import_item_gifts WHERE import_row_id=?').get(row.id)
	).toEqual({ n: 2 });
});
it('repeated item titles never use shipment indexes as purchase identities', async () => {
	const { user, a, row } = fixture();
	getDb()
		.prepare('UPDATE import_rows SET parsed_items_json=? WHERE id=?')
		.run(itemsJson([{ title: card }, { title: card }]), row.id);
	expect(planShipment(freshRow(row.id), user.id).items.every((i) => i.giftId === null)).toBe(true);
	const bad = await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [
				{ itemIndex: 0, action: 'update', giftIds: [a.id] },
				{ itemIndex: 1, action: 'update', giftIds: [a.id] }
			]
		}
	]);
	expect(bad.rowsFailed).toBe(1);
	expect(giftState(a.id)).toMatchObject({ status: 'ordered' });
	expect(getDb().prepare('SELECT COUNT(*) n FROM import_item_resolutions').get()).toEqual({ n: 0 });
});
it('commit rejects a stale suggested match and leaves all gifts unchanged', async () => {
	const { user, steve, a, row } = fixture();
	expect(planShipment(freshRow(row.id), user.id).items[1].giftId).toBe(a.id);
	seedGift({ person_id: steve.id, title: card, status: 'ordered', order_id: cardsOrder });
	const result = await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [{ itemIndex: 1, action: 'match', giftIds: [a.id] }]
		}
	]);
	expect(result.rowsFailed).toBe(1);
	expect(giftState(a.id)).toMatchObject({ status: 'ordered' });
});
it.each(['delivered', 'wrapped', 'given', 'returned'] as const)(
	'shipping does not downgrade %s',
	async (status) => {
		const { user, a, row } = fixture();
		getDb().prepare('UPDATE gifts SET status=? WHERE id=?').run(status, a.id);
		await commitReviewedRows(user.id, [{ rowId: row.id, action: 'accept' }]);
		expect(giftState(a.id)).toMatchObject({ status });
	}
);
it('later-arriving shipment after delivery fills only the evidenced timestamp', async () => {
	const { user, a, row } = fixture('delivered');
	await commitReviewedRows(user.id, [{ rowId: row.id, action: 'accept' }]);
	const shipped = seedImportRow({
		import_run_id: row.import_run_id,
		email_type: 'shipped',
		parsed_order_id: cardsOrder,
		parsed_items_json: itemsJson([{ title: card }])
	});
	getDb()
		.prepare('UPDATE import_rows SET received_at=? WHERE id=?')
		.run('2026-05-18T10:30:00Z', shipped.id);
	await commitReviewedRows(user.id, [{ rowId: shipped.id, action: 'accept' }]);
	expect(
		getDb().prepare('SELECT status,shipped_at,delivered_at FROM gifts WHERE id=?').get(a.id)
	).toEqual({
		status: 'delivered',
		shipped_at: '2026-05-18 10:30:00',
		delivered_at: '2026-05-19 12:00:00'
	});
});
it('explicit create requires a source order and is idempotent after a successful commit', async () => {
	const { user, steve, row } = fixture();
	const invalid = await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [{ itemIndex: 0, action: 'create', personId: steve.id }]
		}
	]);
	expect(invalid.rowsFailed).toBe(1);
	expect(getDb().prepare('SELECT COUNT(*) n FROM gifts').get()).toEqual({ n: 2 });
	const decisions = [
		{
			rowId: row.id,
			action: 'accept' as const,
			shipmentItems: [
				{ itemIndex: 0, action: 'create' as const, personId: steve.id, orderId: glovesOrder }
			]
		}
	];
	const first = await commitReviewedRows(user.id, decisions);
	const second = await commitReviewedRows(user.id, decisions);
	expect(first.giftsCreated).toBe(1);
	expect(second.giftsCreated).toBe(0);
	expect(getDb().prepare('SELECT COUNT(*) n FROM gifts').get()).toEqual({ n: 3 });
});
it('private recipients cannot be selected by another user, including crafted requests', async () => {
	const { user, steve, a, row } = fixture();
	const otherUser = seedUser({ username: 'private' });
	getDb()
		.prepare('UPDATE people SET is_self=1,owner_user_id=? WHERE id=?')
		.run(otherUser.id, steve.id);
	expect(planShipment(freshRow(row.id), user.id).gifts.some((g) => g.id === a.id)).toBe(false);
	const result = await commitReviewedRows(user.id, [
		{
			rowId: row.id,
			action: 'accept',
			shipmentItems: [{ itemIndex: 1, action: 'update', giftIds: [a.id] }]
		}
	]);
	expect(result.rowsFailed).toBe(1);
	expect(giftState(a.id)).toMatchObject({ status: 'ordered' });
});
it('auto-accept uses exact shipment evidence without an LLM and abstains for any unresolved item', () => {
	const { user, row } = fixture();
	void user;
	expect(buildAutoAcceptDecisions([freshRow(row.id)])).toHaveLength(0);
	getDb()
		.prepare('UPDATE import_rows SET parsed_items_json=? WHERE id=?')
		.run(itemsJson([{ title: otherCard }, { title: card }]), row.id);
	const decisions = buildAutoAcceptDecisions([freshRow(row.id)]);
	expect(decisions).toHaveLength(1);
	expect(decisions[0].shipmentItems?.every((i) => i.action === 'match')).toBe(true);
});

it('one email can update gifts under two orders with separate shipments linked to the same event', async () => {
	const { user, steve, row } = fixture();
	const gift = seedGift({
		person_id: steve.id,
		title: gloves,
		status: 'ordered',
		order_id: glovesOrder
	});
	const result = await commitReviewedRows(user.id, [{ rowId: row.id, action: 'accept' }]);
	expect(result.siblingsAdvanced).toBe(3);
	expect(result.giftsCreated).toBe(0);
	expect(giftState(gift.id)).toMatchObject({ order_id: glovesOrder });
	const shipments = getDb()
		.prepare('SELECT source_message_id,items_json FROM order_shipments ORDER BY id')
		.all() as { source_message_id: string; items_json: string }[];
	expect(shipments).toHaveLength(2);
	expect(shipments.every((s) => s.source_message_id === row.source_message_id)).toBe(true);
	expect(shipments.map((s) => JSON.parse(s.items_json).length).sort()).toEqual([1, 2]);
});
it('skip records ignored decisions without advancing or creating gifts', async () => {
	const { user, a, row } = fixture();
	const result = await commitReviewedRows(user.id, [{ rowId: row.id, action: 'skip' }]);
	expect(result.rowsSkipped).toBe(1);
	expect(giftState(a.id)).toMatchObject({ status: 'ordered' });
	expect(
		getDb().prepare("SELECT COUNT(*) n FROM import_item_resolutions WHERE action='ignore'").get()
	).toEqual({ n: 3 });
});
