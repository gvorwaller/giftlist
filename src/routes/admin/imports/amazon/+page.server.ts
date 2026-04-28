import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDecryptedToken, getTokenRow } from '$server/external-tokens';
import { tokenHasGmailModify } from '$server/google-auth';
import {
	getLatestRun,
	listRecentRuns,
	listRowsForRun,
	runAmazonScan
} from '$server/jobs/amazon-import';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const token = getTokenRow(locals.user.id, 'google');
	const decrypted = token ? getDecryptedToken(locals.user.id, 'google') : null;
	const scopeOk = tokenHasGmailModify(decrypted?.scope ?? token?.scope ?? null);

	const latestRun = getLatestRun() ?? null;
	const pendingCount = latestRun ? listRowsForRun(latestRun.id, 'pending').length : 0;
	const autoSkippedCount = latestRun ? listRowsForRun(latestRun.id, 'skipped').length : 0;
	// "Already staged" = fetched but not newly-parsed because source_message_id
	// was already in import_rows from an earlier scan.
	const alreadyStaged = latestRun
		? Math.max(0, latestRun.fetched_count - latestRun.parsed_count)
		: 0;

	const recentRuns = listRecentRuns(20);

	return {
		connected: Boolean(token && token.refresh_token_encrypted),
		scopeOk,
		accountEmail: token?.account_email ?? null,
		latestRun,
		pendingCount,
		autoSkippedCount,
		alreadyStaged,
		recentRuns
	};
};

// Cap the user-selectable batch at 500 — beyond that the browser feels stuck
// while waiting for one form action to return. Gmail itself permits up to
// 1000 ids per batchModify, but list+full-fetch round-trips dominate wall time.
const MAX_BATCH = 500;
const ALLOWED_BATCHES = [50, 100, 200, 300, 500];

export const actions: Actions = {
	scan: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const raw = Number(fd.get('limit'));
		const limit =
			Number.isFinite(raw) && raw > 0 && raw <= MAX_BATCH
				? ALLOWED_BATCHES.includes(Math.floor(raw))
					? Math.floor(raw)
					: 50
				: 50;
		try {
			const result = await runAmazonScan(locals.user.id, { limit });
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
