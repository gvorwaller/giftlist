import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	applyStatusUpdate,
	findGiftByCarrierAndNumber,
	findGiftByProviderId,
	verifyWebhookSignature,
	type ShippoTrack
} from '$server/tracking';
import { getDb } from '$server/db';

/**
 * Shippo webhook receiver. Shippo POSTs status changes here as soon as the
 * carrier reports a new checkpoint — much faster than our daily poll.
 *
 * Security: HMAC-SHA256 over `${timestamp}.${rawBody}` using
 * SHIPPO_WEBHOOK_SECRET. The signature is sent in the
 * `shippo-auth-signature` header as `t=<timestamp>,v1=<sha256_hex>`. Without
 * SHIPPO_WEBHOOK_SECRET configured we reject every request with 401 — better
 * than silently accepting unsigned input on a public endpoint.
 *
 * The actor for any audit log entries is the admin user (singular) since this
 * is an unauthenticated machine-to-machine call.
 */
export const POST: RequestHandler = async ({ request }) => {
	const rawBody = await request.text();
	const sig = request.headers.get('shippo-auth-signature');
	if (!verifyWebhookSignature(rawBody, sig)) {
		return json({ error: 'Bad signature' }, { status: 401 });
	}

	let payload: { event?: string; data?: ShippoTrack } | ShippoTrack;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	// Shippo's webhook envelope wraps the track object as { event, data }.
	// Some test consoles send the bare track object instead, so handle both.
	const track: ShippoTrack | undefined =
		'data' in payload && payload.data ? payload.data : (payload as ShippoTrack);
	if (!track || (!track.carrier && !track.tracking_status?.object_id)) {
		return json({ error: 'No tracking payload' }, { status: 400 });
	}

	// Resolve back to a gift: prefer object_id (set during registration),
	// fall back to carrier+tracking_number for safety against provider swaps.
	const objectId = track.tracking_status?.object_id;
	let gift = objectId ? findGiftByProviderId(objectId) : undefined;
	if (!gift && track.carrier && track.tracking_number) {
		gift = findGiftByCarrierAndNumber(track.carrier, track.tracking_number);
	}
	if (!gift) {
		// Unknown — log and return 200 so Shippo doesn't keep retrying.
		console.warn(
			`[shippo-webhook] no gift for object_id=${objectId} carrier=${track.carrier} tracking=${track.tracking_number}`
		);
		return json({ ok: true, note: 'Unknown tracking; ignored.' });
	}

	const adminUserId = getAdminUserId();
	if (!adminUserId) {
		return json({ error: 'No admin user; cannot record audit' }, { status: 503 });
	}

	try {
		const result = applyStatusUpdate(gift.id, track, adminUserId);
		return json({
			ok: true,
			gift_id: gift.id,
			status: result.status,
			events_appended: result.eventsAppended
		});
	} catch (err) {
		console.error('[shippo-webhook] applyStatusUpdate failed:', err);
		return json({ error: 'Internal error' }, { status: 500 });
	}
};

function getAdminUserId(): number | null {
	const db = getDb();
	const row = db
		.prepare<[], { id: number }>(
			"SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
		)
		.get();
	return row?.id ?? null;
}
