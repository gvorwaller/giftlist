import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from './db';
import { getGiftById, updateGift } from './gifts';
import { getShipperById } from './shippers';
import { logAudit } from './audit';
import type { Gift, ShipmentEvent } from './types';

const AFTERSHIP_BASE = 'https://api.aftership.com/tracking/2024-07';

/**
 * AfterShip tracking-state vocabulary. We don't enumerate every sub-tag; we
 * only care about distinguishing in-flight from terminal so the scheduled
 * poller can stop checking delivered/returned packages. Anything else is
 * passed through as-is for display.
 */
const TERMINAL_STATUSES = new Set(['Delivered', 'Returned', 'Expired']);

export interface AftershipConfig {
	apiKey: string;
	webhookSecret: string | null;
}

function readConfig(): AftershipConfig | null {
	const apiKey = process.env.AFTERSHIP_API_KEY?.trim();
	if (!apiKey) return null;
	const webhookSecret = process.env.AFTERSHIP_WEBHOOK_SECRET?.trim() || null;
	return { apiKey, webhookSecret };
}

export function isAftershipConfigured(): boolean {
	return readConfig() !== null;
}

interface AftershipApiTracking {
	id: string;
	tracking_number: string;
	slug: string | null;
	tag: string | null;
	subtag: string | null;
	subtag_message: string | null;
	expected_delivery: string | null;
	checkpoints?: AftershipCheckpoint[];
}

interface AftershipCheckpoint {
	checkpoint_time?: string;
	created_at?: string;
	tag?: string;
	subtag?: string;
	subtag_message?: string;
	message?: string;
	location?: string;
	city?: string;
	state?: string;
	country_name?: string;
	raw_status?: string;
}

interface AftershipResponse<T> {
	meta: { code: number; message?: string; type?: string };
	data?: T;
}

async function aftershipFetch<T>(
	cfg: AftershipConfig,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	body?: unknown
): Promise<T> {
	const res = await fetch(`${AFTERSHIP_BASE}${path}`, {
		method,
		headers: {
			'as-api-key': cfg.apiKey,
			'Content-Type': 'application/json'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const json = (await res.json()) as AftershipResponse<T>;
	if (!res.ok || (json.meta && json.meta.code >= 400)) {
		const msg = json.meta?.message ?? `HTTP ${res.status}`;
		throw new Error(`AfterShip ${method} ${path} failed: ${msg}`);
	}
	if (!json.data) {
		throw new Error(`AfterShip ${method} ${path}: empty response data`);
	}
	return json.data;
}

/**
 * Register a gift's tracking number with AfterShip. Idempotent at AfterShip's
 * end — they de-dup on (slug, tracking_number). Stores the resulting AfterShip
 * tracking id on the gift so subsequent status pulls and webhook callbacks
 * can route back to this row.
 *
 * No-ops (returns null) when:
 *   - AFTERSHIP_API_KEY isn't configured
 *   - the gift has no tracking_number
 *   - the gift already has an aftership_tracking_id (already registered)
 */
export async function registerWithAftership(
	giftId: number,
	actorUserId: number
): Promise<string | null> {
	const cfg = readConfig();
	if (!cfg) return null;
	const gift = getGiftById(giftId);
	if (!gift || !gift.tracking_number || !gift.tracking_number.trim()) return null;
	if (gift.aftership_tracking_id) return gift.aftership_tracking_id;

	const slug = gift.shipper_id ? (getShipperById(gift.shipper_id)?.aftership_slug ?? null) : null;

	const data = await aftershipFetch<{ tracking: AftershipApiTracking }>(
		cfg,
		'POST',
		'/trackings',
		{
			tracking: {
				tracking_number: gift.tracking_number.trim(),
				// Omit slug entirely if NULL — AfterShip auto-detects from format.
				...(slug ? { slug } : {})
			}
		}
	);

	updateGift(giftId, { aftership_tracking_id: data.tracking.id }, actorUserId);
	logAudit({
		actorUserId,
		entityType: 'tracking',
		entityId: giftId,
		action: 'register',
		summary: `Registered tracking with AfterShip: ${gift.tracking_number}${slug ? ` (${slug})` : ' (auto-detect)'}`
	});

	// Pull current status immediately so the UI doesn't show "—" while
	// waiting for the first webhook.
	await pullStatus(giftId, actorUserId).catch((err) => {
		console.warn(`[tracking] initial pull for gift ${giftId} failed:`, err);
	});

	return data.tracking.id;
}

/**
 * Fetch the current status from AfterShip for a single gift and persist it
 * onto the gift row + the shipment_events history table. Used by both the
 * scheduled poller and the ad-hoc admin "Refresh" buttons.
 */
export async function pullStatus(
	giftId: number,
	actorUserId: number
): Promise<{ status: string | null; eventsAppended: number } | null> {
	const cfg = readConfig();
	if (!cfg) return null;
	const gift = getGiftById(giftId);
	if (!gift || !gift.aftership_tracking_id) return null;

	const data = await aftershipFetch<{ tracking: AftershipApiTracking }>(
		cfg,
		'GET',
		`/trackings/${gift.aftership_tracking_id}`
	);
	return applyStatusUpdate(giftId, data.tracking, actorUserId);
}

/**
 * Common state-write path used by both the API pull and the webhook handler.
 * Idempotent — duplicate checkpoints are dropped via the UNIQUE constraint
 * on shipment_events(gift_id, event_at, status).
 */
export function applyStatusUpdate(
	giftId: number,
	tracking: AftershipApiTracking,
	actorUserId: number
): { status: string | null; eventsAppended: number } {
	const status = tracking.tag ?? null;
	const statusAt = pickLatestCheckpointTime(tracking) ?? new Date().toISOString();
	const eta = tracking.expected_delivery ?? null;

	updateGift(
		giftId,
		{
			tracking_status: status,
			tracking_status_at: statusAt,
			tracking_estimated_delivery: eta
		},
		actorUserId
	);

	const eventsAppended = appendCheckpoints(giftId, tracking.checkpoints ?? []);
	return { status, eventsAppended };
}

function pickLatestCheckpointTime(t: AftershipApiTracking): string | null {
	const cps = t.checkpoints ?? [];
	let latest: string | null = null;
	for (const c of cps) {
		const at = c.checkpoint_time ?? c.created_at;
		if (!at) continue;
		if (!latest || at > latest) latest = at;
	}
	return latest;
}

function appendCheckpoints(giftId: number, checkpoints: AftershipCheckpoint[]): number {
	if (checkpoints.length === 0) return 0;
	const db = getDb();
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO shipment_events
		   (gift_id, event_at, status, message, location, raw_json)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	let appended = 0;
	for (const c of checkpoints) {
		const at = c.checkpoint_time ?? c.created_at;
		if (!at) continue;
		const status = c.tag ?? c.subtag ?? c.raw_status ?? null;
		const message = c.subtag_message ?? c.message ?? null;
		const location = formatLocation(c);
		const info = stmt.run(giftId, at, status, message, location, JSON.stringify(c));
		if (info.changes > 0) appended += 1;
	}
	return appended;
}

function formatLocation(c: AftershipCheckpoint): string | null {
	if (c.location) return c.location;
	const bits = [c.city, c.state, c.country_name].filter(Boolean);
	return bits.length > 0 ? bits.join(', ') : null;
}

/**
 * Pull AfterShip status for every gift that has a registered tracking id and
 * isn't already in a terminal state. Used by the scheduled `tracking.refresh`
 * job; bounded concurrency to stay well under AfterShip rate limits at our
 * scale (a couple dozen rows max).
 */
export async function pullAllInFlight(actorUserId: number): Promise<{
	checked: number;
	updated: number;
	failed: number;
}> {
	const cfg = readConfig();
	if (!cfg) return { checked: 0, updated: 0, failed: 0 };

	const db = getDb();
	const rows = db
		.prepare<[], Pick<Gift, 'id' | 'tracking_status'>>(
			`SELECT id, tracking_status
			   FROM gifts
			  WHERE is_archived = 0
			    AND aftership_tracking_id IS NOT NULL`
		)
		.all();

	const inFlight = rows.filter(
		(r) => !r.tracking_status || !TERMINAL_STATUSES.has(r.tracking_status)
	);

	let updated = 0;
	let failed = 0;
	const CONCURRENCY = 4;
	for (let off = 0; off < inFlight.length; off += CONCURRENCY) {
		const batch = inFlight.slice(off, off + CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map((r) => pullStatus(r.id, actorUserId))
		);
		for (const res of results) {
			if (res.status === 'fulfilled') {
				if (res.value && res.value.eventsAppended > 0) updated += 1;
			} else {
				failed += 1;
				console.warn('[tracking] pull failed:', res.reason);
			}
		}
	}
	return { checked: inFlight.length, updated, failed };
}

/**
 * Verify an AfterShip webhook signature. Header format:
 *   aftership-hmac-sha256: <base64 HMAC-SHA256 of raw body using secret>
 * Returns true on match. Constant-time comparison to avoid timing attacks.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
	const cfg = readConfig();
	if (!cfg || !cfg.webhookSecret) return false;
	if (!signatureHeader) return false;
	const expected = createHmac('sha256', cfg.webhookSecret).update(rawBody).digest();
	let received: Buffer;
	try {
		received = Buffer.from(signatureHeader, 'base64');
	} catch {
		return false;
	}
	if (received.length !== expected.length) return false;
	return timingSafeEqual(received, expected);
}

/** Look up a gift by its AfterShip tracking id (set during registration). */
export function findGiftByAftershipId(aftershipId: string): Gift | undefined {
	const db = getDb();
	return db
		.prepare<[string], Gift>('SELECT * FROM gifts WHERE aftership_tracking_id = ?')
		.get(aftershipId);
}

export function listShipmentEvents(giftId: number): ShipmentEvent[] {
	const db = getDb();
	return db
		.prepare<[number], ShipmentEvent>(
			'SELECT * FROM shipment_events WHERE gift_id = ? ORDER BY event_at DESC, id DESC'
		)
		.all(giftId);
}

// Re-export for use by webhook handler so it can deserialize cleanly.
export type { AftershipApiTracking };
