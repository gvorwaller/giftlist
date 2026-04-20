import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listGifts } from '$server/gifts';
import { personForGift } from '$server/today';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const raw = listGifts({
		statuses: ['ordered', 'shipped', 'delivered'],
		includeArchived: false,
		order: 'shipped_desc'
	});

	const gifts = raw.map((g) => ({
		...g,
		person_display_name: personForGift(g.person_id)?.display_name ?? '(archived)'
	}));

	return {
		onTheWay: gifts.filter((g) => g.status !== 'delivered'),
		arrived: gifts.filter((g) => g.status === 'delivered')
	};
};
