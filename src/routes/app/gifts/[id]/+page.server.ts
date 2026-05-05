import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { archiveGift, getGiftWithContext } from '$server/gifts';
import { transitionGift, canTransition } from '$server/gift-status';
import { recordView } from '$server/recently-viewed';
import {
	isTrackingProviderConfigured,
	listShipmentEvents,
	pullStatus,
	registerWithProvider
} from '$server/tracking';
import type { GiftStatus } from '$server/types';

function requireGift(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(400, 'Invalid gift id');
	const gift = getGiftWithContext(id);
	if (!gift) throw error(404, 'Gift not found');
	return gift;
}

export const load: PageServerLoad = ({ params, locals }) => {
	const gift = requireGift(params);
	if (locals.user) {
		recordView(
			locals.user.id,
			'gift',
			gift.id,
			`${gift.title} for ${gift.person.display_name}`
		);
	}
	return {
		gift,
		shipmentEvents: listShipmentEvents(gift.id),
		trackingProviderConfigured: isTrackingProviderConfigured()
	};
};

async function doTransition(
	params: { id: string },
	to: GiftStatus,
	userId: number
) {
	const gift = requireGift(params);
	if (!canTransition(gift.status, to)) {
		return fail(409, { error: `Can't mark "${gift.title}" as ${to} from ${gift.status}.` });
	}
	transitionGift(gift.id, to, userId);
	throw redirect(303, `/app/gifts/${gift.id}`);
}

export const actions: Actions = {
	markPlanned: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		return doTransition(params, 'planned', locals.user.id);
	},
	markOrdered: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		return doTransition(params, 'ordered', locals.user.id);
	},
	markShipped: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		return doTransition(params, 'shipped', locals.user.id);
	},
	markDelivered: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		return doTransition(params, 'delivered', locals.user.id);
	},
	markWrapped: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		return doTransition(params, 'wrapped', locals.user.id);
	},
	markGiven: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		return doTransition(params, 'given', locals.user.id);
	},
	markReturned: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		return doTransition(params, 'returned', locals.user.id);
	},
	archive: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const gift = requireGift(params);
		archiveGift(gift.id, true, locals.user.id);
		throw redirect(303, `/app/gifts/${gift.id}`);
	},
	unarchive: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const gift = requireGift(params);
		archiveGift(gift.id, false, locals.user.id);
		throw redirect(303, `/app/gifts/${gift.id}`);
	},

	// Ad-hoc tracking refresh — pulls fresh status from the configured
	// tracking provider (Shippo) for this single gift. Registers first if no
	// tracking_provider_id is set yet (and a tracking number exists). Surfaces
	// success/failure inline rather than as a flash so it's clear what happened.
	refreshTracking: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const gift = requireGift(params);
		// Use 4xx status codes for these failures even though they're "upstream"
		// errors. Cloudflare swaps 5xx upstream responses for its branded "Bad
		// gateway" page, which hides our inline error message — defeats the
		// whole point of returning structured form data here.
		if (!isTrackingProviderConfigured()) {
			return fail(400, { trackingError: 'Shippo not configured.' });
		}
		try {
			if (!gift.tracking_provider_id) {
				if (!gift.tracking_number) {
					return fail(400, { trackingError: 'No tracking number on this gift yet.' });
				}
				await registerWithProvider(gift.id, locals.user.id);
			} else {
				await pullStatus(gift.id, locals.user.id);
			}
		} catch (err) {
			return fail(400, {
				trackingError: err instanceof Error ? err.message : 'Tracking refresh failed.'
			});
		}
		throw redirect(303, `/app/gifts/${gift.id}`);
	}
};
