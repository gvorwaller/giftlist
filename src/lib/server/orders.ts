import { getDb } from './db';
import { scoreOverlap } from './gift-matcher';
import type { Gift, Order, OrderShipment } from './types';

/** Minimum token-overlap score for a heuristic shipment-to-sibling
 * match. Below this, the heuristic doesn't claim a match — caller
 * consults the LLM (Phase 2) or routes the row to review. 0.3 mirrors
 * the prior Phase-A weak-match floor; the safety story comes from the
 * abstain path in `applyLifecycleEvent`, not from a high threshold. */
const SHIPMENT_OVERLAP_THRESHOLD = 0.3;

/**
 * td-3e9ae2: order CRUD helpers.
 *
 * `orders` is 1:N with `gifts` — every Amazon-imported order has exactly one
 * row here; gifts FK back via `gifts.order_pk`. Order-level facts (tracking,
 * carrier, lifecycle timestamps, Amazon URL) live here so a multi-item order
 * with N gifts shares ONE shipment record instead of N denormalized copies.
 */

export function getOrderById(id: number): Order | undefined {
	const db = getDb();
	return db.prepare<[number], Order>('SELECT * FROM orders WHERE id = ?').get(id);
}

export function getOrderByOrderId(orderId: string): Order | undefined {
	const db = getDb();
	return db.prepare<[string], Order>('SELECT * FROM orders WHERE order_id = ?').get(orderId);
}

export interface OrderUpsertInput {
	order_id: string;
	vendor_id?: number | null;
	shipper_id?: number | null;
	order_total_cents?: number | null;
	tracking_number?: string | null;
	carrier?: string | null;
	tracking_provider_id?: string | null;
	amazon_tracking_url?: string | null;
	ordered_at?: string | null;
	shipped_at?: string | null;
	delivered_at?: string | null;
	source_message_id?: string | null;
}

/**
 * Idempotent upsert keyed by `order_id`. Inserts a new row if absent; updates
 * the existing row by filling any NULL columns from the input. Never overwrites
 * a non-null tracking value — the first email's data wins, subsequent emails
 * only fill gaps. Returns the order's primary key.
 */
export function upsertOrderByOrderId(input: OrderUpsertInput): number {
	const db = getDb();
	const existing = getOrderByOrderId(input.order_id);
	if (existing) {
		// Fill-only update: COALESCE keeps any non-null existing value.
		db.prepare(
			`UPDATE orders
			    SET vendor_id            = COALESCE(vendor_id, ?),
			        shipper_id           = COALESCE(shipper_id, ?),
			        order_total_cents    = COALESCE(order_total_cents, ?),
			        tracking_number      = COALESCE(tracking_number, ?),
			        carrier              = COALESCE(carrier, ?),
			        tracking_provider_id = COALESCE(tracking_provider_id, ?),
			        amazon_tracking_url  = COALESCE(amazon_tracking_url, ?),
			        ordered_at           = COALESCE(ordered_at, ?),
			        shipped_at           = COALESCE(shipped_at, ?),
			        delivered_at         = COALESCE(delivered_at, ?),
			        source_message_id    = COALESCE(source_message_id, ?),
			        updated_at           = CURRENT_TIMESTAMP
			  WHERE id = ?`
		).run(
			input.vendor_id ?? null,
			input.shipper_id ?? null,
			input.order_total_cents ?? null,
			input.tracking_number ?? null,
			input.carrier ?? null,
			input.tracking_provider_id ?? null,
			input.amazon_tracking_url ?? null,
			input.ordered_at ?? null,
			input.shipped_at ?? null,
			input.delivered_at ?? null,
			input.source_message_id ?? null,
			existing.id
		);
		return existing.id;
	}
	const info = db
		.prepare(
			`INSERT INTO orders (
			   order_id, vendor_id, shipper_id, order_total_cents,
			   tracking_number, carrier, tracking_provider_id, amazon_tracking_url,
			   ordered_at, shipped_at, delivered_at, source_message_id
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.order_id,
			input.vendor_id ?? null,
			input.shipper_id ?? null,
			input.order_total_cents ?? null,
			input.tracking_number ?? null,
			input.carrier ?? null,
			input.tracking_provider_id ?? null,
			input.amazon_tracking_url ?? null,
			input.ordered_at ?? null,
			input.shipped_at ?? null,
			input.delivered_at ?? null,
			input.source_message_id ?? null
		);
	return Number(info.lastInsertRowid);
}

/** Returns every gift under the given order, in line-item order. */
export function listGiftsForOrder(orderPk: number): Gift[] {
	const db = getDb();
	return db
		.prepare<[number], Gift>(
			`SELECT * FROM gifts
			  WHERE order_pk = ? AND is_archived = 0
			  ORDER BY COALESCE(line_item_index, 0), id`
		)
		.all(orderPk);
}

// ---------------------------------------------------------------------
// td-d08902: per-shipment helpers.
//
// One `order_shipments` row per real shipment. Multi-item / multi-recipient
// orders can ship in batches; each batch lands in a distinct shipment row
// and only the gifts contained in that batch get attached + status-advanced.

export interface ShipmentUpsertInput {
	order_pk: number;
	tracking_number?: string | null;
	carrier?: string | null;
	tracking_provider_id?: string | null;
	amazon_tracking_url?: string | null;
	shipped_at?: string | null;
	delivered_at?: string | null;
	source_message_id?: string | null;
	items_json?: string | null;
}

export function getShipmentById(id: number): OrderShipment | undefined {
	const db = getDb();
	return db.prepare<[number], OrderShipment>('SELECT * FROM order_shipments WHERE id = ?').get(id);
}

export function listShipmentsForOrder(orderPk: number): OrderShipment[] {
	const db = getDb();
	return db
		.prepare<[number], OrderShipment>(
			`SELECT * FROM order_shipments
			  WHERE order_pk = ?
			  ORDER BY COALESCE(shipped_at, created_at), id`
		)
		.all(orderPk);
}

/**
 * Find an existing shipment under this order matching the given tracking
 * number (preferred) or source message id (fallback for emails that arrived
 * without a parseable tracking#). Returns undefined if no shipment yet
 * matches — caller creates a new one.
 */
export function findShipment(
	orderPk: number,
	trackingNumber: string | null,
	sourceMessageId: string | null
): OrderShipment | undefined {
	const db = getDb();
	if (trackingNumber) {
		const byTracking = db
			.prepare<[number, string], OrderShipment>(
				`SELECT * FROM order_shipments
				  WHERE order_pk = ? AND tracking_number = ?
				  ORDER BY id ASC LIMIT 1`
			)
			.get(orderPk, trackingNumber);
		if (byTracking) return byTracking;
	}
	if (sourceMessageId) {
		const byMsg = db
			.prepare<[number, string], OrderShipment>(
				`SELECT * FROM order_shipments
				  WHERE order_pk = ? AND source_message_id = ?
				  ORDER BY id ASC LIMIT 1`
			)
			.get(orderPk, sourceMessageId);
		if (byMsg) return byMsg;
	}
	return undefined;
}

/**
 * Idempotent shipment creation. Reuses an existing shipment row keyed by
 * (order_pk, tracking_number) or (order_pk, source_message_id) when present,
 * filling NULL fields from the input. Otherwise inserts a new row. Returns
 * the shipment id.
 */
export function upsertShipment(input: ShipmentUpsertInput): number {
	const db = getDb();
	const existing = findShipment(
		input.order_pk,
		input.tracking_number ?? null,
		input.source_message_id ?? null
	);
	if (existing) {
		db.prepare(
			`UPDATE order_shipments
			    SET tracking_number      = COALESCE(tracking_number, ?),
			        carrier              = COALESCE(carrier, ?),
			        tracking_provider_id = COALESCE(tracking_provider_id, ?),
			        amazon_tracking_url  = COALESCE(amazon_tracking_url, ?),
			        shipped_at           = COALESCE(shipped_at, ?),
			        delivered_at         = COALESCE(delivered_at, ?),
			        source_message_id    = COALESCE(source_message_id, ?),
			        items_json           = COALESCE(items_json, ?),
			        updated_at           = CURRENT_TIMESTAMP
			  WHERE id = ?`
		).run(
			input.tracking_number ?? null,
			input.carrier ?? null,
			input.tracking_provider_id ?? null,
			input.amazon_tracking_url ?? null,
			input.shipped_at ?? null,
			input.delivered_at ?? null,
			input.source_message_id ?? null,
			input.items_json ?? null,
			existing.id
		);
		return existing.id;
	}
	const info = db
		.prepare(
			`INSERT INTO order_shipments (
			   order_pk, tracking_number, carrier, tracking_provider_id,
			   amazon_tracking_url, shipped_at, delivered_at,
			   source_message_id, items_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.order_pk,
			input.tracking_number ?? null,
			input.carrier ?? null,
			input.tracking_provider_id ?? null,
			input.amazon_tracking_url ?? null,
			input.shipped_at ?? null,
			input.delivered_at ?? null,
			input.source_message_id ?? null,
			input.items_json ?? null
		);
	return Number(info.lastInsertRowid);
}

/**
 * td-d08902: given a list of item titles claimed to be in this shipment
 * (from the parsed Amazon email body) and the sibling gifts under the
 * parent order, return the subset of siblings that match those titles via
 * the Phase-A fuzzy matcher.
 *
 * Returns ALL siblings if the email had no item titles (legacy/single-item
 * shipping notification). Returns an empty array when item titles are
 * present but none match — caller may decide to fall back to "advance all"
 * with a log.
 */
/**
 * Heuristic-only sibling-to-shipment matcher. Pairs each shipped item
 * title against the order's siblings using token overlap; siblings
 * scoring at or above `SHIPMENT_OVERLAP_THRESHOLD` are considered
 * matched.
 *
 * Wave 1: when `shippedItemTitles` is empty (legacy / single-item
 * shipping notification) the caller previously fell back to "advance
 * ALL siblings". That fallback is removed at the call site — instead
 * the caller queries the LLM via `llmMatchShipment` and respects its
 * `safe_to_apply` verdict. This function now ONLY reports what the
 * heuristic can determine; it never speaks for the LLM.
 *
 * Returns:
 *   - matched: siblings the heuristic confidently pairs with at least
 *     one shipment item title.
 *   - itemsHadTitles: false when the shipment email enumerated no
 *     items (caller must use LLM or abstain).
 *   - heuristicCertain: true when items WERE enumerated AND every item
 *     paired with a sibling at >= threshold. Callers can skip the LLM
 *     when this is true.
 */
export function matchSiblingsToShipment(
	siblings: Gift[],
	shippedItemTitles: string[]
): { matched: Gift[]; itemsHadTitles: boolean; heuristicCertain: boolean } {
	if (shippedItemTitles.length === 0) {
		return { matched: [], itemsHadTitles: false, heuristicCertain: false };
	}
	const matchedIds = new Set<number>();
	let everyItemMatched = true;
	for (const itemTitle of shippedItemTitles) {
		let itemMatched = false;
		for (const s of siblings) {
			if (scoreOverlap(s.title, itemTitle) >= SHIPMENT_OVERLAP_THRESHOLD) {
				matchedIds.add(s.id);
				itemMatched = true;
			}
		}
		if (!itemMatched) everyItemMatched = false;
	}
	return {
		matched: siblings.filter((s) => matchedIds.has(s.id)),
		itemsHadTitles: true,
		heuristicCertain: everyItemMatched && matchedIds.size > 0
	};
}
