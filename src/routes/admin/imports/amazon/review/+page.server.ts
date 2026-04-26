import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listPeople } from '$server/people';
import {
	commitReviewedRows,
	getLatestRun,
	getRun,
	listRowsForRun,
	type CommitRowInput
} from '$server/jobs/amazon-import';
import type { ImportRow } from '$server/types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const runIdParam = url.searchParams.get('run');
	let run = runIdParam ? getRun(Number(runIdParam)) : getLatestRun();
	if (!run) run = getLatestRun();
	if (!run) throw error(404, 'No import runs yet. Run a scan first.');

	const rows = listRowsForRun(run.id);
	const people = listPeople({ sort: 'alphabetical' });

	// Sort rows for the UI: pending first (by received desc), then accepted, skipped, failed.
	const priority: Record<string, number> = { pending: 0, accepted: 1, failed: 2, skipped: 3 };
	rows.sort((a, b) => {
		const pd = (priority[a.disposition] ?? 9) - (priority[b.disposition] ?? 9);
		if (pd !== 0) return pd;
		return (b.received_at ?? '').localeCompare(a.received_at ?? '');
	});

	return { run, rows, people };
};

function parseDecisions(fd: FormData): CommitRowInput[] {
	const decisions: CommitRowInput[] = [];
	const rowIds = fd.getAll('row_id').map((v) => Number(v)).filter(Number.isFinite);

	for (const rowId of rowIds) {
		const dispositionRaw = String(fd.get(`disposition_${rowId}`) ?? 'leave');
		// "leave" (or any non-accept/skip value) means: do nothing — the row
		// stays disposition='pending' and the email stays in Inbox, so a
		// future scan re-surfaces it.
		if (dispositionRaw === 'leave') continue;

		const assignedPerson = Number(fd.get(`person_${rowId}`));
		const saveAsAlias = fd.get(`alias_${rowId}`) === 'on';
		if (dispositionRaw === 'skip') {
			decisions.push({ rowId, action: 'skip' });
			continue;
		}
		if (dispositionRaw === 'accept') {
			decisions.push({
				rowId,
				action: 'accept',
				assignedPersonId: Number.isFinite(assignedPerson) && assignedPerson > 0 ? assignedPerson : undefined,
				saveAsAlias
			});
		}
	}
	return decisions;
}

export const actions: Actions = {
	commit: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const decisions = parseDecisions(fd);
		if (decisions.length === 0) {
			return fail(400, { error: 'No rows chosen.' });
		}
		const runIdRaw = fd.get('run_id');
		const runId = Number(runIdRaw);
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });

		const result = await commitReviewedRows(locals.user.id, decisions);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('gifts', String(result.giftsCreated));
		qs.set('skipped', String(result.rowsSkipped));
		qs.set('failed', String(result.rowsFailed));
		if (result.labelMoveFailures > 0) qs.set('move_failures', String(result.labelMoveFailures));
		qs.set('left', String(decisions.length === 0 ? 0 : 0));
		throw redirect(303, `/admin/imports/amazon/review?${qs.toString()}`);
	},

	skipAll: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });
		const rows = listRowsForRun(runId, 'pending');
		const result = await commitReviewedRows(
			locals.user.id,
			rows.map((r: ImportRow) => ({ rowId: r.id, action: 'skip' as const }))
		);
		throw redirect(
			303,
			`/admin/imports/amazon/review?run=${runId}&skipped=${result.rowsSkipped}`
		);
	}
};
