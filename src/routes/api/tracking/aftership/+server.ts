import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	applyStatusUpdate,
	findGiftByAftershipId,
	verifyWebhookSignature,
	type AftershipApiTracking
} from '$server/tracking';
import { getDb } from '$server/db';

/**
 * AfterShip webhook receiver. AfterShip POSTs status changes here as soon as
 * they happen at the carrier; way faster than our daily poll.
 *
 * Security: HMAC-SHA256 signature verification using AFTERSHIP_WEBHOOK_SECRET.
 * Without that env var configured we reject every request with 401 — better
 * than silently accepting unsigned input on a public endpoint.
 *
 * The actor for any audit log entries is the admin user (singular) since this
 * is an unauthenticated machine-to-machine call.
 */
export const POST: RequestHandler = async ({ request }) => {
	const rawBody = await request.text();
	const sig = request.headers.get('aftership-hmac-sha256');
	if (!verifyWebhookSignature(rawBody, sig)) {
		return json({ error: 'Bad signature' }, { status: 401 });
	}

	let payload: { msg?: { tracking?: AftershipApiTracking } };
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const tracking = payload.msg?.tracking;
	if (!tracking || !tracking.id) {
		return json({ error: 'Missing tracking.id' }, { status: 400 });
	}

	const gift = findGiftByAftershipId(tracking.id);
	if (!gift) {
		// Unknown tracking id — possibly a stale registration we lost. Return
		// 200 so AfterShip doesn't keep retrying, but log loudly.
		console.warn(`[aftership-webhook] no gift for tracking id ${tracking.id}`);
		return json({ ok: true, note: 'Unknown tracking id; ignored.' });
	}

	const adminUserId = getAdminUserId();
	if (!adminUserId) {
		return json({ error: 'No admin user; cannot record audit' }, { status: 503 });
	}

	try {
		const result = applyStatusUpdate(gift.id, tracking, adminUserId);
		return json({
			ok: true,
			gift_id: gift.id,
			status: result.status,
			events_appended: result.eventsAppended
		});
	} catch (err) {
		console.error('[aftership-webhook] applyStatusUpdate failed:', err);
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
