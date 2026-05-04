import { getDb } from './db';
import { logAudit } from './audit';

export interface Vendor {
	id: number;
	name: string;
	is_archived: 0 | 1;
	created_at: string;
	updated_at: string;
}

export interface ListVendorsOptions {
	includeArchived?: boolean;
}

export function listVendors(opts: ListVendorsOptions = {}): Vendor[] {
	const db = getDb();
	const where = opts.includeArchived ? '' : 'WHERE is_archived = 0';
	return db
		.prepare<[], Vendor>(`SELECT * FROM vendors ${where} ORDER BY LOWER(name)`)
		.all();
}

export function getVendorById(id: number): Vendor | undefined {
	const db = getDb();
	return db.prepare<[number], Vendor>('SELECT * FROM vendors WHERE id = ?').get(id);
}

export function getVendorByName(name: string): Vendor | undefined {
	const db = getDb();
	return db
		.prepare<[string], Vendor>('SELECT * FROM vendors WHERE LOWER(name) = LOWER(?)')
		.get(name.trim());
}

export function createVendor(name: string, actorUserId: number): Vendor {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('Vendor name is required');
	const existing = getVendorByName(trimmed);
	if (existing) throw new Error(`Vendor "${existing.name}" already exists`);

	const db = getDb();
	const info = db.prepare('INSERT INTO vendors (name) VALUES (?)').run(trimmed);
	const id = Number(info.lastInsertRowid);
	const vendor = getVendorById(id)!;
	logAudit({
		actorUserId,
		entityType: 'vendor',
		entityId: id,
		action: 'create',
		summary: `Added vendor "${vendor.name}"`
	});
	return vendor;
}

export function updateVendor(id: number, name: string, actorUserId: number): Vendor {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('Vendor name is required');
	const before = getVendorById(id);
	if (!before) throw new Error(`Vendor ${id} not found`);

	// Allow renaming to the same canonical name (case-only changes).
	const collision = getVendorByName(trimmed);
	if (collision && collision.id !== id) {
		throw new Error(`Another vendor named "${collision.name}" already exists`);
	}

	const db = getDb();
	db.prepare(
		'UPDATE vendors SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(trimmed, id);
	const after = getVendorById(id)!;

	if (before.name !== after.name) {
		logAudit({
			actorUserId,
			entityType: 'vendor',
			entityId: id,
			action: 'update',
			summary: `Renamed vendor "${before.name}" → "${after.name}"`
		});
	}
	return after;
}

export function setVendorArchived(id: number, archived: boolean, actorUserId: number): Vendor {
	const before = getVendorById(id);
	if (!before) throw new Error(`Vendor ${id} not found`);
	if (Boolean(before.is_archived) === archived) return before;

	const db = getDb();
	db.prepare(
		'UPDATE vendors SET is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(archived ? 1 : 0, id);
	const after = getVendorById(id)!;

	logAudit({
		actorUserId,
		entityType: 'vendor',
		entityId: id,
		action: archived ? 'archive' : 'unarchive',
		summary: `${archived ? 'Archived' : 'Restored'} vendor "${after.name}"`
	});
	return after;
}

/**
 * Looks up a vendor by name; creates it if missing. Used by the Amazon import
 * pipeline so an "Amazon" row is auto-created on first scan rather than
 * requiring the admin to add it manually before any imports work.
 */
export function ensureVendor(name: string, actorUserId: number): Vendor {
	const existing = getVendorByName(name);
	if (existing) return existing;
	return createVendor(name, actorUserId);
}

/** Count of gifts referencing this vendor (archived or not). */
export function vendorUsageCount(id: number): number {
	const db = getDb();
	const row = db
		.prepare<[number], { cnt: number }>('SELECT COUNT(*) AS cnt FROM gifts WHERE vendor_id = ?')
		.get(id);
	return row?.cnt ?? 0;
}
