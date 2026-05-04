import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	applyStatusUpdate,
	findGiftByCarrierAndNumber,
	findGiftByProviderId,
	verifyWebhookToken,
	type ShippoTrack
} from '$server/tracking';
import { getDb } from '$server/db';

/**
 * Shippo webhook receiver. Shippo POSTs status changes here as soon as the
 * carrier reports a new checkpoint — much faster than our daily poll.
 *
 * Security: shared-secret URL token. The webhook URL configured in the Shippo
 * dashboard ends with `?token=<SHIPPO_WEBHOOK_SECRET>`; we compare that param
 * to the env var with a timing-safe equality check. Without
 * SHIPPO_WEBHOOK_SECRET configured we reject every request with 401. (HMAC
 * signing is also offered by Shippo but only via account-manager request; URL
 * tokens are self-service and sufficient at our single-tenant scale.)
 *
 * The actor for any audit log entries is the admin user (singular) since this
 * is an unauthenticated machine-to-machine call.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const token = url.searchParams.get('token');
	if (!verifyWebhookToken(token)) {
		return json({ error: 'Bad token' }, { status: 401 });
	}
	const rawBody = await request.text();

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
