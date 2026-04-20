import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { loadTodayData, personForGift } from '$server/today';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const data = loadTodayData(locals.user.id);

	// Enrich packages with person display names so the Packages card can render without extra joins.
	const packagesWithPerson = data.packagesOnTheWay.map((g) => ({
		...g,
		person_display_name: personForGift(g.person_id)?.display_name ?? '(archived)'
	}));

	return {
		user: locals.user,
		...data,
		packagesOnTheWay: packagesWithPerson
	};
};
