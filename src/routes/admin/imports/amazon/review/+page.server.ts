import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listPeople } from '$server/people';
import {
	commitReviewedRows,
	getLatestRun,
	getRun,
	listRowsForRun,
	reevaluateImportRowsForRun,
	retryFailedByOrderId,
	type CommitRowInput
} from '$server/jobs/amazon-import';
import type { LlmMatchVerdict, MatcherCandidate } from '$server/llm-matcher';
import { rankCandidatesForImport } from '$server/gift-matcher';
import {
	createExclusionKeyword,
	getActiveExclusionKeywords,
	matchExcluded
} from '$server/exclusion-keywords';
import { getDb } from '$server/db';
import { getOrderByOrderId, listGiftsForOrder } from '$server/orders';
import { canTransition, transitionGift } from '$server/gift-status';
import { logAudit } from '$server/audit';
import type { GiftStatus, ImportRow } from '$server/types';
import type { ParsedAmazonItem } from '$server/amazon-parser';

/** Wave 1 (Codex round 4 P2): a row is "held" when the shipment matcher
 * abstained — it committed (disposition='accepted', shipment record
 * created, gift linked) but held the sibling status-advance and left an
 * error_message explaining why. The review page gives these a
 * first-class resolve panel. */
function isHeldRow(r: ImportRow): boolean {
	return (
		r.disposition === 'accepted' &&
		!!r.error_message &&
		(r.email_type === 'shipped' || r.email_type === 'delivered')
	);
}

function lifecycleTargetFor(emailType: string): GiftStatus | null {
	if (emailType === 'shipped') return 'shipped';
	if (emailType === 'delivered') return 'delivered';
	return null;
}

export interface HeldSibling {
	giftId: number;
	title: string;
	personName: string;
	status: string;
	canAdvance: boolean;
}

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

/** Codex P3: hydrate a gift by id into the MatcherCandidate shape so
 * we can splice it into the radio list when the LLM picked something
 * outside the heuristic top-5. Returns null if the gift is gone,
 * archived, or has no person — defensive against stale verdicts. */
function fetchEnrichedGift(giftId: number): MatcherCandidate | null {
	const row = getDb()
		.prepare<
			[number],
			{
				gift_id: number;
				title: string;
				person_id: number;
				person_display_name: string;
				person_relationship: string | null;
				occasion_label: string | null;
				notes: string | null;
				status: string;
			}
		>(
			`SELECT
			   g.id            AS gift_id,
			   g.title         AS title,
			   g.person_id     AS person_id,
			   p.display_name  AS person_display_name,
			   p.relationship  AS person_relationship,
			   CASE
			     WHEN o.id IS NULL THEN NULL
			     WHEN g.occasion_year IS NOT NULL THEN o.title || ' ' || g.occasion_year
			     ELSE o.title
			   END             AS occasion_label,
			   g.notes         AS notes,
			   g.status        AS status
			 FROM gifts g
			 JOIN people p ON p.id = g.person_id
			 LEFT JOIN occasions o ON o.id = g.occasion_id
			 WHERE g.id = ? AND g.is_archived = 0`
		)
		.get(giftId);
	if (!row) return null;
	return {
		giftId: row.gift_id,
		title: row.title,
		personId: row.person_id,
		personDisplayName: row.person_display_name,
		personRelationship: row.person_relationship,
		occasionLabel: row.occasion_label,
		notes: row.notes,
		status: row.status
	};
}

/** Parse the persisted LLM matcher verdict (Wave 1) — written at import
 * time, refreshed by the admin "Re-run AI matcher" button. */
function parseLlmVerdict(json: string | null): LlmMatchVerdict | null {
	if (!json) return null;
	try {
		const obj = JSON.parse(json);
		if (obj && typeof obj === 'object' && Array.isArray(obj.matches)) {
			return obj as LlmMatchVerdict;
		}
	} catch {
		// fall through
	}
	return null;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const runIdParam = url.searchParams.get('run');
	let run = runIdParam ? getRun(Number(runIdParam)) : getLatestRun();
	if (!run) run = getLatestRun();
	if (!run) throw error(404, 'No import runs yet. Run a scan first.');

	const rows = listRowsForRun(run.id);
	// td-8360f4: active exclusion keywords. We don't drop excluded items from
	// rowItems (that would shift line_item_index); instead we flag them so the
	// UI suppresses their picker and shows a muted "excluded" note. Catches
	// rows staged before a keyword was added (e.g. just after the admin clicks
	// "Exclude" on an item, or adds one in the CRUD panel).
	const exclusions = getActiveExclusionKeywords();
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

	// Wave 1: read the persisted LLM matcher verdict per row. Verdicts
	// were computed at import time (or refreshed by the admin "Re-run AI
	// matcher" button) and stored in import_rows.llm_verdict_json. The
	// page renders synchronously — no live Anthropic call on page load.
	const llmVerdicts: Record<number, LlmMatchVerdict | null> = {};
	// td-3e9ae2: per-row line-item arrays. Multi-item rows render N
	// pickers in the UI; single-item rows fall back to the legacy single
	// picker.
	const rowItems: Record<number, ParsedAmazonItem[]> = {};
	// Wave 1: candidate pools the UI renders as radio options. Built
	// from the CURRENT open-gifts state (admin may have added gifts
	// since the scan), so the radios always offer real, linkable
	// options. The LLM verdict's `matches[]` entries tell the UI which
	// option to pre-select per item.
	const giftCandidates: Record<number, MatcherCandidate[]> = {};
	const lineItemCandidates: Record<string, MatcherCandidate[]> = {};
	// Wave 1 Phase 3: per-row count of existing sibling gifts already
	// under this order_pk. The svelte UI uses this to render either
	// "Accept → advance N existing gifts" or "Accept → create N new
	// gifts" instead of the ambiguous "create / advance" label.
	const existingSiblings: Record<number, { count: number; titles: string[] }> = {};
	const orderSiblingStmt = getDb().prepare<[string], { id: number; title: string }>(
		`SELECT g.id, g.title
		   FROM gifts g
		   JOIN orders o ON o.id = g.order_pk
		  WHERE o.order_id = ? AND g.is_archived = 0`
	);
	// Wave 1 (Codex round 4 P2): per-held-row sibling lists + lifecycle
	// target, so the UI can render an inline "advance which siblings?"
	// resolve panel instead of making the admin hunt through gift pages.
	const heldSiblings: Record<number, HeldSibling[]> = {};
	const heldTargets: Record<number, string> = {};
	// td-8360f4: `${rowId}:${itemIndex}` → matched keyword, for multi-item rows;
	// `rowId` → matched keyword for single-item rows (no items[] array). The UI
	// renders these as a muted "Excluded by keyword" line instead of a picker.
	const excludedItemKeys: Record<string, string> = {};
	const excludedRowTitles: Record<number, string> = {};
	const personNameStmt = getDb().prepare<[number], { display_name: string }>(
		`SELECT display_name FROM people WHERE id = ?`
	);
	for (const r of rows) {
		const items = parseItems(r.parsed_items_json);
		if (items.length > 0) rowItems[r.id] = items;
		if (isHeldRow(r) && r.parsed_order_id) {
			const target = lifecycleTargetFor(r.email_type);
			const order = getOrderByOrderId(r.parsed_order_id);
			if (target && order) {
				heldTargets[r.id] = target;
				heldSiblings[r.id] = listGiftsForOrder(order.id).map((g) => ({
					giftId: g.id,
					title: g.title,
					personName: personNameStmt.get(g.person_id)?.display_name ?? `#${g.person_id}`,
					status: g.status,
					canAdvance: canTransition(g.status, target)
				}));
			}
		}
		if (r.disposition === 'pending') {
			const verdict = parseLlmVerdict(r.llm_verdict_json);
			llmVerdicts[r.id] = verdict;
			// td-8360f4: flag items/rows matching an active exclusion keyword.
			// Flagged entries get a muted "excluded" line in the UI instead of a
			// picker, and we skip candidate ranking for them.
			if (exclusions.length > 0) {
				if (items.length > 1) {
					items.forEach((it, idx) => {
						const hit = matchExcluded(it.title, exclusions);
						if (hit) excludedItemKeys[`${r.id}:${idx}`] = hit.keyword;
					});
				} else {
					const hit = matchExcluded(r.parsed_title, exclusions);
					if (hit) excludedRowTitles[r.id] = hit.keyword;
				}
			}
			// Top-5 candidates for the radio UI. Recipient hint matters less
			// here than at LLM-input time (heuristic still surfaces the right
			// gifts), so pass null.
			if (r.parsed_title && !excludedRowTitles[r.id]) {
				giftCandidates[r.id] = rankCandidatesForImport(r.parsed_title, null, 5);
			}
			if (items.length > 1) {
				items.forEach((it, idx) => {
					if (it.title && !excludedItemKeys[`${r.id}:${idx}`]) {
						lineItemCandidates[`${r.id}:${idx}`] = rankCandidatesForImport(
							it.title,
							null,
							5
						);
					}
				});
			}
			// Codex P3: the LLM verdict may have picked a gift that's
			// outside the page's top-5 heuristic ranking (the verdict was
			// generated against a hint-priority top-20). Without this
			// fix, the picked gift's radio option wouldn't render and
			// admin would unwittingly fall through to "Don't link →
			// create new gift", duplicating the existing gift. Ensure
			// every verdict-picked gift is present in the candidate
			// list, prepending it when missing.
			if (verdict) {
				for (const m of verdict.matches) {
					if (m.giftId == null) continue;
					const isMulti = items.length > 1;
					// Don't splice a candidate for an excluded item/row.
					if (isMulti && excludedItemKeys[`${r.id}:${m.itemIndex}`]) continue;
					if (!isMulti && excludedRowTitles[r.id]) continue;
					const targetKey = isMulti ? `${r.id}:${m.itemIndex}` : null;
					const list = isMulti
						? (lineItemCandidates[targetKey!] ??= [])
						: (giftCandidates[r.id] ??= []);
					if (!list.some((c) => c.giftId === m.giftId)) {
						const picked = fetchEnrichedGift(m.giftId);
						if (picked) list.unshift(picked);
					}
				}
			}
			if (r.parsed_order_id) {
				const sibs = orderSiblingStmt.all(r.parsed_order_id);
				existingSiblings[r.id] = {
					count: sibs.length,
					titles: sibs.map((s) => s.title)
				};
			}
		}
	}

	return {
		run,
		rows,
		people,
		rowItems,
		llmVerdicts,
		giftCandidates,
		lineItemCandidates,
		existingSiblings,
		heldSiblings,
		heldTargets,
		excludedItemKeys,
		excludedRowTitles
	};
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
		qs.set('created', String(result.giftsCreated));
		qs.set('linked', String(result.giftsLinked));
		qs.set('advanced', String(result.siblingsAdvanced));
		qs.set('skipped', String(result.rowsSkipped));
		qs.set('failed', String(result.rowsFailed));
		if (result.labelMoveFailures > 0) qs.set('move_failures', String(result.labelMoveFailures));
		if (result.rowsAbstained > 0) qs.set('abstained', String(result.rowsAbstained));
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

	// Wave 1: re-run the LLM matcher across every pending row in this
	// run, refreshing each row's persisted verdict against the CURRENT
	// open-gifts pool (admin may have added or edited gifts since the
	// scan staged these rows). The matcher's versioned cache absorbs
	// identical re-calls so only changed candidate sets hit the API.
	reevaluateMatches: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });
		const result = await reevaluateImportRowsForRun(runId);
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		if (result.skippedNoKey) {
			qs.set('llm_skipped', '1');
		} else {
			qs.set('llm_evaluated', String(result.evaluated));
			qs.set('llm_succeeded', String(result.succeeded));
			if (result.failed > 0) qs.set('llm_failed', String(result.failed));
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
	},

	// Wave 1 (Codex round 4 P2): resolve a held shipment row by advancing
	// the admin-selected siblings to the row's lifecycle target. Held
	// rows are the abstain case — the shipment record + gift link already
	// exist; only the status-advance was deferred pending human judgment.
	// This finishes that advance in one click and clears the row's
	// error_message so it stops showing as "held".
	resolveHeld: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		const rowId = Number(fd.get('row_id'));
		if (!Number.isFinite(runId) || !Number.isFinite(rowId)) {
			return fail(400, { error: 'Missing run id or row id.' });
		}
		const db = getDb();
		const row = db
			.prepare<[number], ImportRow>('SELECT * FROM import_rows WHERE id = ?')
			.get(rowId);
		if (!row || !isHeldRow(row) || !row.parsed_order_id) {
			return fail(400, { error: 'Row is not a held shipment row.' });
		}
		const target = lifecycleTargetFor(row.email_type);
		const order = getOrderByOrderId(row.parsed_order_id);
		if (!target || !order) {
			return fail(400, { error: 'Could not resolve the order or lifecycle target.' });
		}
		// Which siblings did the admin tick to advance?
		const pickedIds = new Set(
			fd.getAll('advance_gift_id').map((v) => Number(v)).filter(Number.isFinite)
		);
		const siblings = listGiftsForOrder(order.id);
		let advanced = 0;
		for (const g of siblings) {
			if (!pickedIds.has(g.id)) continue;
			if (canTransition(g.status, target)) {
				transitionGift(g.id, target, locals.user.id);
				advanced += 1;
			}
		}
		// Clear the held marker now that the admin has resolved it. If
		// they advanced zero (deliberately — "none of these shipped"),
		// still clear it; their explicit decision IS the resolution.
		db.prepare(
			`UPDATE import_rows SET error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
		).run(rowId);
		logAudit({
			actorUserId: locals.user.id,
			entityType: 'import',
			entityId: row.import_run_id,
			action: 'amazon_resolve_held',
			summary: `Resolved held shipment row ${rowId}: advanced ${advanced} sibling(s) to ${target}.`
		});
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('resolved_held', String(advanced));
		throw redirect(303, `/admin/imports/amazon/review?${qs.toString()}`);
	},

	// td-8360f4: add an Amazon item to the exclusion list straight from the
	// review page. The admin clicks "Exclude" on a line item, trims the
	// pre-filled title down to its recurring core, and saves. We only create
	// the keyword here — the load filter (above) hides the now-excluded item
	// on the redirect render and on every other pending row, so no row
	// mutation is needed.
	excludeItem: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const runId = Number(fd.get('run_id'));
		if (!Number.isFinite(runId)) return fail(400, { error: 'Missing run id.' });
		const keyword = String(fd.get('keyword') ?? '').trim();
		const matchType = String(fd.get('match_type') ?? 'contains');
		if (!keyword) return fail(400, { error: 'Keyword is required.' });
		try {
			createExclusionKeyword(keyword, matchType, null, locals.user.id);
		} catch (err) {
			const qs = new URLSearchParams();
			qs.set('run', String(runId));
			qs.set('exclude_error', err instanceof Error ? err.message : 'Could not add keyword.');
			throw redirect(303, `/admin/imports/amazon/review?${qs.toString()}`);
		}
		const qs = new URLSearchParams();
		qs.set('run', String(runId));
		qs.set('excluded_kw', keyword);
		throw redirect(303, `/admin/imports/amazon/review?${qs.toString()}`);
	}
};
