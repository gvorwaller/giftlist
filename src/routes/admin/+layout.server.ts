import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
	}
	if (locals.user.role !== 'admin') {
		throw error(403, 'Admin access only.');
	}
	return { user: locals.user };
};
