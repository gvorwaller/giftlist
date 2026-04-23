import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDecryptedToken, getTokenRow } from '$server/external-tokens';
import { tokenHasGmailModify } from '$server/google-auth';
import { getLatestRun, listRowsForRun, runAmazonScan } from '$server/jobs/amazon-import';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const token = getTokenRow(locals.user.id, 'google');
	const decrypted = token ? getDecryptedToken(locals.user.id, 'google') : null;
	const scopeOk = tokenHasGmailModify(decrypted?.scope ?? token?.scope ?? null);

	const latestRun = getLatestRun() ?? null;
	const pendingCount = latestRun
		? listRowsForRun(latestRun.id, 'pending').length
		: 0;

	return {
		connected: Boolean(token && token.refresh_token_encrypted),
		scopeOk,
		accountEmail: token?.account_email ?? null,
		latestRun,
		pendingCount
	};
};

export const actions: Actions = {
	scan: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		try {
			const result = await runAmazonScan(locals.user.id);
			if (result.status === 'error') {
				return fail(500, { error: result.error?.message ?? 'Scan failed' });
			}
			throw redirect(303, `/admin/imports/amazon/review?run=${result.result?.runId}`);
		} catch (err) {
			if (err instanceof Response || (err as { status?: number })?.status === 303) throw err;
			const message = err instanceof Error ? err.message : String(err);
			return fail(409, { error: message });
		}
	}
};
