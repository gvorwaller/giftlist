import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	commitTrackingReviewedRows,
	getLatestTrackingRun,
	getRun,
	listRowsForRun,
	resolveTrackingReview,
	type CommitTrackingRowInput,
	type ResolveTrackingReviewInput
} from '$server/jobs/tracking-import';
import type { ImportRow } from '$server/types';
import { getDb } from '$server/db';

// td-3d1ee6: shape of the candidates the importer wrote to
// match_candidates_json when routing a row to review. Mirrors the internal
// ReviewCandidate shape in tracking-import.ts.
interface ReviewCandidateView {
	giftId: number;
	title: string;
	personId: number;
	personDisplayName: string;
	vendorName: string | null;
	status: string;
	createdAt: string;
}

function parseReviewCandidates(json: string | null): ReviewCandidateView[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((c): c is ReviewCandidateView => {
			return (
				c &&
				typeof c === 'object' &&
				typeof c.giftId === 'number' &&
				typeof c.title === 'string'
			);
		});
	} catch {
		return [];
	}
}

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

	// td-3d1ee6: parse stored candidate JSON for review rows so the UI can
	// render gift cards with title/person/vendor without a second DB hit.
	const reviewCandidates: Record<number, ReviewCandidateView[]> = {};
	for (const r of rows) {
		if (r.disposition === 'review') {
			reviewCandidates[r.id] = parseReviewCandidates(r.match_candidates_json);
		}
	}

	// Sort: review first (admin action required), then pending, then handled.
	const priority: Record<string, number> = {
		review: 0,
		pending: 1,
		accepted: 2,
		failed: 3,
		skipped: 4
	};
	rows.sort((a, b) => {
		const pd = (priority[a.disposition] ?? 9) - (priority[b.disposition] ?? 9);
		if (pd !== 0) return pd;
		return (b.received_at ?? '').localeCompare(a.received_at ?? '');
	});

	return { run, rows, inferences, reviewCandidates };
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
		if (result.rowsRoutedToReview > 0) qs.set('review', String(result.rowsRoutedToReview));
		if (result.labelMoveFailures > 0) qs.set('move_failures', String(result.labelMoveFailures));
		throw redirect(303, `/admin/imports/tracking/review?${qs.toString()}`);
	},

	resolveReview: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });

		// Parse per-row resolutions from the form. Each review row exposes:
		//   review_action_{rowId} = 'attach' | 'self_package' | 'skip' | 'leave'
		//   review_gift_{rowId}   = numeric giftId (only when action=='attach')
		const inputs: ResolveTrackingReviewInput[] = [];
		const rowIds = fd
			.getAll('review_row_id')
			.map((v) => Number(v))
			.filter(Number.isFinite);
		for (const rowId of rowIds) {
			const actionRaw = String(fd.get(`review_action_${rowId}`) ?? 'leave');
			if (actionRaw === 'leave') continue;
			if (actionRaw === 'skip') {
				inputs.push({ rowId, action: 'skip' });
			} else if (actionRaw === 'self_package') {
				inputs.push({ rowId, action: 'self_package' });
			} else if (actionRaw === 'attach') {
				const giftId = Number(fd.get(`review_gift_${rowId}`));
				if (!Number.isFinite(giftId)) {
					return fail(400, { error: `Row ${rowId}: attach action requires a giftId.` });
				}
				inputs.push({ rowId, action: 'attach', giftId });
			}
		}
		if (inputs.length === 0) return fail(400, { error: 'No review rows chosen.' });

		const result = await resolveTrackingReview(locals.user.id, inputs);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('linked', String(result.giftsLinked));
		qs.set('created', String(result.giftsCreated));
		qs.set('skipped', String(result.rowsSkipped));
		qs.set('failed', String(result.rowsFailed));
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
