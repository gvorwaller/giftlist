import { getDb } from './db';
import { logAudit } from './audit';
import { getVendorById } from './vendors';
import { getShipperById } from './shippers';
import type { Gift, GiftStatus, Occasion, Person } from './types';
import type { Vendor } from './vendors';
import type { Shipper } from './shippers';

export interface GiftCreateInput {
	person_id: number;
	title: string;
	source?: string | null;
	source_url?: string | null;
	occasion_id?: number | null;
	occasion_year?: number | null;
	order_id?: string | null;
	tracking_number?: string | null;
	carrier?: string | null;
	price_cents?: number | null;
	notes?: string | null;
	status?: GiftStatus;
	is_idea?: boolean;
	vendor_id?: number | null;
	shipper_id?: number | null;
}

export interface GiftUpdateInput {
	person_id?: number;
	title?: string;
	source?: string | null;
	source_url?: string | null;
	occasion_id?: number | null;
	occasion_year?: number | null;
	order_id?: string | null;
	tracking_number?: string | null;
	carrier?: string | null;
	price_cents?: number | null;
	notes?: string | null;
	vendor_id?: number | null;
	shipper_id?: number | null;
	tracking_status?: string | null;
	tracking_status_at?: string | null;
	tracking_estimated_delivery?: string | null;
	tracking_provider_id?: string | null;
}

export interface GiftWithContext extends Gift {
	person: Person;
	occasion: Occasion | null;
	vendor: Vendor | null;
	shipper: Shipper | null;
}

export interface ListGiftsOptions {
	personId?: number;
	statuses?: GiftStatus[];
	includeArchived?: boolean;
	order?: 'updated_desc' | 'created_desc' | 'shipped_desc';
}

export function listGifts(opts: ListGiftsOptions = {}): Gift[] {
	const db = getDb();
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (!opts.includeArchived) where.push('g.is_archived = 0');
	if (opts.personId) {
		where.push('g.person_id = ?');
		params.push(opts.personId);
	}
	if (opts.statuses && opts.statuses.length > 0) {
		where.push(`g.status IN (${opts.statuses.map(() => '?').join(',')})`);
		params.push(...opts.statuses);
	}
	const orderBy =
		opts.order === 'shipped_desc'
			? 'COALESCE(g.shipped_at, g.created_at) DESC'
			: opts.order === 'created_desc'
				? 'g.created_at DESC'
				: 'g.updated_at DESC';
	const sql = `SELECT g.* FROM gifts g ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}`;
	return db.prepare<typeof params, Gift>(sql).all(...params);
}

export function getGiftById(id: number): Gift | undefined {
	const db = getDb();
	return db.prepare<[number], Gift>('SELECT * FROM gifts WHERE id = ?').get(id);
}

export function getGiftWithContext(id: number): GiftWithContext | undefined {
	const db = getDb();
	const g = getGiftById(id);
	if (!g) return undefined;
	const person = db
		.prepare<[number], Person>('SELECT * FROM people WHERE id = ?')
		.get(g.person_id);
	if (!person) return undefined;
	const occasion = g.occasion_id
		? (db.prepare<[number], Occasion>('SELECT * FROM occasions WHERE id = ?').get(g.occasion_id) ??
			null)
		: null;
	const vendor = g.vendor_id ? (getVendorById(g.vendor_id) ?? null) : null;
	const shipper = g.shipper_id ? (getShipperById(g.shipper_id) ?? null) : null;
	return { ...g, person, occasion, vendor, shipper };
}

export function createGift(input: GiftCreateInput, actorUserId: number): Gift {
	const db = getDb();
	const status = input.status ?? 'planned';
	const is_idea = input.is_idea ? 1 : 0;

	// Denormalize vendor name into source for display continuity while the
	// legacy source column is still present. Explicit input.source still wins
	// (e.g. an admin reassigning to a vendor that doesn't yet exist).
	let source = input.source ?? null;
	const vendor_id = input.vendor_id ?? null;
	if (vendor_id != null && source == null) {
		source = getVendorById(vendor_id)?.name ?? null;
	}

	// Same denormalization for shipper → legacy carrier text column.
	let carrier = input.carrier ?? null;
	const shipper_id = input.shipper_id ?? null;
	if (shipper_id != null && carrier == null) {
		carrier = getShipperById(shipper_id)?.name ?? null;
	}

	const info = db
		.prepare(
			`INSERT INTO gifts (
			   person_id, occasion_id, occasion_year, title, source, source_url,
			   order_id, tracking_number, carrier, price_cents, status, notes, is_idea,
			   vendor_id, shipper_id
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.person_id,
			input.occasion_id ?? null,
			input.occasion_year ?? null,
			input.title,
			source,
			input.source_url ?? null,
			input.order_id ?? null,
			input.tracking_number ?? null,
			carrier,
			input.price_cents ?? null,
			status,
			input.notes ?? null,
			is_idea,
			vendor_id,
			shipper_id
		);
	const id = Number(info.lastInsertRowid);
	const gift = getGiftById(id)!;
	logAudit({
		actorUserId,
		entityType: 'gift',
		entityId: id,
		action: 'create',
		summary: `Added gift "${gift.title}" for person ${gift.person_id}`
	});
	return gift;
}

export function updateGift(id: number, input: GiftUpdateInput, actorUserId: number): Gift {
	const before = getGiftById(id);
	if (!before) throw new Error(`Gift ${id} not found`);
	const db = getDb();
	const merged: Gift = { ...before };
	const columns: (keyof GiftUpdateInput)[] = [
		'person_id',
		'title',
		'source',
		'source_url',
		'occasion_id',
		'occasion_year',
		'order_id',
		'tracking_number',
		'carrier',
		'price_cents',
		'notes',
		'vendor_id',
		'shipper_id',
		'tracking_status',
		'tracking_status_at',
		'tracking_estimated_delivery',
		'tracking_provider_id'
	];
	const changed: string[] = [];
	for (const col of columns) {
		if (col in input) {
			const next = input[col] ?? null;
			if (merged[col] !== next) changed.push(col);
			(merged as unknown as Record<string, unknown>)[col] = next;
		}
	}

	// Keep the legacy source column in lockstep with the new vendor_id when
	// vendor_id changed and the caller didn't override source explicitly.
	if (
		'vendor_id' in input &&
		!('source' in input)
	) {
		const newSource = merged.vendor_id ? (getVendorById(merged.vendor_id)?.name ?? null) : null;
		if (merged.source !== newSource) {
			merged.source = newSource;
			if (!changed.includes('source')) changed.push('source');
		}
	}

	// Same lockstep behavior for shipper_id → legacy carrier text column.
	if ('shipper_id' in input && !('carrier' in input)) {
		const newCarrier = merged.shipper_id
			? (getShipperById(merged.shipper_id)?.name ?? null)
			: null;
		if (merged.carrier !== newCarrier) {
			merged.carrier = newCarrier;
			if (!changed.includes('carrier')) changed.push('carrier');
		}
	}

	// If reassigning to a new person, clear occasion_id unless caller is
	// explicitly setting one — occasions are linked to a specific person
	// via person_occasions, so the prior occasion may not apply.
	if (
		'person_id' in input &&
		merged.person_id !== before.person_id &&
		!('occasion_id' in input)
	) {
		merged.occasion_id = null;
		if (before.occasion_id !== null && !changed.includes('occasion_id')) {
			changed.push('occasion_id');
		}
	}

	db.prepare(
		`UPDATE gifts SET
		    person_id = ?, title = ?, source = ?, source_url = ?, occasion_id = ?, occasion_year = ?,
		    order_id = ?, tracking_number = ?, carrier = ?, price_cents = ?, notes = ?, vendor_id = ?,
		    shipper_id = ?, tracking_status = ?, tracking_status_at = ?,
		    tracking_estimated_delivery = ?, tracking_provider_id = ?,
		    updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	).run(
		merged.person_id,
		merged.title,
		merged.source,
		merged.source_url,
		merged.occasion_id,
		merged.occasion_year,
		merged.order_id,
		merged.tracking_number,
		merged.carrier,
		merged.price_cents,
		merged.notes,
		merged.vendor_id,
		merged.shipper_id,
		merged.tracking_status,
		merged.tracking_status_at,
		merged.tracking_estimated_delivery,
		merged.tracking_provider_id,
		id
	);
	const after = getGiftById(id)!;

	let summary: string;
	if (changed.length === 0) {
		summary = `Updated "${after.title}" (no field changes)`;
	} else if (changed.includes('person_id')) {
		const fromName = db
			.prepare<[number], { display_name: string }>(
				'SELECT display_name FROM people WHERE id = ?'
			)
			.get(before.person_id)?.display_name ?? `person ${before.person_id}`;
		const toName = db
			.prepare<[number], { display_name: string }>(
				'SELECT display_name FROM people WHERE id = ?'
			)
			.get(after.person_id)?.display_name ?? `person ${after.person_id}`;
		const others = changed.filter((c) => c !== 'person_id');
		const tail = others.length > 0 ? `; also ${others.join(', ')}` : '';
		summary = `Reassigned "${after.title}" from ${fromName} to ${toName}${tail}`;
	} else {
		summary = `Updated "${after.title}": ${changed.join(', ')}`;
	}

	logAudit({
		actorUserId,
		entityType: 'gift',
		entityId: id,
		action: 'update',
		summary
	});
	return after;
}

export function archiveGift(id: number, archived: boolean, actorUserId: number): Gift {
	const before = getGiftById(id);
	if (!before) throw new Error(`Gift ${id} not found`);
	if (Boolean(before.is_archived) === archived) return before;
	const db = getDb();
	db.prepare(
		'UPDATE gifts SET is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(archived ? 1 : 0, id);
	const after = getGiftById(id)!;
	logAudit({
		actorUserId,
		entityType: 'gift',
		entityId: id,
		action: archived ? 'archive' : 'unarchive',
		summary: `${archived ? 'Archived' : 'Restored'} "${after.title}"`
	});
	return after;
}

/** Dollars helper for form rendering. */
export function priceDollarsInput(cents: number | null): string {
	if (cents == null) return '';
	return (cents / 100).toFixed(2);
}

/** Parses "24.99" or "$24.99" (or blank) into cents. Returns null for blank, throws on invalid. */
export function parseDollarsToCents(raw: string | null | undefined): number | null {
	if (raw == null) return null;
	const trimmed = raw.trim().replace(/^\$/, '');
	if (trimmed === '') return null;
	if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
		throw new Error(`Invalid price: ${raw}`);
	}
	return Math.round(parseFloat(trimmed) * 100);
}
