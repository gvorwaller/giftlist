import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { destroySession, SESSION_COOKIE_NAME } from '$server/session';

const handleLogout: RequestHandler = ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE_NAME);
	if (token) destroySession(token);
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	throw redirect(303, '/login');
};

export const POST = handleLogout;
export const GET = handleLogout;
