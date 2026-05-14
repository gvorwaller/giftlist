import { getDb } from './db';
import type { Gift, Order } from './types';

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
