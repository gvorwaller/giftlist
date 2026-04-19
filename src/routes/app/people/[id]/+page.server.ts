import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getPersonWithContext } from '$server/people';
import { listPersonOccasions } from '$server/occasions';
import { recordView } from '$server/recently-viewed';

export const load: PageServerLoad = ({ params, locals }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(400, 'Invalid id');

	const person = getPersonWithContext(id);
	if (!person || person.is_archived === 1) throw error(404, 'Person not found');

	if (locals.user) {
		recordView(locals.user.id, 'person', person.id, person.display_name);
	}

	return {
		person,
		personOccasions: listPersonOccasions(person.id)
	};
};
