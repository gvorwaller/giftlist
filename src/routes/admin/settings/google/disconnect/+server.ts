import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteToken } from '$server/external-tokens';

export const POST: RequestHandler = ({ locals }) => {
	if (!locals.user || locals.user.role !== 'admin') {
		throw error(403, 'Admin only');
	}
	deleteToken(locals.user.id, 'google', locals.user.id);
	throw redirect(303, '/admin/settings?google=disconnected');
};
