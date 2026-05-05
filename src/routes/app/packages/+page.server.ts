import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { personForGift } from '$server/today';
import { isTrackingProviderConfigured, pullAllInFlight } from '$server/tracking';
import { getDb } from '$server/db';
import type { Gift } from '$server/types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	// Scope self-orders to the signed-in user (td-68804e). Non-self gifts
	// (shared recipients) are visible to everyone; self-people belong to a
	// specific owner_user_id and only that user sees them on their packages.
	const db = getDb();
	const raw = db
		.prepare<[number], Gift>(
			`SELECT g.* FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE g.is_archived = 0
			    AND g.status IN ('ordered', 'shipped')
			    AND (p.is_self = 0 OR p.owner_user_id = ?)
			  ORDER BY COALESCE(g.shipped_at, g.created_at) DESC`
		)
		.all(locals.user.id);

	const inFlight = raw.map((g) => ({
		...g,
		person_display_name: personForGift(g.person_id)?.display_name ?? '(archived)'
	}));

	return { inFlight, trackingProviderConfigured: isTrackingProviderConfigured() };
};

export const actions: Actions = {
	// Page-level "Refresh all" — runs the same routine as the daily scheduled
	// job but at the user's request. Safe to invoke repeatedly since
	// terminal-state shipments are skipped server-side.
	refreshAll: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		// 4xx instead of 5xx so Cloudflare doesn't swap the response body for
		// its branded "Bad gateway" page — we want our inline error to render.
		if (!isTrackingProviderConfigured()) {
			return fail(400, { trackingError: 'Shippo not configured.' });
		}
		try {
			// Viewer-scoped refresh — manager mustn't see admin's self-order
			// counts in the result, and mustn't trigger Shippo refreshes on
			// gifts they can't see.
			const result = await pullAllInFlight(locals.user.id, locals.user.id);
			return {
				ok: true,
				checked: result.checked,
				updated: result.updated,
				failed: result.failed
			};
		} catch (err) {
			return fail(400, {
				trackingError: err instanceof Error ? err.message : 'Refresh failed.'
			});
		}
	}
};
