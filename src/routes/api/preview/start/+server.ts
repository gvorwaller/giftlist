import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PREVIEW_COOKIE_NAME, PREVIEW_COOKIE_OPTS } from '../../../../hooks.server';
import { findManagerUser } from '$server/auth';

export const POST: RequestHandler = ({ cookies, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Admin only.');

	const manager = findManagerUser();
	if (!manager) throw error(409, 'No manager account on file to preview.');

	cookies.set(PREVIEW_COOKIE_NAME, 'manager', PREVIEW_COOKIE_OPTS);
	throw redirect(303, '/app/today');
};
