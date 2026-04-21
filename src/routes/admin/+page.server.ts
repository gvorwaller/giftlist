import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { loadAdminHomeData } from '$server/admin-home';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	return {
		home: loadAdminHomeData()
	};
};
