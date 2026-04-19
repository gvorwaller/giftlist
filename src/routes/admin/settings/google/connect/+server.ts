import { randomBytes } from 'node:crypto';
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildAuthUrl } from '$server/google-auth';
import { dev } from '$app/environment';
import { OAUTH_COOKIE_PATH, OAUTH_STATE_COOKIE } from '../_oauth';

export const GET: RequestHandler = ({ cookies, locals }) => {
	if (!locals.user || locals.user.role !== 'admin') {
		throw error(403, 'Admin only');
	}

	const state = randomBytes(24).toString('base64url');
	cookies.set(OAUTH_STATE_COOKIE, state, {
		path: OAUTH_COOKIE_PATH,
		httpOnly: true,
		sameSite: 'lax', // lax so Google's cross-site redirect back carries the cookie
		secure: !dev,
		maxAge: 10 * 60 // 10 min — plenty of time to complete consent
	});

	const url = buildAuthUrl(state);
	throw redirect(303, url);
};
