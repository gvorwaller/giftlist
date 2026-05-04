import { getDb } from './db';
import { logAudit } from './audit';

export interface Shipper {
	id: number;
	name: string;
	/**
	 * Carrier slug used by the configured tracking provider (currently Shippo;
	 * was AfterShip prior to 2026-05). The major US carriers (usps, ups, fedex)
	 * use identical slugs across providers, so existing rows survive a swap.
	 * NULL means "let the provider auto-detect from tracking-number format."
	 */
	tracking_provider_slug: string | null;
	is_archived: 0 | 1;
	created_at: string;
	updated_at: string;
}

export interface ListShippersOptions {
	includeArchived?: boolean;
}

export function listShippers(opts: ListShippersOptions = {}): Shipper[] {
	const db = getDb();
	const where = opts.includeArchived ? '' : 'WHERE is_archived = 0';
	return db
		.prepare<[], Shipper>(`SELECT * FROM shippers ${where} ORDER BY LOWER(name)`)
		.all();
}

export function getShipperById(id: number): Shipper | undefined {
	const db = getDb();
	return db.prepare<[number], Shipper>('SELECT * FROM shippers WHERE id = ?').get(id);
}

export function getShipperByName(name: string): Shipper | undefined {
	const db = getDb();
	return db
		.prepare<[string], Shipper>('SELECT * FROM shippers WHERE LOWER(name) = LOWER(?)')
		.get(name.trim());
}

export interface ShipperUpsertInput {
	name: string;
	tracking_provider_slug: string | null;
}



export function createShipper(input: ShipperUpsertInput, actorUserId: number): Shipper {
	const trimmed = input.name.trim();
	if (!trimmed) throw new Error('Shipper name is required');
	const existing = getShipperByName(trimmed);
	if (existing) throw new Error(`Shipper "${existing.name}" already exists`);

	const slug = normalizeSlug(input.tracking_provider_slug);
	const db = getDb();
	const info = db
		.prepare('INSERT INTO shippers (name, tracking_provider_slug) VALUES (?, ?)')
		.run(trimmed, slug);
	const id = Number(info.lastInsertRowid);
	const shipper = getShipperById(id)!;
	logAudit({
		actorUserId,
		entityType: 'shipper',
		entityId: id,
		action: 'create',
		summary: `Added shipper "${shipper.name}"${slug ? ` (slug: ${slug})` : ''}`
	});
	return shipper;
}



export function updateShipper(
	id: number,
	input: ShipperUpsertInput,
	actorUserId: number
): Shipper {
	const trimmed = input.name.trim();
	if (!trimmed) throw new Error('Shipper name is required');
	const before = getShipperById(id);
	if (!before) throw new Error(`Shipper ${id} not found`);

	const collision = getShipperByName(trimmed);
	if (collision && collision.id !== id) {
		throw new Error(`Another shipper named "${collision.name}" already exists`);
	}

	const slug = normalizeSlug(input.tracking_provider_slug);
	const db = getDb();
	db.prepare(
		'UPDATE shippers SET name = ?, tracking_provider_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(trimmed, slug, id);
	const after = getShipperById(id)!;

	const changes: string[] = [];
	if (before.name !== after.name) changes.push(`name "${before.name}" → "${after.name}"`);
	if (before.tracking_provider_slug !== after.tracking_provider_slug) {
		changes.push(`slug "${before.tracking_provider_slug ?? '∅'}" → "${after.tracking_provider_slug ?? '∅'}"`);
	}
	if (changes.length > 0) {
		logAudit({
			actorUserId,
			entityType: 'shipper',
			entityId: id,
			action: 'update',
			summary: `Updated shipper: ${changes.join(', ')}`
		});
	}
	return after;
}

export function setShipperArchived(
	id: number,
	archived: boolean,
	actorUserId: number
): Shipper {
	const before = getShipperById(id);
	if (!before) throw new Error(`Shipper ${id} not found`);
	if (Boolean(before.is_archived) === archived) return before;

	const db = getDb();
	db.prepare(
		'UPDATE shippers SET is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(archived ? 1 : 0, id);
	const after = getShipperById(id)!;

	logAudit({
		actorUserId,
		entityType: 'shipper',
		entityId: id,
		action: archived ? 'archive' : 'unarchive',
		summary: `${archived ? 'Archived' : 'Restored'} shipper "${after.name}"`
	});
	return after;
}

/** Count of gifts referencing this shipper (any status). */
export function shipperUsageCount(id: number): number {
	const db = getDb();
	const row = db
		.prepare<[number], { cnt: number }>('SELECT COUNT(*) AS cnt FROM gifts WHERE shipper_id = ?')
		.get(id);
	return row?.cnt ?? 0;
}

/**
 * Normalize the carrier slug used by the tracking provider. Slugs are
 * lowercase ASCII identifiers (Shippo and AfterShip both follow this
 * convention). Empty / whitespace becomes NULL.
 */
function normalizeSlug(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const s = raw.trim().toLowerCase();
	if (s === '') return null;
	if (!/^[a-z0-9_-]+$/.test(s)) {
		throw new Error(`Invalid carrier slug "${raw}" — only a-z, 0-9, hyphens, underscores`);
	}
	return s;
}
