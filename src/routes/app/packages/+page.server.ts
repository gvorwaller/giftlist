import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listGifts } from '$server/gifts';
import { personForGift } from '$server/today';
import { isAftershipConfigured, pullAllInFlight } from '$server/tracking';

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

	return { inFlight, aftershipConfigured: isAftershipConfigured() };
};

export const actions: Actions = {
	// Page-level "Refresh all" — runs the same routine as the daily scheduled
	// job but at the user's request. Bounded by AfterShip's per-endpoint rate
	// limit; safe to spam since terminal-state shipments are skipped.
	refreshAll: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		if (!isAftershipConfigured()) {
			return fail(503, { trackingError: 'AfterShip not configured.' });
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
			return fail(502, {
				trackingError: err instanceof Error ? err.message : 'Refresh failed.'
			});
		}
	}
};
