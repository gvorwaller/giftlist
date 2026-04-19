import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	throw redirect(303, locals.user.role === 'admin' ? '/admin' : '/app/today');
};
