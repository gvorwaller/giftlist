import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	commitTrackingReviewedRows,
	getLatestTrackingRun,
	getRun,
	listRowsForRun,
	type CommitTrackingRowInput
} from '$server/jobs/tracking-import';
import type { ImportRow } from '$server/types';
import { getDb } from '$server/db';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const runIdParam = url.searchParams.get('run');
	let run = runIdParam ? getRun(Number(runIdParam)) : getLatestTrackingRun();
	if (!run) run = getLatestTrackingRun();
	if (!run) throw error(404, 'No tracking import runs yet. Run a scan first.');
	// P0 fix (Codex review): refuse to render Amazon runs through the tracking
	// review surface. commitTrackingReviewedRows would otherwise process
	// Amazon-imported rows through the self-package path = data corruption.
	if (run.source !== 'tracking_email') {
		throw error(404, 'Run id does not belong to a tracking import.');
	}

	const rows = listRowsForRun(run.id);

	// Compute per-row inferred outcome ("→ link gift #N" or "→ new self-package")
	// so admin can see the consequence of an Accept at a glance.
	const db = getDb();
	const giftLookup = db.prepare<[string], { id: number; title: string }>(
		'SELECT id, title FROM gifts WHERE tracking_number = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1'
	);
	const inferences: Record<
		number,
		{ kind: 'link' | 'new' | 'new-no-tracking'; giftId?: number; giftTitle?: string }
	> = {};
	const giftByOrder = db.prepare<[string], { id: number; title: string }>(
		'SELECT id, title FROM gifts WHERE order_id = ? AND is_archived = 0 ORDER BY id DESC LIMIT 1'
	);
	for (const r of rows) {
		if (r.disposition !== 'pending') continue;
		if (r.parsed_tracking_number) {
			const hit = giftLookup.get(r.parsed_tracking_number);
			if (hit) inferences[r.id] = { kind: 'link', giftId: hit.id, giftTitle: hit.title };
			else inferences[r.id] = { kind: 'new' };
			continue;
		}
		// td-c28c5e: order-confirmation rows have no tracking#. Show whether
		// the order# already matches an existing gift (link) or will create
		// a new status='ordered' self-package with no Shippo registration.
		if (r.email_type === 'order_confirmation' && r.parsed_order_id) {
			const hit = giftByOrder.get(r.parsed_order_id);
			if (hit) inferences[r.id] = { kind: 'link', giftId: hit.id, giftTitle: hit.title };
			else inferences[r.id] = { kind: 'new-no-tracking' };
		}
	}

	// Sort: pending first (by received desc), then handled by category.
	const priority: Record<string, number> = { pending: 0, accepted: 1, failed: 2, skipped: 3 };
	rows.sort((a, b) => {
		const pd = (priority[a.disposition] ?? 9) - (priority[b.disposition] ?? 9);
		if (pd !== 0) return pd;
		return (b.received_at ?? '').localeCompare(a.received_at ?? '');
	});

	return { run, rows, inferences };
};

function parseDecisions(fd: FormData): CommitTrackingRowInput[] {
	const decisions: CommitTrackingRowInput[] = [];
	const rowIds = fd.getAll('row_id').map((v) => Number(v)).filter(Number.isFinite);
	for (const rowId of rowIds) {
		const dispositionRaw = String(fd.get(`disposition_${rowId}`) ?? 'leave');
		if (dispositionRaw === 'leave') continue;
		if (dispositionRaw === 'skip') decisions.push({ rowId, action: 'skip' });
		else if (dispositionRaw === 'accept') decisions.push({ rowId, action: 'accept' });
	}
	return decisions;
}

export const actions: Actions = {
	commit: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const decisions = parseDecisions(fd);
		if (decisions.length === 0) return fail(400, { error: 'No rows chosen.' });
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });

		const result = await commitTrackingReviewedRows(locals.user.id, decisions);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('created', String(result.giftsCreated));
		qs.set('linked', String(result.giftsLinked));
		qs.set('skipped', String(result.rowsSkipped));
		qs.set('failed', String(result.rowsFailed));
		if (result.labelMoveFailures > 0) qs.set('move_failures', String(result.labelMoveFailures));
		throw redirect(303, `/admin/imports/tracking/review?${qs.toString()}`);
	},

	skipAll: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });
		const rows = listRowsForRun(runId, 'pending');
		const result = await commitTrackingReviewedRows(
			locals.user.id,
			rows.map((r: ImportRow) => ({ rowId: r.id, action: 'skip' as const }))
		);
		throw redirect(
			303,
			`/admin/imports/tracking/review?run=${runId}&skipped=${result.rowsSkipped}`
		);
	},

	acceptAll: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });
		const rows = listRowsForRun(runId, 'pending');
		const result = await commitTrackingReviewedRows(
			locals.user.id,
			rows.map((r: ImportRow) => ({ rowId: r.id, action: 'accept' as const }))
		);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('created', String(result.giftsCreated));
		qs.set('linked', String(result.giftsLinked));
		qs.set('failed', String(result.rowsFailed));
		throw redirect(303, `/admin/imports/tracking/review?${qs.toString()}`);
	}
};
