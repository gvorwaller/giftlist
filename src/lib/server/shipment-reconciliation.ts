import { getDb } from './db';
import { logAudit } from './audit';
import { createGift } from './gifts';
import { isPersonVisibleToUser } from './people';
import { upsertOrderByOrderId, upsertShipment } from './orders';
import { getActiveExclusionKeywords, matchExcluded } from './exclusion-keywords';
import type { Gift, ImportRow } from './types';
import type { ParsedAmazonItem } from './amazon-parser';

export interface ShipmentDecision {
	itemIndex: number;
	action: 'pending' | 'match' | 'update' | 'ignore' | 'create';
	giftIds?: number[];
	personId?: number;
	orderId?: string;
}
export interface ShipmentGift extends Gift {
	personName: string;
	occasionLabel: string | null;
	canonicalOrderId: string | null;
}
export interface ShipmentItemPlan {
	itemIndex: number;
	item: ParsedAmazonItem;
	giftId: number | null;
	reason: string;
	resolved: boolean;
	savedAction: string | null;
	savedGiftIds: number[];
	excluded: boolean;
}
export interface ShipmentPlan {
	rowId: number;
	target: 'shipped' | 'delivered';
	orderIds: string[];
	items: ShipmentItemPlan[];
	gifts: ShipmentGift[];
}
const fingerprint = (title: string) =>
	title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function shipmentOrderIds(row: ImportRow): string[] {
	let refs: unknown = [];
	try {
		refs = JSON.parse(row.parsed_order_ids_json ?? '[]');
	} catch {
		/* legacy */
	}
	const ids = Array.isArray(refs)
		? refs.filter((x): x is string => typeof x === 'string' && /^\d{3}-\d{7}-\d{7}$/.test(x))
		: [];
	if (row.parsed_order_id && /^\d{3}-\d{7}-\d{7}$/.test(row.parsed_order_id))
		ids.push(row.parsed_order_id);
	return [...new Set(ids)];
}
export function listShipmentGifts(userId: number): ShipmentGift[] {
	return getDb()
		.prepare<[number], ShipmentGift>(
			`SELECT g.*,p.display_name AS personName,
 o.title AS occasionLabel,COALESCE(ord.order_id,g.order_id) AS canonicalOrderId
 FROM gifts g JOIN people p ON p.id=g.person_id LEFT JOIN occasions o ON o.id=g.occasion_id
 LEFT JOIN orders ord ON ord.id=g.order_pk
 WHERE p.is_archived=0 AND (p.is_self=0 OR p.owner_user_id=?)
 ORDER BY p.display_name,g.title,g.id`
		)
		.all(userId);
}
export function planShipment(
	row: ImportRow,
	userId: number,
	catalog?: ShipmentGift[]
): ShipmentPlan {
	if (row.email_type !== 'shipped' && row.email_type !== 'delivered')
		throw new Error('Not a shipment email');
	const db = getDb();
	const orderIds = shipmentOrderIds(row);
	const gifts = catalog ?? listShipmentGifts(userId);
	let items: ParsedAmazonItem[] = [];
	try {
		const parsed = JSON.parse(row.parsed_items_json ?? '[]');
		if (Array.isArray(parsed))
			items = parsed
				.filter((x) => x && typeof x.title === 'string')
				.map((x) => ({
					title: x.title,
					priceCents: x.priceCents ?? null,
					quantity: Number.isInteger(x.quantity) && x.quantity > 0 ? x.quantity : 1
				}));
	} catch {
		/* legacy unstructured email requires manual confirmation */
	}
	const enumerated = items.length > 0;
	if (!items.length)
		items = [
			{
				title: row.parsed_title ?? row.subject ?? 'Unidentified item',
				quantity: 1,
				priceCents: null
			}
		];
	const saved = db
		.prepare<
			[number],
			{ item_index: number; action: string }
		>('SELECT * FROM import_item_resolutions WHERE import_row_id=?')
		.all(row.id);
	const links = db
		.prepare<
			[number],
			{ item_index: number; gift_id: number }
		>('SELECT * FROM import_item_gifts WHERE import_row_id=?')
		.all(row.id);
	const exclusions = getActiveExclusionKeywords();
	return {
		rowId: row.id,
		target: row.email_type,
		orderIds,
		gifts,
		items: items.map((item, itemIndex) => {
			const previous = saved.find((s) => s.item_index === itemIndex);
			const sameTitleCount = items.filter(
				(i) => fingerprint(i.title) === fingerprint(item.title)
			).length;
			const candidates = gifts.filter(
				(g) =>
					g.canonicalOrderId &&
					orderIds.includes(g.canonicalOrderId) &&
					fingerprint(g.title) === fingerprint(item.title)
			);
			const unique =
				enumerated && item.quantity === 1 && sameTitleCount === 1 && candidates.length === 1
					? candidates[0]
					: null;
			// Archived gifts are evidence against duplicate creation, never automatic targets.
			const match =
				unique &&
				!unique.is_archived &&
				!links.some((l) => l.gift_id === unique.id && l.item_index !== itemIndex)
					? unique
					: null;
			return {
				itemIndex,
				item,
				giftId: match?.id ?? null,
				reason: match
					? 'Exact item description and an order referenced in this email.'
					: candidates.some((g) => g.is_archived)
						? 'An archived gift has this description and order. Review before creating another.'
						: item.quantity > 1 || sameTitleCount > 1 || candidates.length > 1
							? 'Repeated items or quantity need an explicit gift selection.'
							: 'Choose an existing gift, leave pending, or mark this item as not tracked.',
				resolved: !!previous && previous.action !== 'pending',
				savedAction: previous?.action ?? null,
				savedGiftIds: links.filter((l) => l.item_index === itemIndex).map((l) => l.gift_id),
				excluded: !!matchExcluded(item.title, exclusions)
			};
		})
	};
}

/** One short transaction re-plans, validates, applies and records each item.
 * Gmail changes happen later, only once every item has a durable decision. */
export function reconcileShipment(rowId: number, userId: number, decisions?: ShipmentDecision[]) {
	const db = getDb();
	return db.transaction(() => {
		const row = db.prepare<[number], ImportRow>('SELECT * FROM import_rows WHERE id=?').get(rowId);
		if (!row) throw new Error('Import row not found');
		if (row.disposition === 'accepted' || row.disposition === 'skipped')
			return { created: 0, linked: 0, advanced: 0, complete: true };
		const plan = planShipment(row, userId);
		const explicit = new Map<number, ShipmentDecision>();
		for (const d of decisions ?? []) {
			if (!Number.isInteger(d.itemIndex) || !plan.items[d.itemIndex] || explicit.has(d.itemIndex))
				throw new Error('Invalid or duplicate shipment item');
			if (!['pending', 'match', 'update', 'ignore', 'create'].includes(d.action))
				throw new Error('Invalid shipment action');
			explicit.set(d.itemIndex, d);
		}
		let created = 0,
			linked = 0,
			advanced = 0,
			pending = 0;
		const used = new Set(
			db
				.prepare<[number], { gift_id: number }>(
					'SELECT gift_id FROM import_item_gifts WHERE import_row_id=?'
				)
				.all(rowId)
				.map((l) => l.gift_id)
		);
		const received = row.received_at?.replace(
			/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/,
			'$1T$2Z'
		);
		const time =
			received && Number.isFinite(Date.parse(received))
				? new Date(received).toISOString().slice(0, 19).replace('T', ' ')
				: null;
		for (const entry of plan.items) {
			if (entry.resolved) continue;
			const d = explicit.get(entry.itemIndex) ?? {
				itemIndex: entry.itemIndex,
				action: entry.excluded ? 'ignore' : entry.giftId ? 'match' : 'pending'
			};
			let ids: number[] = [];
			const action: 'pending' | 'update' | 'ignore' | 'create' =
				d.action === 'match' ? 'update' : d.action;
			if (d.action === 'match') {
				if (
					!entry.giftId ||
					(d.giftIds && (d.giftIds.length !== 1 || d.giftIds[0] !== entry.giftId))
				)
					throw new Error('Suggested match changed. Reload and review this shipment.');
				ids = [entry.giftId];
			} else if (d.action === 'update') ids = d.giftIds ?? [];
			if (action === 'update') {
				if (ids.length !== entry.item.quantity || new Set(ids).size !== ids.length)
					throw new Error('Select one existing gift for each unit in this item.');
				for (const id of ids) {
					const g = plan.gifts.find((g) => g.id === id);
					if (!g || g.is_archived || !isPersonVisibleToUser(g.person_id, userId))
						throw new Error('Selected gift is unavailable. Reload and review.');

					if (used.has(id)) throw new Error('The same gift cannot resolve two different items.');
				}
			}
			if (action === 'create') {
				if (!d.personId || !isPersonVisibleToUser(d.personId, userId))
					throw new Error('Choose a visible recipient for the new gift.');
				if (plan.orderIds.length > 0 && (!d.orderId || !plan.orderIds.includes(d.orderId)))
					throw new Error('Choose the source order for the new gift.');
				if (d.orderId && !plan.orderIds.includes(d.orderId))
					throw new Error('Order is not referenced by this email.');
				if (entry.item.quantity > 50)
					throw new Error('Review this unusually large quantity individually before importing.');
				const orderPk = d.orderId ? upsertOrderByOrderId({ order_id: d.orderId }) : null;
				for (let n = 0; n < entry.item.quantity; n++) {
					const next = orderPk
						? db
								.prepare<
									[number],
									{ n: number }
								>('SELECT COALESCE(MAX(line_item_index),-1)+1 AS n FROM gifts WHERE order_pk=?')
								.get(orderPk)!.n
						: null;
					const gift = createGift(
						{
							person_id: d.personId,
							title: entry.item.title,
							source: 'Amazon',
							status: 'ordered',
							order_id: d.orderId ?? null,
							order_pk: orderPk,
							line_item_index: next,
							price_cents: entry.item.quantity === 1 ? entry.item.priceCents : null
						},
						userId
					);
					ids.push(gift.id);
					created++;
				}
			}
			if (action === 'pending') pending++;
			db.prepare(
				`INSERT INTO import_item_resolutions(import_row_id,item_index,action,gift_id,actor_user_id)
 VALUES(?,?,?,?,?) ON CONFLICT(import_row_id,item_index) DO UPDATE SET action=excluded.action,gift_id=excluded.gift_id,actor_user_id=excluded.actor_user_id,updated_at=CURRENT_TIMESTAMP`
			).run(rowId, entry.itemIndex, action, ids[0] ?? null, userId);
			for (const id of ids) {
				used.add(id);
				const g = db.prepare<[number], Gift>('SELECT * FROM gifts WHERE id=?').get(id)!;
				// Use the gift's own order, never the first reference in the incoming email.
				const orderPk =
					g.order_pk ?? (g.order_id ? upsertOrderByOrderId({ order_id: g.order_id }) : null);
				if (!g.order_pk && orderPk)
					db.prepare('UPDATE gifts SET order_pk=? WHERE id=?').run(orderPk, id);
				const shipmentId = orderPk
					? upsertShipment({
							order_pk: orderPk,
							source_message_id: row.source_message_id,
							tracking_number: row.parsed_tracking_number,
							carrier: row.parsed_carrier,
							amazon_tracking_url: row.parsed_amazon_tracking_url,
							shipped_at: plan.target === 'shipped' ? time : null,
							delivered_at: plan.target === 'delivered' ? time : null
						})
					: null;
				db.prepare(
					'INSERT INTO import_item_gifts(import_row_id,item_index,gift_id,shipment_id) VALUES(?,?,?,?)'
				).run(rowId, entry.itemIndex, id, shipmentId);
				const progression = [
					'idea',
					'planned',
					'ordered',
					'shipped',
					'delivered',
					'wrapped',
					'given'
				];
				const advance =
					g.status !== 'returned' &&
					progression.indexOf(g.status) < progression.indexOf(plan.target);
				const ts = plan.target === 'shipped' ? 'shipped_at' : 'delivered_at';
				db.prepare(
					`UPDATE gifts SET status=?, ${ts}=COALESCE(${ts},?),
 tracking_number=COALESCE(tracking_number,?),carrier=COALESCE(carrier,?),
 amazon_tracking_url=COALESCE(amazon_tracking_url,?),shipment_id=COALESCE(shipment_id,?),updated_at=CURRENT_TIMESTAMP WHERE id=?`
				).run(
					advance ? plan.target : g.status,
					time,
					row.parsed_tracking_number,
					row.parsed_carrier,
					row.parsed_amazon_tracking_url,
					shipmentId,
					id
				);
				if (advance) advanced++;
				if (action === 'update') linked++;
				logAudit({
					actorUserId: userId,
					entityType: 'gift',
					entityId: id,
					action: advance ? `status_${plan.target}` : 'shipment_linked',
					summary: `Amazon ${plan.target} email linked to "${g.title}"; recipient and occasion retained (import ${rowId}, item ${entry.itemIndex + 1}).`
				});
			}
			if (action !== 'pending')
				logAudit({
					actorUserId: userId,
					entityType: 'import',
					entityId: rowId,
					action: `shipment_item_${action}`,
					summary: `Item ${entry.itemIndex + 1}: ${entry.item.title}; gifts ${ids.join(', ') || 'none'}.`
				});
		}
		// Rebuild shipment contents from durable links, including previous partial commits.
		const shipments = db
			.prepare<
				[number],
				{ shipment_id: number }
			>('SELECT DISTINCT shipment_id FROM import_item_gifts WHERE import_row_id=? AND shipment_id IS NOT NULL')
			.all(rowId);
		for (const { shipment_id } of shipments) {
			const contents = db
				.prepare<[number, number], { title: string; quantity: number; priceCents: number | null }>(
					`SELECT g.title,COUNT(g.id) AS quantity,
 CASE WHEN COUNT(g.id)=1 THEN MIN(g.price_cents) ELSE NULL END AS priceCents
 FROM gifts g WHERE g.shipment_id=? OR g.id IN (SELECT gift_id FROM import_item_gifts WHERE shipment_id=?) GROUP BY g.title`
				)
				.all(shipment_id, shipment_id);
			db.prepare('UPDATE order_shipments SET items_json=? WHERE id=?').run(
				JSON.stringify(contents),
				shipment_id
			);
		}
		const first = db
			.prepare<
				[number],
				{ gift_id: number; person_id: number }
			>(`SELECT l.gift_id,g.person_id FROM import_item_gifts l JOIN gifts g ON g.id=l.gift_id WHERE l.import_row_id=? ORDER BY l.item_index,g.id LIMIT 1`)
			.get(rowId);
		db.prepare(
			`UPDATE import_rows SET disposition=?,gift_id=?,match_person_id=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`
		).run(
			pending ? 'pending' : 'accepted',
			first?.gift_id ?? null,
			first?.person_id ?? null,
			pending ? `${pending} item(s) still need review. Resolved items have been saved.` : null,
			rowId
		);
		return { created, linked, advanced, complete: pending === 0 };
	})();
}
