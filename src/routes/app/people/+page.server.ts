import type { PageServerLoad } from './$types';
import { listPeople } from '$server/people';

export const load: PageServerLoad = ({ url }) => {
	const search = url.searchParams.get('q') ?? '';
	const people = listPeople({
		search,
		includeArchived: false,
		sort: 'upcoming'
	});
	return { people, search };
};
