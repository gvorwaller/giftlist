import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCodeForTokens, persistTokens } from '$server/google-auth';
import { OAUTH_COOKIE_PATH, OAUTH_STATE_COOKIE } from '../_oauth';

function settingsRedirect(status: string, detail?: string): never {
	const qs = new URLSearchParams();
	if (status === 'connected' || status === 'disconnected') qs.set('google', status);
	if (detail) qs.set('error', detail);
	throw redirect(303, `/admin/settings?${qs.toString()}`);
}

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	if (!locals.user || locals.user.role !== 'admin') {
		throw error(403, 'Admin only');
	}

	const errorParam = url.searchParams.get('error');
	if (errorParam) {
		cookies.delete(OAUTH_STATE_COOKIE, { path: OAUTH_COOKIE_PATH });
		settingsRedirect('error', errorParam);
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const expectedState = cookies.get(OAUTH_STATE_COOKIE);

	cookies.delete(OAUTH_STATE_COOKIE, { path: OAUTH_COOKIE_PATH });

	if (!code) settingsRedirect('error', 'missing_code');
	if (!state || !expectedState || state !== expectedState) {
		settingsRedirect('error', 'state_mismatch');
	}

	try {
		const result = await exchangeCodeForTokens(code);
		persistTokens(locals.user.id, result, locals.user.id);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'exchange_failed';
		console.error('[google oauth] token exchange failed:', msg);
		settingsRedirect('error', 'exchange_failed');
	}

	settingsRedirect('connected');
};
