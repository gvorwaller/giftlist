import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { loadTodayData, personForGift } from '$server/today';
import { findManagerUser } from '$server/auth';
import { skipOccasion, unskipOccasion } from '$server/occasion-skips';

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

function parsePoYear(fd: FormData): { poId: number; year: number } | null {
	const poId = Number(fd.get('person_occasion_id'));
	const year = Number(fd.get('occasion_year'));
	if (!Number.isInteger(poId) || poId <= 0) return null;
	if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
	return { poId, year };
}

export const actions: Actions = {
	skip: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const parsed = parsePoYear(fd);
		if (!parsed) return fail(400, { error: 'Bad skip request' });
		skipOccasion(parsed.poId, parsed.year, locals.user.id);
		// Re-render Today so the row disappears and the skipped-footer surfaces it.
		// undo=<po>:<year> drives the flash + Undo button.
		throw redirect(303, `/app/today?undo=${parsed.poId}:${parsed.year}`);
	},
	unskip: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const parsed = parsePoYear(fd);
		if (!parsed) return fail(400, { error: 'Bad unskip request' });
		unskipOccasion(parsed.poId, parsed.year, locals.user.id);
		throw redirect(303, '/app/today?unskipped=1');
	}
};
