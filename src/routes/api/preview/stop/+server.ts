import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PREVIEW_COOKIE_NAME } from '../../../../hooks.server';

export const POST: RequestHandler = ({ cookies, locals }) => {
	cookies.delete(PREVIEW_COOKIE_NAME, { path: '/' });
	const dest = locals.user?.role === 'admin' ? '/admin' : '/app/today';
	throw redirect(303, dest);
};
