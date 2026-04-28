import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listPeople } from '$server/people';
import { assignOccasionToPerson, listSharedOccasions } from '$server/occasions';

export const load: PageServerLoad = ({ url }) => {
	const search = url.searchParams.get('q') ?? '';
	const includeArchived = url.searchParams.get('archived') === '1';
	const sortParam = url.searchParams.get('sort');
	const sort: 'upcoming' | 'alphabetical' = sortParam === 'alphabetical' ? 'alphabetical' : 'upcoming';
	const people = listPeople({ search, includeArchived, sort });
	const sharedOccasions = listSharedOccasions();
	return { people, search, includeArchived, sort, sharedOccasions };
};

export const actions: Actions = {
	bulkAssignOccasion: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const occasionId = Number(fd.get('occasion_id'));
		if (!Number.isInteger(occasionId) || occasionId <= 0) {
			return fail(400, { scope: 'bulk', error: 'Choose an occasion.' });
		}
		const personIds = fd
			.getAll('person_ids')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n) && n > 0);
		if (personIds.length === 0) {
			return fail(400, { scope: 'bulk', error: 'Select at least one person.' });
		}
		// assignOccasionToPerson upserts (ON CONFLICT DO UPDATE), so applying
		// the same occasion to people who already have it is a no-op refresh.
		for (const personId of personIds) {
			assignOccasionToPerson(personId, occasionId, locals.user.id);
		}
		return { scope: 'bulk', ok: true, count: personIds.length };
	}
};
