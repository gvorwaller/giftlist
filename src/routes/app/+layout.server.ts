import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
	}
	// Both manager and admin can access /app/*.
	return { user: locals.user };
};
