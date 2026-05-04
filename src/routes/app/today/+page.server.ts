import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { loadTodayData, personForGift } from '$server/today';
import { findManagerUser } from '$server/auth';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	// In preview-as-manager mode, scope user-specific data (recently viewed,
	// resume draft) to the manager so the admin sees what the manager sees.
	let dataUserId = locals.user.id;
	if (locals.previewAsManager) {
		const manager = findManagerUser();
		if (manager) dataUserId = manager.id;
	}

	const data = loadTodayData(dataUserId);

	// Enrich packages with person display names so the Packages card can render without extra joins.
	const packagesWithPerson = data.packagesOnTheWay.map((g) => ({
		...g,
		person_display_name: personForGift(g.person_id)?.display_name ?? '(archived)'
	}));

	return {
		...data,
		packagesOnTheWay: packagesWithPerson
	};
};
