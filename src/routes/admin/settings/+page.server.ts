import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTokenRow } from '$server/external-tokens';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const token = getTokenRow(locals.user.id, 'google');
	const googleConnection = token
		? {
				connected: true as const,
				account_email: token.account_email,
				scope: token.scope,
				connected_at: token.created_at,
				access_token_expires_at: token.access_token_expires_at,
				has_refresh_token: Boolean(token.refresh_token_encrypted)
			}
		: { connected: false as const };

	return {
		googleConnection,
		flash: {
			connected: url.searchParams.get('google') === 'connected',
			disconnected: url.searchParams.get('google') === 'disconnected',
			error: url.searchParams.get('error')
		}
	};
};
