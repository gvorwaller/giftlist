import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { findManagerUser } from '$server/auth';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
	}

	// Admin previewing the manager view: surface the manager's profile as
	// `user` so the page renders the manager's display name and the manager
	// nav. The admin remains authenticated — mutations still attribute to the
	// admin via locals.user in actions/endpoints.
	if (locals.previewAsManager) {
		const manager = findManagerUser();
		if (manager) {
			return {
				user: manager,
				previewAsManager: true,
				adminDisplayName: locals.user.display_name
			};
		}
	}

	// Both manager and admin can access /app/*.
	return { user: locals.user, previewAsManager: false, adminDisplayName: null };
};
