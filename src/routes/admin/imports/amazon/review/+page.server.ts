import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listPeople } from '$server/people';
import {
	commitReviewedRows,
	getLatestRun,
	getRun,
	listRowsForRun,
	retryFailedByOrderId,
	type CommitRowInput
} from '$server/jobs/amazon-import';
import { matchGiftByTitle, type GiftMatchResult } from '$server/gift-matcher';
import { reevaluateMatchesForRun } from '$server/matcher-llm';
import type { ImportRow } from '$server/types';
import type { ParsedAmazonItem } from '$server/amazon-parser';

/** Parsed `import_rows.parsed_items_json` from the multi-item Amazon parser
 * (td-3e9ae2). One entry per Amazon line item; null/missing JSON means a
 * single-item or pre-migration row. */
function parseItems(json: string | null): ParsedAmazonItem[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json);
		if (!Array.isArray(arr)) return [];
		return arr.filter((x): x is ParsedAmazonItem =>
			x && typeof x === 'object' && typeof x.title === 'string'
		);
	} catch {
		return [];
	}
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const runIdParam = url.searchParams.get('run');
	let run = runIdParam ? getRun(Number(runIdParam)) : getLatestRun();
	if (!run) run = getLatestRun();
	if (!run) throw error(404, 'No import runs yet. Run a scan first.');

	const rows = listRowsForRun(run.id);
	// Include self-people scoped to the current admin so they can assign an
	// imported Amazon row to "Gaylon — me" (private package). Per-user
	// scoping (td-68804e) — admin sees their own self-row only, never the
	// manager's. Without includeSelf, the default filter hides all is_self=1
	// people and the dropdown silently omits them.
	const people = listPeople({
		sort: 'alphabetical',
		includeSelf: true,
		selfOwnerUserId: locals.user.id
	});

	// Sort rows for the UI: pending first (by received desc), then accepted, skipped, failed.
	const priority: Record<string, number> = { pending: 0, accepted: 1, failed: 2, skipped: 3 };
	rows.sort((a, b) => {
		const pd = (priority[a.disposition] ?? 9) - (priority[b.disposition] ?? 9);
		if (pd !== 0) return pd;
		return (b.received_at ?? '').localeCompare(a.received_at ?? '');
	});

	// Compute fuzzy gift-title matches for pending rows so the UI can suggest
	// linking the email to an existing idea/planned gift instead of creating
	// a new one. Modern Amazon emails strip recipient + gift designation, so
	// title-match is often the only reliable signal.
	const giftMatches: Record<number, GiftMatchResult> = {};
	// td-3e9ae2: per-row line-item arrays. Multi-item rows render N pickers
	// in the UI; single-item rows fall back to the legacy single picker.
	const rowItems: Record<number, ParsedAmazonItem[]> = {};
	// td-3e9ae2: per-line-item weak match. Each item gets its own search
	// against existing idea/planned gifts, keyed by row id + item index.
	const lineItemMatches: Record<string, GiftMatchResult> = {};
	for (const r of rows) {
		const items = parseItems(r.parsed_items_json);
		if (items.length > 0) rowItems[r.id] = items;
		if (r.disposition === 'pending' && r.parsed_title) {
			giftMatches[r.id] = matchGiftByTitle(r.parsed_title);
			// For multi-item rows, also fuzzy-match each line item independently
			// — the legacy giftMatches[r.id] uses parsed_title (= first item),
			// which would otherwise hide candidate matches for items 2..N.
			if (items.length > 1) {
				items.forEach((it, idx) => {
					if (it.title) {
						lineItemMatches[`${r.id}:${idx}`] = matchGiftByTitle(it.title);
					}
				});
			}
		}
	}

	return { run, rows, people, giftMatches, rowItems, lineItemMatches };
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
		const assignedGift = Number(fd.get(`gift_${rowId}`));
		const saveAsAlias = fd.get(`alias_${rowId}`) === 'on';
		if (dispositionRaw === 'skip') {
			decisions.push({ rowId, action: 'skip' });
			continue;
		}
		if (dispositionRaw === 'accept') {
			// td-3e9ae2: collect per-line-item recipient picks (`lineperson_<row>_<idx>`).
			// Form field naming: name="lineperson_42_0" value="<personId>". Items left
			// at the empty default fall through to the legacy single-recipient picker.
			const lineItems: NonNullable<CommitRowInput['lineItems']> = [];
			const linePrefix = `lineperson_${rowId}_`;
			const giftPrefix = `linegift_${rowId}_`;
			for (const [key, val] of fd.entries()) {
				if (!key.startsWith(linePrefix)) continue;
				const idx = Number(key.slice(linePrefix.length));
				if (!Number.isFinite(idx) || idx < 0) continue;
				const pid = Number(val);
				const linkedGiftRaw = fd.get(`${giftPrefix}${idx}`);
				const linkedGift = linkedGiftRaw ? Number(linkedGiftRaw) : 0;
				if (Number.isFinite(pid) && pid > 0) {
					lineItems.push({
						lineItemIndex: idx,
						assignedPersonId: pid,
						assignedGiftId:
							Number.isFinite(linkedGift) && linkedGift > 0 ? linkedGift : undefined
					});
				}
			}
			// Keep items in index order so the gifts created are in the same
			// order shown in the UI (and the same order the parser emitted).
			lineItems.sort((a, b) => a.lineItemIndex - b.lineItemIndex);

			decisions.push({
				rowId,
				action: 'accept',
				assignedPersonId:
					Number.isFinite(assignedPerson) && assignedPerson > 0 ? assignedPerson : undefined,
				assignedGiftId:
					Number.isFinite(assignedGift) && assignedGift > 0 ? assignedGift : undefined,
				saveAsAlias,
				lineItems: lineItems.length > 0 ? lineItems : undefined
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
	},

	// td-1d01e9 Phase B: ask Haiku to confirm/reject every pending row's weak
	// gift-match candidates for this run. Cached results return instantly on
	// re-runs (no re-billing). Cheap (~$0.001 per row).
	reevaluateMatches: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });
		const result = await reevaluateMatchesForRun(runId);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		if (result.skippedNoKey) {
			qs.set('llm_skipped', '1');
		} else {
			qs.set('llm_evaluated', String(result.evaluated));
			qs.set('llm_confirmed', String(result.confirmed));
			qs.set('llm_rejected', String(result.rejected));
			qs.set('llm_api_calls', String(result.apiCalls));
			if (result.apiErrors > 0) qs.set('llm_errors', String(result.apiErrors));
		}
		throw redirect(303, `/admin/imports/amazon/review?${qs.toString()}`);
	},

	// Re-evaluate this run's failed rows by parsed_order_id. If admin has since
	// created or edited a gift whose order_id matches, promote the row to
	// pending with the gift's person prefilled. Bulk equivalent of "did I miss
	// any after I created the package manually?".
	retryFailedByOrder: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });
		const result = retryFailedByOrderId(runId, locals.user.id);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('retried', String(result.scanned));
		qs.set('rematched', String(result.matched));
		throw redirect(303, `/admin/imports/amazon/review?${qs.toString()}`);
	},

	// Re-process a previously failed or skipped row with a manually chosen recipient.
	// commitReviewedRows doesn't gate on current disposition, so we just call accept
	// with the chosen personId and it overwrites the row's disposition + creates the gift.
	reassign: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		const rowId = Number(fd.get('row_id'));
		const personId = Number(fd.get('person_id'));
		const saveAsAlias = fd.get('alias') === 'on';
		if (!Number.isFinite(runId) || !Number.isFinite(rowId) || !Number.isFinite(personId) || personId <= 0) {
			return fail(400, { error: 'Missing run id, row id, or recipient.' });
		}
		const result = await commitReviewedRows(locals.user.id, [
			{ rowId, action: 'accept', assignedPersonId: personId, saveAsAlias }
		]);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('reassigned', String(result.giftsCreated > 0 ? 1 : 0));
		if (result.rowsFailed > 0) qs.set('failed', String(result.rowsFailed));
		throw redirect(303, `/admin/imports/amazon/review?${qs.toString()}`);
	}
};
