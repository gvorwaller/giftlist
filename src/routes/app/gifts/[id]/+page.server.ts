import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getGiftWithContext } from '$server/gifts';
import { transitionGift, canTransition } from '$server/gift-status';
import { recordView } from '$server/recently-viewed';
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
	return { gift };
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
	}
};
