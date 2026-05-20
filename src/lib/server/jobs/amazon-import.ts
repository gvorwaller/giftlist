import { getDb } from '../db';
import { runJob, type JobResult } from './runner';
import {
	batchMoveToLabel,
	getFullMessage,
	listLabelMessages,
	trashMessagesUnderLabel
} from '../gmail-reader';
import { parseAmazonEmail, type ParsedAmazonEmail } from '../amazon-parser';
import { matchRecipient, saveAlias } from '../name-matcher';
import { logAudit } from '../audit';
import { isPersonVisibleToUser } from '../people';
import { createGift, getGiftById, updateGift } from '../gifts';
import { ensureVendor } from '../vendors';
import { transitionGift, canTransition } from './../gift-status';
import {
	getOrderByOrderId,
	listGiftsForOrder,
	matchSiblingsToShipment,
	upsertOrderByOrderId,
	upsertShipment
} from '../orders';
import { rankCandidatesForImport, rankCandidatesForItems } from '../gift-matcher';
import { llmMatchImportRow } from '../llm-matcher';
import { planShipmentAdvanceForRow, type ShipmentAdvancePlan } from '../shipment-decider';
import type { ParsedAmazonItem } from '../amazon-parser';
import type {
	EmailType,
	Gift,
	GiftStatus,
	ImportRow,
	ImportRowDisposition,
	ImportRun,
	ImportRunStatus,
	MatchConfidence
} from '../types';

export const INBOX_LABEL = 'Giftlist/Amazon/Inbox';
export const PROCESSED_LABEL = 'Giftlist/Amazon/Processed';
export const FAILED_LABEL = 'Giftlist/Amazon/Failed';
export const SCAN_JOB = 'amazon.scan';
export const PROCESSED_RETENTION_DAYS = 180;

export interface ScanResult {
	runId: number;
	fetched: number;
	parsed: number;
	newRows: number;
	existingRows: number;
	autoMoved: number;
}

function setRunStatus(
	runId: number,
	status: ImportRunStatus,
	errorMessage: string | null = null
): void {
	const db = getDb();
	db.prepare(
		`UPDATE import_runs
		    SET status = ?,
		        finished_at = CASE WHEN ? IN ('committed','error','ready_for_review')
		                           THEN CURRENT_TIMESTAMP
		                           ELSE finished_at END,
		        error_message = COALESCE(?, error_message)
		  WHERE id = ?`
	).run(status, status, errorMessage, runId);
}

function bumpCounts(
	runId: number,
	fields: Partial<{ fetched_count: number; parsed_count: number; skipped_count: number; created_count: number }>
): void {
	const db = getDb();
	const cols = Object.keys(fields) as (keyof typeof fields)[];
	if (cols.length === 0) return;
	const assigns = cols.map((c) => `${c} = ${c} + ?`).join(', ');
	const vals = cols.map((c) => fields[c]!);
	db.prepare(`UPDATE import_runs SET ${assigns} WHERE id = ?`).run(...vals, runId);
}

function createRun(userId: number): ImportRun {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO import_runs (source, actor_user_id, status) VALUES ('amazon_email', ?, 'running')`
		)
		.run(userId);
	return db
		.prepare<[number | bigint], ImportRun>('SELECT * FROM import_runs WHERE id = ?')
		.get(info.lastInsertRowid)!;
}

/**
 * Pulls unprocessed messages from INBOX_LABEL, parses each, stages import_rows.
 * Idempotent: source_message_id is UNIQUE, so re-running skips messages already
 * staged from an earlier scan.
 */
export async function runAmazonScan(
	userId: number,
	opts?: { limit?: number }
): Promise<JobResult<ScanResult>> {
	return runJob<ScanResult>(
		SCAN_JOB,
		async () => {
			const run = createRun(userId);
			const db = getDb();
			const existingIdStmt = db.prepare<
				[string],
				{ id: number }
			>('SELECT id FROM import_rows WHERE source_message_id = ?');
			const insertRowStmt = db.prepare(
				`INSERT INTO import_rows (
				   import_run_id, source_message_id, source_thread_id, subject, received_at,
				   from_address, email_type, parsed_title, parsed_order_id, parsed_price_cents,
				   parsed_tracking_number, parsed_carrier, parsed_recipient_name,
				   parsed_shipping_address, parsed_gift_message, parsed_amazon_tracking_url,
				   parsed_items_json, parsed_body_excerpt,
				   match_person_id, match_confidence, match_candidates_json, disposition,
				   llm_verdict_json
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);

			let summaries;
			try {
				// Default to 50 per run so scans fit inside SvelteKit's action
				// timeout against a first-time backlog. Idempotent — re-run to
				// pick up the next 50.
				summaries = await listLabelMessages(userId, INBOX_LABEL, {
					maxResults: opts?.limit ?? 50
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setRunStatus(run.id, 'error', message);
				throw err;
			}
			bumpCounts(run.id, { fetched_count: summaries.length });

			let parsed = 0;
			let newRows = 0;
			let existing = 0;

			// Skip already-staged ids before hitting Gmail for bodies.
			const fresh = summaries.filter((s) => !existingIdStmt.get(s.id));
			existing = summaries.length - fresh.length;

			// Auto-skipped messages (marketing / review_request) and historical
			// stragglers — rows already staged with non-pending disposition that
			// somehow remain in INBOX_LABEL — get batch-moved to PROCESSED_LABEL
			// at the end of the scan so the inbox label doesn't accumulate noise.
			const idsToMove: string[] = [];

			// Bounded parallelism for getFullMessage. messages.get is 5 quota
			// units; Gmail allows 250 units/sec/user, so concurrency 10 = 50
			// units/sec sustained — comfortably below the throttle. Serial
			// fetches froze the admin round-trip on the first 200-msg attempt.
			//
			// Wave 1: after parsing each batch, we dispatch LLM matcher calls
			// in parallel for the pending rows and await all before serial
			// insert. Sequential DB writes (better-sqlite3 is single-writer)
			// happen with the verdicts already in hand, so the only added
			// wall-clock per batch is `max(Gmail-fetch-time, LLM-call-time)`
			// instead of summing them.
			const FETCH_CONCURRENCY = 10;
			let llmCalls = 0;
			let llmErrors = 0;
			for (let offset = 0; offset < fresh.length; offset += FETCH_CONCURRENCY) {
				const batch = fresh.slice(offset, offset + FETCH_CONCURRENCY);
				const fetchResults = await Promise.allSettled(
					batch.map((s) => getFullMessage(userId, s.id))
				);

				// Phase 1: parse each successful fetch + compute the recipient
				// match. All sync work — no DB writes yet.
				type StagedParse = {
					summary: (typeof batch)[number];
					parse: ParsedAmazonEmail;
					bodyExcerpt: string | null;
					recipientHit: ReturnType<typeof matchRecipient>;
					disposition: ImportRowDisposition;
				};
				const staged: Array<StagedParse | null> = batch.map((s, i) => {
					const res = fetchResults[i];
					if (res.status !== 'fulfilled') {
						console.warn(`[amazon-import] failed to fetch ${s.id}:`, res.reason);
						return null;
					}
					const parse = parseAmazonEmail(res.value);
					parsed += 1;
					// Wave 1 follow-up: persist a body excerpt (≤4000 chars) so the
					// LLM matcher has fallback context when the structured items[]
					// extractor missed everything. Only useful for pending dispositions
					// — auto-skipped marketing rows never call the LLM.
					const bodyExcerpt =
						parse.items.length === 0 && res.value.bodyText
							? res.value.bodyText.slice(0, 4000)
							: null;
					const recipientMatch = matchRecipient(parse.recipientName);
					const match = recipientMatch.personId
						? recipientMatch
						: applyOrderIdFallback(recipientMatch, parse.orderId);
					const disposition = defaultDisposition(parse.emailType);
					return { summary: s, parse, bodyExcerpt, recipientHit: match, disposition };
				});

				// Phase 2: LLM verdict per pending row, dispatched in parallel.
				// Marketing/review_request and unknown-type rows skip the LLM —
				// they auto-skip in commit anyway and don't need a verdict.
				const verdictPromises: Array<Promise<string | null>> = staged.map((st) =>
					st && st.disposition === 'pending'
						? buildAndCallMatcher(st.parse, st.bodyExcerpt)
						: Promise.resolve(null)
				);
				const verdictResults = await Promise.allSettled(verdictPromises);

				// Phase 3: serial insert.
				for (let i = 0; i < batch.length; i++) {
					const st = staged[i];
					if (!st) continue;
					const { summary: s, parse, bodyExcerpt, recipientHit: match, disposition } = st;
					const candidatesJson = JSON.stringify(match.candidates);
					const itemsJson = parse.items.length > 0 ? JSON.stringify(parse.items) : null;
					let llmVerdictJson: string | null = null;
					const vr = verdictResults[i];
					if (vr.status === 'fulfilled' && vr.value) {
						llmVerdictJson = vr.value;
						llmCalls += 1;
					} else if (vr.status === 'rejected') {
						llmErrors += 1;
						console.warn('[amazon-import] llm matcher rejected:', vr.reason);
					}
					insertRowStmt.run(
						run.id,
						s.id,
						s.threadId,
						s.subject,
						s.receivedAt,
						s.from,
						parse.emailType,
						parse.title,
						parse.orderId,
						parse.priceCents,
						parse.trackingNumber,
						parse.carrier,
						parse.recipientName,
						parse.shippingAddress,
						parse.giftMessage,
						parse.trackingUrl,
						itemsJson,
						bodyExcerpt,
						match.personId,
						match.confidence,
						candidatesJson,
						disposition,
						llmVerdictJson
					);
					newRows += 1;
					if (disposition !== 'pending') idsToMove.push(s.id);
				}
			}
			if (llmErrors > 0) {
				console.warn(
					`[amazon-import] LLM matcher: ${llmCalls} ok, ${llmErrors} errors. Review page shows heuristic-only for affected rows.`
				);
			}

			// Stragglers: summaries already in import_rows whose disposition is
			// no longer pending (auto-skipped before this fix shipped, or skipped
			// via UI but the prior batch label move failed). Fold them into the
			// same batch-move so the inbox label self-heals over time.
			if (existing > 0) {
				const freshIds = new Set(fresh.map((s) => s.id));
				const dispoStmt = db.prepare<[string], { disposition: string }>(
					'SELECT disposition FROM import_rows WHERE source_message_id = ?'
				);
				for (const s of summaries) {
					if (freshIds.has(s.id)) continue;
					const row = dispoStmt.get(s.id);
					if (row && row.disposition !== 'pending') idsToMove.push(s.id);
				}
			}

			let autoMoved = 0;
			if (idsToMove.length > 0) {
				try {
					await batchMoveToLabel(userId, idsToMove, INBOX_LABEL, PROCESSED_LABEL);
					autoMoved = idsToMove.length;
				} catch (err) {
					console.warn('[amazon-import] auto-skip label move failed:', err);
				}
			}

			bumpCounts(run.id, { parsed_count: parsed });
			setRunStatus(run.id, 'ready_for_review');

			logAudit({
				actorUserId: userId,
				entityType: 'import',
				entityId: run.id,
				action: 'amazon_scan',
				summary: `Scanned ${summaries.length} messages; staged ${newRows} new (${existing} already staged)${autoMoved > 0 ? `; moved ${autoMoved} auto-skipped to processed` : ''}`
			});

			return {
				runId: run.id,
				fetched: summaries.length,
				parsed,
				newRows,
				existingRows: existing,
				autoMoved
			};
		},
		{
			summarize: (r) =>
				`run ${r.runId} — fetched ${r.fetched}, ${r.newRows} new rows, ${r.existingRows} already staged${r.autoMoved > 0 ? `, ${r.autoMoved} auto-moved` : ''}`
		}
	);
}

function defaultDisposition(emailType: EmailType): ImportRowDisposition {
	// Marketing / review-request emails default to skipped so the review UI
	// doesn't drown the admin. Order-lifecycle emails stay pending for review.
	if (emailType === 'marketing' || emailType === 'review_request') return 'skipped';
	return 'pending';
}

/**
 * Order# is the strongest signal we have when Amazon's emails strip recipient
 * (every shipped/delivered email these days). If the parsed order_id matches an
 * existing gift, take that gift's person as authoritative — the commit-time
 * resolveOrCreateGift will then link to the existing gift instead of creating
 * a duplicate.
 */
function findGiftPersonByOrderId(orderId: string | null): {
	personId: number;
	personDisplayName: string;
	giftId: number;
} | null {
	if (!orderId) return null;
	const db = getDb();
	const hit = db
		.prepare<[string], { id: number; person_id: number; display_name: string }>(
			`SELECT g.id, g.person_id, p.display_name
			   FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE g.order_id = ? AND g.is_archived = 0
			  ORDER BY g.id DESC LIMIT 1`
		)
		.get(orderId);
	if (!hit) return null;
	return { personId: hit.person_id, personDisplayName: hit.display_name, giftId: hit.id };
}

function applyOrderIdFallback(
	recipientMatch: ReturnType<typeof matchRecipient>,
	orderId: string | null
): ReturnType<typeof matchRecipient> {
	const hit = findGiftPersonByOrderId(orderId);
	if (!hit) return recipientMatch;
	return {
		personId: hit.personId,
		confidence: 'exact',
		candidates: [
			{
				personId: hit.personId,
				displayName: hit.personDisplayName,
				confidence: 'exact'
			},
			...recipientMatch.candidates
		]
	};
}

/**
 * Wave 1: build the LLM matcher input from a parsed Amazon email and
 * call the matcher. Returns the verdict as a JSON string (for direct
 * insert into `import_rows.llm_verdict_json`) or null when no candidates
 * exist, no API key is configured, or the call fails.
 */
async function buildAndCallMatcher(
	parse: ParsedAmazonEmail,
	bodyExcerpt: string | null = null
): Promise<string | null> {
	// Recipient hint: when the order_id maps to an existing gift, that
	// gift's recipient is the strongest signal we have.
	const orderHit = findGiftPersonByOrderId(parse.orderId);
	const recipientHintPersonId = orderHit?.personId ?? null;

	// Codex P2: multi-item emails carry N item titles in parse.items[].
	// Use the multi-title ranker so candidates relevant to items 1..N
	// also enter the shortlist (single-title ranking against parse.title
	// = items[0] only would systematically hide them from the LLM).
	const itemTitles =
		parse.items.length > 0
			? parse.items.map((i) => i.title).filter((t): t is string => !!t)
			: parse.title
				? [parse.title]
				: [];
	const candidates = rankCandidatesForItems(itemTitles, recipientHintPersonId, 20);
	if (candidates.length === 0) return null;

	const verdict = await llmMatchImportRow({
		emailSubject: null, // not exposed in ParsedAmazonEmail; subject lives on the import row
		emailType: parse.emailType,
		orderId: parse.orderId,
		parsedRecipientName: parse.recipientName,
		recipientHintPersonId,
		vendorLabel: 'Amazon',
		items: parse.items.map((it, idx) => ({
			itemIndex: idx,
			title: it.title,
			priceCents: it.priceCents,
			quantity: it.quantity
		})),
		bodyFallback: bodyExcerpt,
		candidates,
		corrections: [] // Wave 2 feature
	});
	if (!verdict) return null;
	return JSON.stringify(verdict);
}

/**
 * Wave 1: rebuild the LLM matcher input from a persisted ImportRow and
 * call the matcher. Mirrors `buildAndCallMatcher` for the scan path but
 * sources its inputs from the row instead of a fresh Gmail parse, so
 * the "Re-run AI matcher" admin button can refresh verdicts on rows
 * that were staged before a key was configured (or before this Wave
 * landed) without re-fetching Gmail.
 */
async function buildAndCallMatcherFromRow(row: ImportRow): Promise<string | null> {
	const items = parseRowItems(row);
	const orderHit = findGiftPersonByOrderId(row.parsed_order_id);
	const recipientHintPersonId = orderHit?.personId ?? row.match_person_id ?? null;
	const needle = row.parsed_title ?? '';
	if (!needle && items.length === 0) return null;
	// Codex P2: rank against every item title, not just parsed_title
	// (which is items[0] only).
	const itemTitles =
		items.length > 0
			? items.map((i) => i.title).filter((t): t is string => !!t)
			: needle
				? [needle]
				: [];
	const candidates = rankCandidatesForItems(itemTitles, recipientHintPersonId, 20);
	if (candidates.length === 0) return null;

	const verdict = await llmMatchImportRow({
		emailSubject: row.subject,
		emailType: row.email_type,
		orderId: row.parsed_order_id,
		parsedRecipientName: row.parsed_recipient_name,
		recipientHintPersonId,
		vendorLabel: 'Amazon',
		items: items.map((it, idx) => ({
			itemIndex: idx,
			title: it.title,
			priceCents: it.priceCents,
			quantity: it.quantity
		})),
		bodyFallback: row.parsed_body_excerpt,
		candidates,
		corrections: []
	});
	if (!verdict) return null;
	return JSON.stringify(verdict);
}

export interface ReevaluateRunResult {
	evaluated: number;
	succeeded: number;
	failed: number;
	skippedNoKey: boolean;
}

/**
 * Wave 1: admin-triggered re-evaluation. Walks every pending row in
 * the run, force-refreshes its LLM verdict against the CURRENT open-
 * gifts pool (admin may have added/edited gifts since the scan), and
 * updates `import_rows.llm_verdict_json` in place. The matcher's own
 * cache layer absorbs identical re-calls — only changed candidate
 * sets actually hit the API.
 */
export async function reevaluateImportRowsForRun(runId: number): Promise<ReevaluateRunResult> {
	const out: ReevaluateRunResult = {
		evaluated: 0,
		succeeded: 0,
		failed: 0,
		skippedNoKey: false
	};
	if (!process.env.ANTHROPIC_API_KEY) {
		out.skippedNoKey = true;
		return out;
	}
	const db = getDb();
	const rows = db
		.prepare<[number], ImportRow>(
			`SELECT * FROM import_rows WHERE import_run_id = ? AND disposition = 'pending'`
		)
		.all(runId);
	const updateStmt = db.prepare(
		`UPDATE import_rows SET llm_verdict_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
	);
	for (const row of rows) {
		out.evaluated += 1;
		try {
			const json = await buildAndCallMatcherFromRow(row);
			updateStmt.run(json, row.id);
			if (json) out.succeeded += 1;
		} catch (err) {
			out.failed += 1;
			console.warn(`[amazon-import] reevaluate row ${row.id} failed:`, err);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Commit path

export interface CommitRowInput {
	rowId: number;
	action: 'accept' | 'skip';
	assignedPersonId?: number;
	/**
	 * Optional: link this email to an existing gift instead of creating a new
	 * one. Used when the review UI's title-fuzzy matcher proposes a pre-existing
	 * "idea"/"planned" gift. The gift's person_id wins over assignedPersonId,
	 * and its order_id is stamped from the email so subsequent shipped/delivered
	 * messages auto-bind via the existing order_id grouping.
	 */
	assignedGiftId?: number;
	saveAsAlias?: boolean;
	/**
	 * td-3e9ae2: per-line-item recipient assignments for a multi-item order.
	 * When supplied (length >= 1), the commit path creates one `orders` row
	 * plus N gifts (one per line item), each carrying its own person_id +
	 * line_item_index. When omitted, behavior is unchanged: a single gift
	 * is created from the row's top-level parsed fields.
	 */
	lineItems?: Array<{
		lineItemIndex: number;
		assignedPersonId: number;
		assignedGiftId?: number;
	}>;
}

export interface CommitResult {
	/** Truly new gift rows inserted. */
	giftsCreated: number;
	/** Existing gifts that dedup linked to (no new row, status may advance). */
	giftsLinked: number;
	/** Existing siblings whose status was forward-transitioned via lifecycle
	 *  events (e.g. ordered→shipped). Counts every sibling-advance event,
	 *  including ones tied to linked-not-created gifts. */
	siblingsAdvanced: number;
	rowsSkipped: number;
	rowsFailed: number;
	labelMoveFailures: number;
	/** Wave 1 Phase 2: rows where the LLM/heuristic could not confidently
	 * decide which siblings shipped. Their shipment row was still
	 * created, but no sibling advanced status; row is flagged with an
	 * `error_message` describing the abstain so admin can manually
	 * advance from /admin/system. */
	rowsAbstained: number;
}

/**
 * Applies admin review decisions:
 *   - accept: creates/updates a gift, moves the email to PROCESSED_LABEL
 *   - skip:   marks disposition='skipped', moves email to PROCESSED_LABEL anyway
 * Accepts group naturally via shared parsed_order_id — the first order_placed /
 * shipped / delivered email creates the gift; subsequent ones update status/fields.
 */
export async function commitReviewedRows(
	userId: number,
	decisions: CommitRowInput[]
): Promise<CommitResult> {
	const db = getDb();
	const result: CommitResult = {
		giftsCreated: 0,
		giftsLinked: 0,
		siblingsAdvanced: 0,
		rowsSkipped: 0,
		rowsFailed: 0,
		labelMoveFailures: 0,
		rowsAbstained: 0
	};

	const rowStmt = db.prepare<[number], ImportRow>('SELECT * FROM import_rows WHERE id = ?');
	const updateRow = db.prepare(
		`UPDATE import_rows
		    SET disposition = ?, gift_id = ?, match_person_id = ?, match_confidence = ?,
		        error_message = ?, updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	);

	// Group accepted rows by order id so we process all emails for the same order
	// in one pass and keep the gift in sync across order_placed / shipped /
	// delivered.
	const accepted = decisions.filter((d) => d.action === 'accept');
	const skipped = decisions.filter((d) => d.action === 'skip');

	const byOrder = new Map<string, CommitRowInput[]>();
	for (const d of accepted) {
		const row = rowStmt.get(d.rowId);
		if (!row) continue;
		const key = row.parsed_order_id ?? `row:${row.id}`;
		if (!byOrder.has(key)) byOrder.set(key, []);
		byOrder.get(key)!.push(d);
	}

	// Wave 1 Phase 2: shipment-advance decisions need an async LLM call,
	// but the commit loop is otherwise sync DB work.
	//
	// Codex round 4 P1: the planner feeds each sibling's CURRENT status
	// into the LLM prompt. A pre-flight that plans all rows up front in
	// parallel would build the `delivered` row's plan against stale
	// `ordered`-status siblings before the same order's `shipped` row
	// advances them. So we plan JIT — inside the commit loop, right
	// before each shipment row's `applyLifecycleEvent`, after every
	// earlier row in lifecycle order has already mutated state. The lost
	// parallelism is negligible (batches are 1-3 rows in practice) and
	// JIT-only is correct under every commit ordering.
	//
	// `computeShipmentPlan` is called once per shipment row from the
	// commit loop. No memoization across rows — each call re-reads
	// current sibling state. (The LLM matcher's own cache absorbs
	// identical re-calls; its key now includes a sibling-status hash so
	// a re-plan after a status change correctly misses the cache.)
	const computeShipmentPlan = async (
		row: ImportRow
	): Promise<ShipmentAdvancePlan | null> => {
		if (row.email_type !== 'shipped' && row.email_type !== 'delivered') return null;
		if (!row.parsed_order_id) return null;
		const order = getOrderByOrderId(row.parsed_order_id);
		if (!order) return null;
		const items = parseRowItems(row);
		try {
			return await planShipmentAdvanceForRow(row, order.id, items);
		} catch (err) {
			console.warn(`[amazon-import] shipment plan failed for row ${row.id}:`, err);
			return {
				kind: 'abstain',
				reason: 'Planner threw; siblings held pending manual review.'
			};
		}
	};

	// Collect message ids to move in a single Gmail batchModify at the end —
	// one round trip instead of one per message.
	const messagesToMove: string[] = [];

	// Accept pass.
	for (const [, group] of byOrder) {
		// Sort the group by email_type in lifecycle order so the gift is created
		// from the order_placed email (if present) before shipped/delivered pile
		// on their status transitions.
		const orderedGroup = group
			.map((d) => ({ d, row: rowStmt.get(d.rowId)! }))
			.filter((x) => x.row)
			.sort((a, b) => lifecycleOrder(a.row.email_type) - lifecycleOrder(b.row.email_type));

		// If any decision in this group links to an existing gift, that wins:
		// load it once, override personId from the gift, skip create.
		const linkDecision = orderedGroup.find((x) => x.d.assignedGiftId);
		const linkedGift =
			linkDecision && linkDecision.d.assignedGiftId
				? getGiftById(linkDecision.d.assignedGiftId)
				: null;

		let giftId: number | null = linkedGift?.id ?? null;
		for (const { d, row } of orderedGroup) {
			// td-3e9ae2: multi-item path. When the admin specified per-line
			// recipients (typically on the order_placed email of a 2+ item
			// order), create one order + N gifts up front and skip the
			// single-gift legacy path. Subsequent shipped/delivered emails
			// for the same order auto-bind via applyLifecycleEvent → order
			// sibling-walk.
			if (d.lineItems && d.lineItems.length > 0 && !linkedGift) {
				try {
					const items = parseRowItems(row);
					const ids = commitMultiItemAccept(row, d.lineItems, items, userId);
					result.giftsCreated += ids.createdIds.length;
					result.giftsLinked += ids.linkedIds.length;
					// Use the first-item gift as the canonical id for the
					// import_rows.gift_id column (one column, N gifts — pick
					// the first stably). All N share the parent order_pk so
					// follow-up emails advance the entire group.
					giftId = ids.allIds[0] ?? null;
					// Codex2 P1 / Codex4 P1: plan JIT, right here, after this
					// group's order_placed sibling has created the order AND
					// any earlier shipment row has advanced sibling status.
					const plan = await computeShipmentPlan(row);
					const evt = applyLifecycleEvent(giftId!, row, userId, plan);
					if (evt.abstained) result.rowsAbstained += 1;
					result.siblingsAdvanced += evt.advancedCount;
					updateRow.run(
						'accepted',
						giftId,
						d.lineItems[0].assignedPersonId,
						row.match_confidence ?? 'none',
						evt.abstainReason,
						row.id
					);
					messagesToMove.push(row.source_message_id);
					continue;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					updateRow.run('failed', null, null, row.match_confidence, message, row.id);
					result.rowsFailed += 1;
					continue;
				}
			}

			// Linked gift's person is authoritative; otherwise fall back to the
			// admin's per-row pick or the auto-matched person.
			const personId = linkedGift?.person_id ?? d.assignedPersonId ?? row.match_person_id ?? null;
			if (!personId) {
				updateRow.run(
					'failed',
					row.gift_id,
					row.match_person_id,
					row.match_confidence,
					'No recipient assigned',
					row.id
				);
				result.rowsFailed += 1;
				continue;
			}

			// Per-user privacy guard (td-68804e parity): even though /admin is
			// admin-only, defense-in-depth — a crafted POST shouldn't be able
			// to assign an Amazon row to a self-person owned by another user.
			if (!isPersonVisibleToUser(personId, userId)) {
				updateRow.run(
					'failed',
					row.gift_id,
					row.match_person_id,
					row.match_confidence,
					'Recipient not visible to you (archived or another user\'s self-person).',
					row.id
				);
				result.rowsFailed += 1;
				continue;
			}

			if (d.saveAsAlias && row.parsed_recipient_name) {
				saveAlias(personId, row.parsed_recipient_name, 'import_assigned');
			}

			try {
				if (giftId == null) {
					const resolved = resolveOrCreateGift(row, personId, userId);
					giftId = resolved.id;
					if (resolved.created) result.giftsCreated += 1;
					else result.giftsLinked += 1;
				}
				// Codex2 P1 / Codex4 P1: plan JIT, right here, after this
				// group's order_placed sibling has created the order AND
				// any earlier shipment row has advanced sibling status.
				const plan = await computeShipmentPlan(row);
				const evt = applyLifecycleEvent(giftId, row, userId, plan);
				if (evt.abstained) result.rowsAbstained += 1;
				result.siblingsAdvanced += evt.advancedCount;
				updateRow.run(
					'accepted',
					giftId,
					personId,
					// Manual gift-link is an explicit human confirmation, so we record
					// it as 'exact' — the schema CHECK only allows the existing enum.
					linkedGift ? 'exact' : (row.match_confidence ?? 'none'),
					evt.abstainReason,
					row.id
				);
				messagesToMove.push(row.source_message_id);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				updateRow.run('failed', giftId, personId, row.match_confidence, message, row.id);
				result.rowsFailed += 1;
			}
		}
	}

	// Skip pass.
	for (const d of skipped) {
		const row = rowStmt.get(d.rowId);
		if (!row) continue;
		updateRow.run('skipped', row.gift_id, row.match_person_id, row.match_confidence, null, row.id);
		result.rowsSkipped += 1;
		messagesToMove.push(row.source_message_id);
	}

	// Single batchModify for every accepted + skipped message. 1 round trip
	// total (chunks of 1000) vs. one per message — the difference between a
	// sub-second commit and a multi-minute hang for the first skip-all.
	try {
		await batchMoveToLabel(userId, messagesToMove, INBOX_LABEL, PROCESSED_LABEL);
	} catch (err) {
		console.warn('[amazon-import] batch label move failed:', err);
		result.labelMoveFailures = messagesToMove.length;
	}

	return result;
}

function lifecycleOrder(t: EmailType): number {
	switch (t) {
		case 'order_placed':
			return 0;
		case 'shipped':
			return 1;
		case 'delivered':
			return 2;
		default:
			return 3;
	}
}

function resolveOrCreateGift(
	row: ImportRow,
	personId: number,
	userId: number
): { id: number; created: boolean } {
	const db = getDb();
	// td-3e9ae2: every Amazon import (single- or multi-item) gets an orders row.
	// Returns null when there's no order_id (e.g. malformed email).
	const orderPk = ensureOrderForRow(row, userId);

	// Existing gift already created from an earlier email in the same order group?
	if (row.parsed_order_id) {
		const hit = db
			.prepare<[string], Gift>(
				`SELECT * FROM gifts
				  WHERE order_id = ?
				    AND is_archived = 0
				  ORDER BY id DESC LIMIT 1`
			)
			.get(row.parsed_order_id);
		if (hit) {
			// Backfill order_pk on legacy gifts the first time they're touched.
			if (!hit.order_pk && orderPk) {
				updateGift(hit.id, {}, userId); // touch updated_at
				db.prepare('UPDATE gifts SET order_pk = ?, line_item_index = COALESCE(line_item_index, 0) WHERE id = ?').run(
					orderPk,
					hit.id
				);
			}
			return { id: hit.id, created: false };
		}
	}
	// Auto-create the Amazon vendor on first import so admins don't have to
	// pre-seed it. Subsequent imports just look it up.
	const amazonVendor = ensureVendor('Amazon', userId);
	const gift = createGift(
		{
			person_id: personId,
			title: row.parsed_title ?? row.subject ?? '(imported)',
			vendor_id: amazonVendor.id,
			occasion_id: null,
			occasion_year: new Date().getFullYear(),
			order_id: row.parsed_order_id,
			tracking_number: row.parsed_tracking_number,
			carrier: row.parsed_carrier,
			price_cents: row.parsed_price_cents,
			notes: row.parsed_gift_message ?? null,
			status: 'ordered',
			is_idea: false,
			amazon_tracking_url: row.parsed_amazon_tracking_url,
			order_pk: orderPk,
			line_item_index: orderPk ? 0 : null
		},
		userId
	);
	return { id: gift.id, created: true };
}

/**
 * td-3e9ae2: ensure an `orders` row exists for this import row's parsed_order_id.
 * Idempotent — re-running across order_placed → shipped → delivered emails
 * for the same order fills in tracking/timestamps without overwriting earlier
 * values. Returns null when the row has no order_id to key on.
 */
function ensureOrderForRow(row: ImportRow, userId: number): number | null {
	if (!row.parsed_order_id) return null;
	const amazonVendor = ensureVendor('Amazon', userId);
	const lifecycle = lifecycleTimestamps(row);
	return upsertOrderByOrderId({
		order_id: row.parsed_order_id,
		vendor_id: amazonVendor.id,
		tracking_number: row.parsed_tracking_number,
		carrier: row.parsed_carrier,
		amazon_tracking_url: row.parsed_amazon_tracking_url,
		ordered_at: lifecycle.ordered_at,
		shipped_at: lifecycle.shipped_at,
		delivered_at: lifecycle.delivered_at,
		source_message_id: row.source_message_id
	});
}

/** Map email_type → which lifecycle timestamp this email stamps. */
function lifecycleTimestamps(row: ImportRow): {
	ordered_at: string | null;
	shipped_at: string | null;
	delivered_at: string | null;
} {
	const at = row.received_at;
	if (row.email_type === 'order_placed') return { ordered_at: at, shipped_at: null, delivered_at: null };
	if (row.email_type === 'shipped') return { ordered_at: null, shipped_at: at, delivered_at: null };
	if (row.email_type === 'delivered') return { ordered_at: null, shipped_at: null, delivered_at: at };
	return { ordered_at: null, shipped_at: null, delivered_at: null };
}

/**
 * Wave 1 Phase 3 (Codex review #3 + #4): multi-item accept with
 * deterministic dedup.
 *
 * Before creating a fresh gift for each line item we look for an
 * existing sibling under the same order_pk and route through the
 * link-branch when found. Matching strategies, in order:
 *
 *   1. EXACT match by (order_pk, line_item_index) — the deterministic
 *      common case where order_placed was committed and shipped/
 *      delivered emails arrive later with the same item ordering.
 *   2. CONTENT fingerprint match (`sha1(normalized title + price)`) —
 *      covers the case where Amazon reordered the items between
 *      emails. Fingerprint is composed from data the parser actually
 *      extracts, so it's stable across email types.
 *
 * Recipient mismatch (admin picked person B for line item N but an
 * existing sibling at that slot was created for person A) FAILS the
 * commit with an explicit error rather than silently overriding. Per
 * user's earlier "Refuse to commit; surface the conflict" choice.
 *
 * Wrapped in `db.transaction()` so partial failure rolls back all
 * sibling operations for this row. The DB partial unique index on
 * active `(order_pk, line_item_index)` (migration 025) is the final
 * line of defense against duplicates if the matcher logic above is
 * ever wrong.
 */
export interface MultiItemAcceptResult {
	createdIds: number[];
	linkedIds: number[];
	/** Concatenation in line-item order — kept for callers that want the
	 * canonical "first gift" id without caring about created-vs-linked. */
	allIds: number[];
}

function commitMultiItemAccept(
	row: ImportRow,
	lineItems: NonNullable<CommitRowInput['lineItems']>,
	items: ParsedAmazonItem[],
	userId: number
): MultiItemAcceptResult {
	const orderPk = ensureOrderForRow(row, userId);
	if (!orderPk) {
		throw new Error(`Multi-item accept requires parsed_order_id, but row ${row.id} has none.`);
	}
	const amazonVendor = ensureVendor('Amazon', userId);
	const db = getDb();

	// Pre-flight: load existing siblings under this order. Used for
	// deterministic dedup against duplicate creation. `is_archived = 0`
	// filter so cleanup-archived rows (migration 025) don't false-match.
	const existingSiblings = db
		.prepare<[number], Gift>(
			`SELECT * FROM gifts WHERE order_pk = ? AND is_archived = 0`
		)
		.all(orderPk);
	const byLineIndex = new Map<number, Gift>();
	// Codex P1: when an order legitimately has two same-title items (e.g.
	// the same gift bought twice for two different recipients), a
	// `Map<string, Gift>` would lose one. Track the full list per
	// fingerprint and disambiguate via line_item_index below.
	const byFingerprint = new Map<string, Gift[]>();
	for (const sib of existingSiblings) {
		if (sib.line_item_index != null) byLineIndex.set(sib.line_item_index, sib);
		const fp = giftFingerprint(sib.title);
		const list = byFingerprint.get(fp);
		if (list) list.push(sib);
		else byFingerprint.set(fp, [sib]);
	}
	// Track which sibling ids we've already matched in this commit so a
	// second incoming line item with the same fingerprint resolves to
	// the OTHER sibling rather than re-using the first.
	const consumedSiblingIds = new Set<number>();
	const usedLineIndexes = new Set<number>(
		existingSiblings.map((s) => s.line_item_index).filter((i): i is number => i != null)
	);
	const nextFreeLineIndex = (): number => {
		let i = 0;
		while (usedLineIndexes.has(i)) i++;
		usedLineIndexes.add(i);
		return i;
	};

	return db.transaction((): MultiItemAcceptResult => {
		const createdIds: number[] = [];
		const linkedIds: number[] = [];
		const allIds: number[] = [];

		for (const li of lineItems) {
			// Allow holes: a lineItem with no items[lineItemIndex] uses
			// fallbacks from the row top-level (defensive — UI shouldn't
			// send a bad index).
			const item = items[li.lineItemIndex];
			const title = item?.title ?? row.parsed_title ?? row.subject ?? '(imported)';
			const priceCents = item?.priceCents ?? null;

			if (!isPersonVisibleToUser(li.assignedPersonId, userId)) {
				throw new Error(
					`Recipient not visible to you (archived or another user's self-person).`
				);
			}

			// Resolve which existing gift (if any) this line item should
			// link to instead of creating new.
			//   1. Admin explicitly picked one in the UI (LLM verdict or
			//      manual radio). That always wins.
			//   2. Sibling exists with the same content fingerprint
			//      (normalized title). Primary auto-match — Amazon's
			//      emails frequently reorder items between order_placed
			//      and shipped/delivered, so line_item_index alone is
			//      unreliable.
			//      When multiple siblings share a fingerprint (legit case:
			//      same gift bought twice for two recipients — Codex P1),
			//      disambiguate by line_item_index, then by un-consumed
			//      candidates, and if still ambiguous fail loudly.
			//   3. Sibling exists at the exact same line_item_index AND
			//      title is missing/unparseable (fingerprint fallback).
			let dedupTarget: Gift | null = null;
			let dedupSource: 'admin' | 'fingerprint' | 'lineindex' | null = null;
			if (li.assignedGiftId) {
				dedupTarget = getGiftById(li.assignedGiftId) ?? null;
				if (dedupTarget) dedupSource = 'admin';
			}
			if (!dedupTarget) {
				const fp = giftFingerprint(title);
				const candidatesAtFp = (byFingerprint.get(fp) ?? []).filter(
					(g) => !consumedSiblingIds.has(g.id)
				);
				if (candidatesAtFp.length === 1) {
					dedupTarget = candidatesAtFp[0];
					dedupSource = 'fingerprint';
				} else if (candidatesAtFp.length > 1) {
					// Multiple siblings share this title — disambiguate by the
					// incoming line_item_index first.
					const byIdx = candidatesAtFp.find(
						(g) => g.line_item_index === li.lineItemIndex
					);
					if (byIdx) {
						dedupTarget = byIdx;
						dedupSource = 'fingerprint';
					} else {
						// Then by chosen recipient — if exactly one sibling at
						// this fingerprint matches the picked person, use it.
						const byPerson = candidatesAtFp.filter(
							(g) => g.person_id === li.assignedPersonId
						);
						if (byPerson.length === 1) {
							dedupTarget = byPerson[0];
							dedupSource = 'fingerprint';
						} else {
							// Truly ambiguous. Fail rather than relink the
							// wrong sibling.
							throw new Error(
								`Ambiguous match: line item ${li.lineItemIndex} ("${title}") matches ${candidatesAtFp.length} existing siblings with the same title and no line_item_index or recipient discriminator — resolve manually before committing.`
							);
						}
					}
				}
			}
			if (!dedupTarget) {
				// Fallback only when fingerprint dedup didn't fire — typically
				// when the existing sibling and the incoming row share an idx
				// AND the titles don't normalize to the same fingerprint.
				// Rare. Kept for parity with legacy data where titles were
				// truncated or generic.
				const byIdx = byLineIndex.get(li.lineItemIndex);
				if (
					byIdx &&
					!consumedSiblingIds.has(byIdx.id) &&
					giftFingerprint(byIdx.title) === giftFingerprint(title)
				) {
					dedupTarget = byIdx;
					dedupSource = 'lineindex';
				}
			}

			if (dedupTarget) {
				// Recipient-conflict check. Admin's explicit `assignedGiftId`
				// (source = 'admin') overrides any prior recipient — they're
				// telling the system to relink. The auto-match paths refuse
				// to override silently.
				if (
					dedupSource !== 'admin' &&
					dedupTarget.person_id !== li.assignedPersonId
				) {
					throw new Error(
						`Recipient conflict: existing gift #${dedupTarget.id} ("${dedupTarget.title}") is for person ${dedupTarget.person_id}; commit picked person ${li.assignedPersonId}. Resolve via the gift edit page before committing.`
					);
				}

				updateGift(
					dedupTarget.id,
					{
						order_id: row.parsed_order_id,
						tracking_number:
							row.parsed_tracking_number ?? dedupTarget.tracking_number,
						carrier: row.parsed_carrier ?? dedupTarget.carrier,
						amazon_tracking_url:
							row.parsed_amazon_tracking_url ?? dedupTarget.amazon_tracking_url,
						price_cents: priceCents ?? dedupTarget.price_cents
					},
					userId
				);
				// Stamp order_pk only. line_item_index stays as set by the
				// FIRST email to touch this gift (canonically the
				// order_placed email's enumeration). Updating it now would
				// collide with the partial unique index when Amazon
				// reordered items between emails.
				if (dedupTarget.line_item_index == null) {
					db.prepare(
						'UPDATE gifts SET order_pk = ?, line_item_index = ? WHERE id = ?'
					).run(orderPk, li.lineItemIndex, dedupTarget.id);
					usedLineIndexes.add(li.lineItemIndex);
				} else {
					db.prepare('UPDATE gifts SET order_pk = ? WHERE id = ?').run(
						orderPk,
						dedupTarget.id
					);
				}
				if (canTransition(dedupTarget.status, 'ordered')) {
					transitionGift(dedupTarget.id, 'ordered', userId);
				}
				consumedSiblingIds.add(dedupTarget.id);
				linkedIds.push(dedupTarget.id);
				allIds.push(dedupTarget.id);
				continue;
			}

			// Create new. If li.lineItemIndex is already taken by an
			// existing sibling (different content), pick the next free
			// index so we don't collide with the unique index.
			const insertIdx = usedLineIndexes.has(li.lineItemIndex)
				? nextFreeLineIndex()
				: (usedLineIndexes.add(li.lineItemIndex), li.lineItemIndex);
			const gift = createGift(
				{
					person_id: li.assignedPersonId,
					title,
					vendor_id: amazonVendor.id,
					occasion_id: null,
					occasion_year: new Date().getFullYear(),
					order_id: row.parsed_order_id,
					tracking_number: row.parsed_tracking_number,
					carrier: row.parsed_carrier,
					price_cents: priceCents,
					notes: row.parsed_gift_message ?? null,
					status: 'ordered',
					is_idea: false,
					amazon_tracking_url: row.parsed_amazon_tracking_url,
					order_pk: orderPk,
					line_item_index: insertIdx
				},
				userId
			);
			createdIds.push(gift.id);
			allIds.push(gift.id);
		}
		return { createdIds, linkedIds, allIds };
	})();
}

/** Wave 1 Phase 3: stable content fingerprint for an Amazon line item.
 * Normalized lowercased title with whitespace collapsed. Price is
 * NOT part of the fingerprint — Amazon's parser populates price on
 * some emails but not others (order_placed enumerates differently
 * than shipped/delivered for the same item), so price-sensitivity
 * would cause false-misses across email types. The denomination
 * itself is typically present in the title for fixed-amount items
 * ("MasterCard ... $100"), so title-only fingerprints distinguish
 * the two MasterCard items without needing the parsed price. */
export function giftFingerprint(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface LifecycleEventResult {
	abstained: boolean;
	abstainReason: string | null;
	shipmentId: number | null;
	/** Count of siblings whose status was forward-transitioned by this event. */
	advancedCount: number;
}

function applyLifecycleEvent(
	giftId: number,
	row: ImportRow,
	userId: number,
	shipmentPlan: ShipmentAdvancePlan | null = null
): LifecycleEventResult {
	// Wave 1 Phase 2 (Codex review #2): the silent "advance ALL siblings"
	// fallback is gone. Lifecycle handling:
	//
	//   order_placed: refresh order facts; advance ALL siblings to 'ordered'.
	//   shipped:      create/find an order_shipments row from this email's
	//                 tracking facts; advance ONLY the siblings the
	//                 pre-flight shipment plan identified. When the plan
	//                 abstains (LLM uncertain), the shipment row is still
	//                 created (tracking info is real) but NO siblings
	//                 advance — caller surfaces the abstain to admin.
	//   delivered:    same as shipped, with delivered_at + status target.
	const seed = getGiftById(giftId);
	if (!seed) {
		return { abstained: false, abstainReason: null, shipmentId: null, advancedCount: 0 };
	}
	let siblings: Gift[] = [seed];
	if (seed.order_pk) {
		const sibs = listGiftsForOrder(seed.order_pk);
		if (sibs.length > 0) siblings = sibs;
	}

	// Refresh order-level tracking on the parent orders row from this email's
	// fields. Idempotent fill-only via upsertOrderByOrderId.
	if (row.parsed_order_id) ensureOrderForRow(row, userId);

	const target = lifecycleStatus(row.email_type);
	const isShipmentEvent = row.email_type === 'shipped' || row.email_type === 'delivered';

	let shipmentId: number | null = null;
	let advanceSiblings: Gift[] = siblings;
	let abstained = false;
	let abstainReason: string | null = null;
	if (isShipmentEvent && seed.order_pk) {
		// Always create the shipment row — tracking info is real data and
		// belongs in the DB regardless of whether we can decide which
		// siblings are in the box.
		shipmentId = upsertShipment({
			order_pk: seed.order_pk,
			tracking_number: row.parsed_tracking_number,
			carrier: row.parsed_carrier,
			amazon_tracking_url: row.parsed_amazon_tracking_url,
			shipped_at: row.email_type === 'shipped' ? (row.received_at ?? null) : null,
			delivered_at: row.email_type === 'delivered' ? (row.received_at ?? null) : null,
			source_message_id: row.source_message_id,
			items_json: row.parsed_items_json
		});

		// If the caller didn't pre-compute a plan (e.g. the order_placed
		// flow that synthesizes a shipped-event from a different email
		// type), fall back to the heuristic-only path here. The pre-flight
		// path in commitReviewedRows is the normal entry.
		if (shipmentPlan) {
			if (shipmentPlan.kind === 'abstain') {
				abstained = true;
				abstainReason = shipmentPlan.reason;
				advanceSiblings = [];
			} else {
				const matchedSet = new Set(shipmentPlan.matchedSiblingIds);
				advanceSiblings = siblings.filter((s) => matchedSet.has(s.id));
			}
		} else {
			const shipmentItems = parseRowItems(row);
			const shippedTitles = shipmentItems
				.map((it) => it.title)
				.filter((t): t is string => !!t);
			const heuristic = matchSiblingsToShipment(siblings, shippedTitles);
			if (heuristic.heuristicCertain) {
				advanceSiblings = heuristic.matched;
			} else {
				// No pre-flight plan, no heuristic certainty. Be safe: don't
				// advance anything, surface the abstain. Pre-flight is the
				// path that gives the LLM a chance; without it we don't gamble.
				abstained = true;
				abstainReason =
					'Heuristic uncertain and no LLM pre-flight ran. Holding sibling status pending manual review.';
				advanceSiblings = [];
			}
		}
	}

	let advancedCount = 0;
	for (const current of siblings) {
		const isAdvancing = advanceSiblings.some((s) => s.id === current.id);

		// Merge newly-parsed fields that the first email may have missed.
		// For shipment events, only patch siblings actually in this shipment
		// (others may belong to a different box with different tracking).
		const patch: Parameters<typeof updateGift>[1] = {};
		if (isAdvancing) {
			if (row.parsed_tracking_number && !current.tracking_number) patch.tracking_number = row.parsed_tracking_number;
			if (row.parsed_carrier && !current.carrier) patch.carrier = row.parsed_carrier;
			if (row.parsed_amazon_tracking_url && !current.amazon_tracking_url) {
				patch.amazon_tracking_url = row.parsed_amazon_tracking_url;
			}
		}
		// Don't overwrite per-line price with order total on multi-item orders.
		if (row.parsed_price_cents && !current.price_cents && !current.order_pk) {
			patch.price_cents = row.parsed_price_cents;
		}
		if (row.parsed_order_id && !current.order_id) patch.order_id = row.parsed_order_id;
		if (Object.keys(patch).length > 0) {
			updateGift(current.id, patch, userId);
		}

		// td-d08902: attach the gift to this shipment so the per-recipient UI
		// can later show "shipped via UPS 1Z…" per sibling.
		if (shipmentId && isAdvancing && !current.shipment_id) {
			getDb()
				.prepare('UPDATE gifts SET shipment_id = ? WHERE id = ?')
				.run(shipmentId, current.id);
		}

		if (target && isAdvancing) {
			const fresh = getGiftById(current.id)!;
			if (canTransition(fresh.status, target)) {
				transitionGift(current.id, target, userId);
				advancedCount += 1;
			}
		}
	}
	return { abstained, abstainReason, shipmentId, advancedCount };
}

function lifecycleStatus(t: EmailType): GiftStatus | null {
	if (t === 'order_placed') return 'ordered';
	if (t === 'shipped') return 'shipped';
	if (t === 'delivered') return 'delivered';
	return null;
}

/** Read the persisted per-line-item array from an import row, tolerant of
 * pre-018 rows that have no parsed_items_json. */
function parseRowItems(row: ImportRow): ParsedAmazonItem[] {
	if (!row.parsed_items_json) return [];
	try {
		const arr = JSON.parse(row.parsed_items_json);
		if (!Array.isArray(arr)) return [];
		return arr.filter((x): x is ParsedAmazonItem =>
			x && typeof x === 'object' && typeof x.title === 'string'
		);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Per-run retry: re-evaluate failed rows by parsed_order_id.
// After a fresh scan staged a row as failed (typically "No recipient assigned"
// because the recipient name didn't auto-match), the admin may have manually
// created or edited a gift with the matching order_id. This action lets the
// admin re-run the order# lookup against just this run's failed rows; any hit
// is promoted disposition='pending' with match_person_id prefilled, ready for
// the normal accept flow.

export interface RetryResult {
	scanned: number;
	matched: number;
}

export function retryFailedByOrderId(runId: number, actorUserId: number): RetryResult {
	const db = getDb();
	const rows = db
		.prepare<[number], ImportRow>(
			`SELECT * FROM import_rows
			  WHERE import_run_id = ?
			    AND disposition = 'failed'
			    AND parsed_order_id IS NOT NULL
			    AND parsed_order_id != ''`
		)
		.all(runId);

	const updateRow = db.prepare(
		`UPDATE import_rows
		    SET disposition = 'pending',
		        match_person_id = ?,
		        match_confidence = 'exact',
		        error_message = NULL,
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	);

	let matched = 0;
	for (const row of rows) {
		const hit = findGiftPersonByOrderId(row.parsed_order_id);
		if (!hit) continue;
		updateRow.run(hit.personId, row.id);
		matched += 1;
	}

	if (matched > 0) {
		logAudit({
			actorUserId,
			entityType: 'import',
			entityId: runId,
			action: 'amazon_retry_order_id',
			summary: `Re-matched ${matched} of ${rows.length} failed rows to existing gifts via order #`
		});
	}

	return { scanned: rows.length, matched };
}

// ---------------------------------------------------------------------------
// td-3e9ae2: re-split a previously-collapsed Amazon order.
//
// Before the orders/gifts 1:N split, a multi-item Amazon order was imported
// as one gift keyed by gifts.order_id. The legacy import_row carries the
// original Gmail message id and may now have an empty parsed_items_json
// (parsed before the multi-item parser landed).
//
// `reImportOrderById` re-fetches the order_placed email, re-runs the new
// parser, refreshes parsed_items_json + parsed_price_cents on the existing
// import row, archives the collapsed gift, and flips disposition back to
// 'pending' so the admin can assign per-line recipients in the review UI.

export interface ReImportResult {
	orderId: string;
	rowId: number;
	itemCount: number;
	archivedGiftId: number | null;
	runId: number;
}

export async function reImportOrderById(
	orderId: string,
	userId: number
): Promise<ReImportResult> {
	const db = getDb();
	const row = db
		.prepare<[string], ImportRow>(
			`SELECT * FROM import_rows
			  WHERE parsed_order_id = ?
			    AND email_type = 'order_placed'
			  ORDER BY id DESC LIMIT 1`
		)
		.get(orderId);
	if (!row) {
		throw new Error(`No order_placed import row found for order ${orderId}.`);
	}

	// Re-fetch the original Gmail message body and re-parse.
	const msg = await getFullMessage(userId, row.source_message_id);
	const parsed = parseAmazonEmail(msg);
	const itemsJson = parsed.items.length > 0 ? JSON.stringify(parsed.items) : null;

	db.prepare(
		`UPDATE import_rows
		    SET parsed_items_json = ?,
		        parsed_title = ?,
		        parsed_price_cents = ?,
		        disposition = 'pending',
		        gift_id = NULL,
		        match_confidence = ?,
		        error_message = NULL,
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	).run(
		itemsJson,
		parsed.title,
		parsed.priceCents,
		row.match_confidence ?? null,
		row.id
	);

	// Archive the collapsed gift (if any) so the admin can re-create N gifts
	// from the review UI. Keep the audit_log breadcrumb so the original is
	// recoverable via /app/gifts/[id] restore if needed.
	let archivedGiftId: number | null = null;
	const collapsed = db
		.prepare<[string], Gift>(
			`SELECT * FROM gifts WHERE order_id = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1`
		)
		.get(orderId);
	if (collapsed) {
		db.prepare(
			'UPDATE gifts SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
		).run(collapsed.id);
		archivedGiftId = collapsed.id;
		logAudit({
			actorUserId: userId,
			entityType: 'gift',
			entityId: collapsed.id,
			action: 'archive',
			summary: `Archived collapsed multi-item gift "${collapsed.title}" for re-split (td-3e9ae2)`
		});
	}

	logAudit({
		actorUserId: userId,
		entityType: 'import',
		entityId: row.import_run_id,
		action: 'amazon_re_split',
		summary: `Re-split order ${orderId} into ${parsed.items.length} line item${parsed.items.length === 1 ? '' : 's'} for review`
	});

	return {
		orderId,
		rowId: row.id,
		itemCount: parsed.items.length,
		archivedGiftId,
		runId: row.import_run_id
	};
}

// ---------------------------------------------------------------------------
// Cleanup

export const CLEANUP_JOB = 'amazon.cleanup_processed';

export async function runProcessedCleanup(
	userId: number,
	opts?: { olderThanDays?: number }
): Promise<JobResult<{ trashed: number }>> {
	const days = opts?.olderThanDays ?? PROCESSED_RETENTION_DAYS;
	return runJob<{ trashed: number }>(
		CLEANUP_JOB,
		async () => {
			const trashed = await trashMessagesUnderLabel(userId, PROCESSED_LABEL, {
				olderThanDays: days
			});
			return { trashed };
		},
		{ summarize: (r) => `Trashed ${r.trashed} messages older than ${days}d from ${PROCESSED_LABEL}` }
	);
}

// ---------------------------------------------------------------------------
// Query helpers for admin UI.

export function listPendingRows(runId: number): ImportRow[] {
	const db = getDb();
	return db
		.prepare<[number], ImportRow>(
			`SELECT * FROM import_rows
			  WHERE import_run_id = ? AND disposition = 'pending'
			  ORDER BY lifecycle_order(email_type) DESC, received_at DESC`
		)
		.all(runId);
}

// SQLite doesn't have a native lifecycle_order fn; we fall back to a JOIN-free select
// and sort in application code for the review UI below. listPendingRows above is
// unused; the +page.server loader calls this simpler version instead.
export function listRowsForRun(runId: number, disposition?: ImportRow['disposition']): ImportRow[] {
	const db = getDb();
	if (disposition) {
		return db
			.prepare<[number, string], ImportRow>(
				`SELECT * FROM import_rows WHERE import_run_id = ? AND disposition = ? ORDER BY received_at DESC`
			)
			.all(runId, disposition);
	}
	return db
		.prepare<[number], ImportRow>(
			`SELECT * FROM import_rows WHERE import_run_id = ? ORDER BY received_at DESC`
		)
		.all(runId);
}

export function getRun(runId: number): ImportRun | undefined {
	const db = getDb();
	return db
		.prepare<[number], ImportRun>(`SELECT * FROM import_runs WHERE id = ?`)
		.get(runId);
}

export function getLatestRun(): ImportRun | undefined {
	const db = getDb();
	return db
		.prepare<[], ImportRun>(
			`SELECT * FROM import_runs WHERE source = 'amazon_email' ORDER BY started_at DESC LIMIT 1`
		)
		.get();
}

export interface RecentRunSummary extends ImportRun {
	pending_count: number;
	failed_count: number;
	accepted_count: number;
}

/**
 * Most-recent N runs with at-a-glance per-disposition counts.
 * Used by the imports landing page so admins can find a past review without
 * memorizing run ids.
 */
export function listRecentRuns(limit = 20): RecentRunSummary[] {
	const db = getDb();
	return db
		.prepare<[number], RecentRunSummary>(
			`SELECT r.*,
			        (SELECT COUNT(*) FROM import_rows WHERE import_run_id = r.id AND disposition = 'pending') AS pending_count,
			        (SELECT COUNT(*) FROM import_rows WHERE import_run_id = r.id AND disposition = 'failed') AS failed_count,
			        (SELECT COUNT(*) FROM import_rows WHERE import_run_id = r.id AND disposition = 'accepted') AS accepted_count
			   FROM import_runs r
			  WHERE r.source = 'amazon_email'
			  ORDER BY r.started_at DESC
			  LIMIT ?`
		)
		.all(limit);
}
