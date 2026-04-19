import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTokenRow } from '$server/external-tokens';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const token = getTokenRow(locals.user.id, 'google');
	return {
		googleConnected: Boolean(token && token.refresh_token_encrypted),
		googleEmail: token?.account_email ?? null
	};
};
