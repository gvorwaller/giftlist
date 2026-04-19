import type { PageServerLoad } from './$types';
import { listPeople } from '$server/people';

export const load: PageServerLoad = ({ url }) => {
	const search = url.searchParams.get('q') ?? '';
	const includeArchived = url.searchParams.get('archived') === '1';
	const people = listPeople({
		search,
		includeArchived,
		sort: 'alphabetical'
	});
	return { people, search, includeArchived };
};
