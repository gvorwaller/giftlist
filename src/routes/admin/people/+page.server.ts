import type { PageServerLoad } from './$types';
import { listPeople } from '$server/people';

export const load: PageServerLoad = ({ url }) => {
	const search = url.searchParams.get('q') ?? '';
	const includeArchived = url.searchParams.get('archived') === '1';
	const sortParam = url.searchParams.get('sort');
	const sort: 'upcoming' | 'alphabetical' = sortParam === 'alphabetical' ? 'alphabetical' : 'upcoming';
	const people = listPeople({ search, includeArchived, sort });
	return { people, search, includeArchived, sort };
};
