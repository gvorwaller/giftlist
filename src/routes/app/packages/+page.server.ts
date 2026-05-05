import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listGifts } from '$server/gifts';
import { personForGift } from '$server/today';
import { isTrackingProviderConfigured, pullAllInFlight } from '$server/tracking';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const raw = listGifts({
		statuses: ['ordered', 'shipped'],
		includeArchived: false,
		order: 'shipped_desc'
	});

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
			const result = await pullAllInFlight(locals.user.id);
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
