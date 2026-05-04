import { timingSafeEqual } from 'node:crypto';
import { getDb } from './db';
import { getGiftById, updateGift } from './gifts';
import { getShipperById } from './shippers';
import { logAudit } from './audit';
import type { Gift, ShipmentEvent } from './types';

const SHIPPO_BASE = 'https://api.goshippo.com';

/**
 * Shippo's tracking_status enum. Terminal states stop the scheduled poller
 * from re-querying the same shipment forever. Anything else (including
 * UNKNOWN, which Shippo uses while the carrier hasn't yet acknowledged the
 * tracking number) keeps polling.
 */
const TERMINAL_STATUSES = new Set(['DELIVERED', 'RETURNED', 'FAILURE']);

export interface TrackingConfig {
	apiKey: string;
	webhookSecret: string | null;
}

function readConfig(): TrackingConfig | null {
	const apiKey = process.env.SHIPPO_API_KEY?.trim();
	if (!apiKey) return null;
	const webhookSecret = process.env.SHIPPO_WEBHOOK_SECRET?.trim() || null;
	return { apiKey, webhookSecret };
}

export function isTrackingProviderConfigured(): boolean {
	return readConfig() !== null;
}

interface ShippoTrackingStatus {
	object_id?: string;
	status?: string;
	status_details?: string | null;
	status_date?: string | null;
	location?: ShippoLocation | null;
}

interface ShippoLocation {
	city?: string | null;
	state?: string | null;
	zip?: string | null;
	country?: string | null;
}

export interface ShippoTrack {
	carrier?: string;
	tracking_number?: string;
	tracking_status?: ShippoTrackingStatus | null;
	tracking_history?: ShippoTrackingStatus[];
	eta?: string | null;
	original_eta?: string | null;
	servicelevel?: { token?: string; name?: string } | null;
	address_from?: ShippoLocation | null;
	address_to?: ShippoLocation | null;
	metadata?: string | null;
}

async function shippoFetch<T>(
	cfg: TrackingConfig,
	method: 'GET' | 'POST',
	path: string,
	body?: unknown
): Promise<T> {
	const res = await fetch(`${SHIPPO_BASE}${path}`, {
		method,
		headers: {
			Authorization: `ShippoToken ${cfg.apiKey}`,
			'Content-Type': 'application/json'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Shippo ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
	}
	return JSON.parse(text) as T;
}

/**
 * Register a gift's tracking number with Shippo so we'll receive webhook
 * updates when the carrier reports new checkpoints. Idempotent at Shippo's
 * end — POST /tracks/ with the same (carrier, tracking_number) returns the
 * same object_id.
 *
 * No-ops (returns null) when:
 *   - SHIPPO_API_KEY isn't configured
 *   - the gift has no tracking_number
 *   - the gift is already registered (tracking_provider_id set)
 */
export async function registerWithProvider(
	giftId: number,
	actorUserId: number
): Promise<string | null> {
	const cfg = readConfig();
	if (!cfg) return null;
	const gift = getGiftById(giftId);
	if (!gift || !gift.tracking_number || !gift.tracking_number.trim()) return null;
	if (gift.tracking_provider_id) return gift.tracking_provider_id;

	// Shippo requires a carrier slug — there's no auto-detect. We use the
	// linked shipper's slug; if absent, default to USPS as the most likely
	// US carrier, which is also the safest fallback (USPS slugs are validated
	// loosely so no-ops on a wrong guess).
	const shipper = gift.shipper_id ? getShipperById(gift.shipper_id) : null;
	const carrier = shipper?.tracking_provider_slug ?? 'usps';

	const data = await shippoFetch<ShippoTrack>(cfg, 'POST', '/tracks/', {
		carrier,
		tracking_number: gift.tracking_number.trim(),
		metadata: `gift:${gift.id}`
	});

	const providerId = data.tracking_status?.object_id ?? null;
	if (!providerId) {
		// Defensive — Shippo always returns object_id on success but we don't
		// want to silently lose the registration if the schema ever shifts.
		console.warn(`[tracking] Shippo /tracks/ returned no object_id for gift ${giftId}`);
	}

	updateGift(giftId, { tracking_provider_id: providerId }, actorUserId);
	logAudit({
		actorUserId,
		entityType: 'tracking',
		entityId: giftId,
		action: 'register',
		summary: `Registered tracking with Shippo: ${gift.tracking_number} (${carrier})`
	});

	// Persist whatever status we already have from the registration response
	// so the UI doesn't show "—" while waiting for the first webhook callback.
	applyStatusUpdate(giftId, data, actorUserId);
	return providerId;
}

/**
 * Fetch the current status from Shippo for a single gift and persist it
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
	if (!gift || !gift.tracking_number) return null;

	const shipper = gift.shipper_id ? getShipperById(gift.shipper_id) : null;
	const carrier = shipper?.tracking_provider_slug ?? 'usps';

	const data = await shippoFetch<ShippoTrack>(
		cfg,
		'GET',
		`/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(gift.tracking_number)}`
	);
	return applyStatusUpdate(giftId, data, actorUserId);
}

/**
 * Common state-write path used by both the API pull and the webhook handler.
 * Idempotent — duplicate checkpoints are dropped via the UNIQUE constraint
 * on shipment_events(gift_id, event_at, status).
 */
export function applyStatusUpdate(
	giftId: number,
	track: ShippoTrack,
	actorUserId: number
): { status: string | null; eventsAppended: number } {
	const status = track.tracking_status?.status ?? null;
	const statusAt =
		track.tracking_status?.status_date ??
		pickLatestHistoryDate(track) ??
		new Date().toISOString();
	const eta = track.eta ?? track.original_eta ?? null;

	updateGift(
		giftId,
		{
			tracking_status: status,
			tracking_status_at: statusAt,
			tracking_estimated_delivery: eta
		},
		actorUserId
	);

	const eventsAppended = appendCheckpoints(giftId, track.tracking_history ?? []);
	return { status, eventsAppended };
}

function pickLatestHistoryDate(t: ShippoTrack): string | null {
	const hist = t.tracking_history ?? [];
	let latest: string | null = null;
	for (const h of hist) {
		const at = h.status_date;
		if (!at) continue;
		if (!latest || at > latest) latest = at;
	}
	return latest;
}

function appendCheckpoints(giftId: number, history: ShippoTrackingStatus[]): number {
	if (history.length === 0) return 0;
	const db = getDb();
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO shipment_events
		   (gift_id, event_at, status, message, location, raw_json)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	let appended = 0;
	for (const h of history) {
		const at = h.status_date;
		if (!at) continue;
		const status = h.status ?? null;
		const message = h.status_details ?? null;
		const location = formatLocation(h.location);
		const info = stmt.run(giftId, at, status, message, location, JSON.stringify(h));
		if (info.changes > 0) appended += 1;
	}
	return appended;
}

function formatLocation(loc: ShippoLocation | null | undefined): string | null {
	if (!loc) return null;
	const bits = [loc.city, loc.state, loc.zip, loc.country].filter(Boolean);
	return bits.length > 0 ? bits.join(', ') : null;
}

/**
 * Pull tracking status for every gift that has a registered tracking id and
 * isn't already in a terminal state. Used by the scheduled `tracking.refresh`
 * job; bounded concurrency to stay polite against Shippo's API at our scale
 * (a couple dozen rows max).
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
			    AND tracking_provider_id IS NOT NULL`
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
 * Verify a Shippo webhook by comparing the `?token=` query param against the
 * configured shared secret. Shippo offers three webhook security models — IP
 * allowlist, self-generated URL tokens, and HMAC — but HMAC requires emailing
 * an account manager and waiting up to 10 business days. URL tokens are
 * self-service and adequate for a single-tenant app: keep the URL secret and
 * the token effectively functions as a bearer credential.
 *
 * Rejects if SHIPPO_WEBHOOK_SECRET is not configured — better to fail closed
 * than silently accept unauthenticated input on a public endpoint.
 *
 * Secret rotation: regenerate `SHIPPO_WEBHOOK_SECRET`, edit the webhook URL
 * in the Shippo dashboard, restart pm2.
 */
export function verifyWebhookToken(urlToken: string | null): boolean {
	const cfg = readConfig();
	if (!cfg || !cfg.webhookSecret) return false;
	if (!urlToken) return false;
	const expectedBuf = Buffer.from(cfg.webhookSecret, 'utf8');
	const receivedBuf = Buffer.from(urlToken, 'utf8');
	if (expectedBuf.length !== receivedBuf.length) return false;
	return timingSafeEqual(expectedBuf, receivedBuf);
}

/** Look up a gift by its tracking-provider object id (set during registration). */
export function findGiftByProviderId(providerId: string): Gift | undefined {
	const db = getDb();
	return db
		.prepare<[string], Gift>('SELECT * FROM gifts WHERE tracking_provider_id = ?')
		.get(providerId);
}

/**
 * Fallback lookup by carrier+tracking_number — used when the webhook payload's
 * object_id doesn't match anything we know (e.g. older registrations from a
 * provider swap). Returns the most-recently-created match.
 */
export function findGiftByCarrierAndNumber(
	carrier: string,
	trackingNumber: string
): Gift | undefined {
	const db = getDb();
	return db
		.prepare<[string, string], Gift>(
			`SELECT g.*
			   FROM gifts g
			   LEFT JOIN shippers s ON s.id = g.shipper_id
			  WHERE g.tracking_number = ?
			    AND (LOWER(s.tracking_provider_slug) = LOWER(?) OR s.tracking_provider_slug IS NULL)
			  ORDER BY g.created_at DESC
			  LIMIT 1`
		)
		.get(trackingNumber, carrier);
}

export function listShipmentEvents(giftId: number): ShipmentEvent[] {
	const db = getDb();
	return db
		.prepare<[number], ShipmentEvent>(
			'SELECT * FROM shipment_events WHERE gift_id = ? ORDER BY event_at DESC, id DESC'
		)
		.all(giftId);
}
