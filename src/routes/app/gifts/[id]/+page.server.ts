import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { archiveGift, getGiftWithContext } from '$server/gifts';
import { transitionGift, canTransition, undoReturnGift } from '$server/gift-status';
import { recordView } from '$server/recently-viewed';
import {
	isTrackingProviderConfigured,
	listShipmentEvents,
	pullStatus,
	registerWithProvider
} from '$server/tracking';
import { isAmazonLogisticsTracking } from '$server/amazon-tracker';
import { getShipperById } from '$server/shippers';
import type { GiftStatus } from '$server/types';

function requireGift(params: { id: string }, currentUserId: number | undefined) {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(400, 'Invalid gift id');
	const gift = getGiftWithContext(id);
	if (!gift) throw error(404, 'Gift not found');
	// Self-orders are private to their owner_user_id (td-68804e). Strict
	// equality denies foreign-owned AND null-owned (orphaned) self-gifts.
	// Manager mustn't peek at admin's personal packages via direct URL, and
	// an unowned self-row shouldn't be reachable to anyone in /app.
	if (gift.person.is_self === 1 && gift.person.owner_user_id !== currentUserId) {
		throw error(404, 'Gift not found');
	}
	return gift;
}

export const load: PageServerLoad = ({ params, locals }) => {
	const gift = requireGift(params, locals.user?.id);
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
	const gift = requireGift(params, userId);
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
		const gift = requireGift(params, locals.user.id);
		archiveGift(gift.id, true, locals.user.id);
		throw redirect(303, `/app/gifts/${gift.id}`);
	},
	unarchive: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const gift = requireGift(params, locals.user.id);
		archiveGift(gift.id, false, locals.user.id);
		throw redirect(303, `/app/gifts/${gift.id}`);
	},
	undoReturn: ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const gift = requireGift(params, locals.user.id);
		if (gift.status !== 'returned') {
			return fail(409, { error: `This gift is not returned.` });
		}
		undoReturnGift(gift.id, locals.user.id);
		throw redirect(303, `/app/gifts/${gift.id}`);
	},

	// Ad-hoc tracking refresh — pulls fresh status from the configured
	// tracking provider (Shippo) for this single gift. Registers first if no
	// tracking_provider_id is set yet (and a tracking number exists). Surfaces
	// success/failure inline rather than as a flash so it's clear what happened.
	refreshTracking: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const gift = requireGift(params, locals.user.id);
		if (!gift.tracking_number) {
			return fail(400, { trackingError: 'No tracking number on this gift yet.' });
		}

		// td-b221ae: Amazon Logistics gifts skip Shippo entirely. shouldUseAmazonPath
		// mirrors the tracking.ts internal check; we recompute it here so the action
		// can distinguish a successful Amazon fetch (status updated, redirect) from
		// a parse miss (return a soft trackingNote, no redirect, keep the page open).
		const isAmazonPath =
			isAmazonLogisticsTracking(gift.tracking_number) ||
			(!!gift.shipper && getShipperById(gift.shipper.id)?.name === 'Amazon Logistics');

		// Use 4xx for upstream errors so Cloudflare doesn't swap our inline
		// message for its branded "Bad gateway" page.
		if (!isAmazonPath && !isTrackingProviderConfigured()) {
			return fail(400, { trackingError: 'Shippo not configured.' });
		}

		try {
			if (!gift.tracking_provider_id) {
				await registerWithProvider(gift.id, locals.user.id);
			} else {
				await pullStatus(gift.id, locals.user.id);
			}
		} catch (err) {
			return fail(400, {
				trackingError: err instanceof Error ? err.message : 'Tracking refresh failed.'
			});
		}

		if (isAmazonPath) {
			// Re-load to see whether the fetch produced any status. Amazon's
			// tracker is brittle and often returns nothing parseable; in that
			// case nudge the user toward the deep-link button instead.
			const after = getGiftWithContext(gift.id);
			if (!after?.tracking_status) {
				return fail(400, {
					trackingNote:
						'Amazon Logistics didn’t return parseable status. Tap "Open Amazon tracking" for live details.'
				});
			}
		}

		throw redirect(303, `/app/gifts/${gift.id}`);
	}
};
