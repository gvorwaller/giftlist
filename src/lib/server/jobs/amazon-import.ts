import { getDb } from '../db';
import { runJob, type JobResult } from './runner';
import {
	batchMoveToLabel,
	getFullMessage,
	listLabelMessages,
	trashMessagesUnderLabel
} from '../gmail-reader';
import { parseAmazonEmail } from '../amazon-parser';
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
				   parsed_items_json,
				   match_person_id, match_confidence, match_candidates_json, disposition
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			const FETCH_CONCURRENCY = 10;
			for (let offset = 0; offset < fresh.length; offset += FETCH_CONCURRENCY) {
				const batch = fresh.slice(offset, offset + FETCH_CONCURRENCY);
				const results = await Promise.allSettled(
					batch.map((s) => getFullMessage(userId, s.id))
				);
				for (let i = 0; i < batch.length; i++) {
					const s = batch[i];
					const res = results[i];
					if (res.status !== 'fulfilled') {
						console.warn(`[amazon-import] failed to fetch ${s.id}:`, res.reason);
						continue;
					}
					const parse = parseAmazonEmail(res.value);
					parsed += 1;

					const recipientMatch = matchRecipient(parse.recipientName);
					const match = recipientMatch.personId
						? recipientMatch
						: applyOrderIdFallback(recipientMatch, parse.orderId);
					const candidatesJson = JSON.stringify(match.candidates);
					const disposition = defaultDisposition(parse.emailType);

					// td-3e9ae2: persist the full per-line-item breakdown so the
					// review UI can render N recipient pickers without re-parsing.
					// Null when there are no items (marketing/review-request emails)
					// so legacy consumers fall back cleanly to parsed_title.
					const itemsJson = parse.items.length > 0 ? JSON.stringify(parse.items) : null;
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
						match.personId,
						match.confidence,
						candidatesJson,
						disposition
					);
					newRows += 1;

					if (disposition !== 'pending') idsToMove.push(s.id);
				}
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
	giftsCreated: number;
	rowsSkipped: number;
	rowsFailed: number;
	labelMoveFailures: number;
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
		rowsSkipped: 0,
		rowsFailed: 0,
		labelMoveFailures: 0
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
					result.giftsCreated += ids.length;
					// Use the first-item gift as the canonical id for the
					// import_rows.gift_id column (one column, N gifts — pick
					// the first stably). All N share the parent order_pk so
					// follow-up emails advance the entire group.
					giftId = ids[0] ?? null;
					applyLifecycleEvent(giftId!, row, userId);
					updateRow.run(
						'accepted',
						giftId,
						d.lineItems[0].assignedPersonId,
						row.match_confidence ?? 'none',
						null,
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
					giftId = resolveOrCreateGift(row, personId, userId);
					if (!row.gift_id) result.giftsCreated += 1;
				}
				applyLifecycleEvent(giftId, row, userId);
				updateRow.run(
					'accepted',
					giftId,
					personId,
					// Manual gift-link is an explicit human confirmation, so we record
					// it as 'exact' — the schema CHECK only allows the existing enum.
					linkedGift ? 'exact' : (row.match_confidence ?? 'none'),
					null,
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

function resolveOrCreateGift(row: ImportRow, personId: number, userId: number): number {
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
			return hit.id;
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
	return gift.id;
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
 * td-3e9ae2: multi-item accept. Creates ONE order row and N gifts (one per
 * line item) when the admin specified per-line-item recipients in the review
 * UI. Returns the list of created gift ids in line-item order.
 */
function commitMultiItemAccept(
	row: ImportRow,
	lineItems: NonNullable<CommitRowInput['lineItems']>,
	items: ParsedAmazonItem[],
	userId: number
): number[] {
	const orderPk = ensureOrderForRow(row, userId);
	if (!orderPk) {
		throw new Error(`Multi-item accept requires parsed_order_id, but row ${row.id} has none.`);
	}
	const amazonVendor = ensureVendor('Amazon', userId);
	const createdGiftIds: number[] = [];

	for (const li of lineItems) {
		// Allow holes: a lineItem with no items[lineItemIndex] uses fallbacks
		// from the row top-level (defensive — UI shouldn't send a bad index).
		const item = items[li.lineItemIndex];
		const title = item?.title ?? row.parsed_title ?? row.subject ?? '(imported)';
		const priceCents = item?.priceCents ?? null;

		// Per-user privacy guard (td-68804e parity).
		if (!isPersonVisibleToUser(li.assignedPersonId, userId)) {
			throw new Error(
				`Recipient not visible to you (archived or another user's self-person).`
			);
		}

		// Line-item-level link to an existing gift idea (weak-match acceptance).
		if (li.assignedGiftId) {
			const linked = getGiftById(li.assignedGiftId);
			if (linked) {
				updateGift(
					linked.id,
					{
						order_id: row.parsed_order_id,
						tracking_number: row.parsed_tracking_number ?? linked.tracking_number,
						carrier: row.parsed_carrier ?? linked.carrier,
						amazon_tracking_url:
							row.parsed_amazon_tracking_url ?? linked.amazon_tracking_url,
						price_cents: priceCents ?? linked.price_cents
					},
					userId
				);
				// Attach to the order + record line-item position. updateGift
				// doesn't expose order_pk; touch directly.
				getDb()
					.prepare('UPDATE gifts SET order_pk = ?, line_item_index = ? WHERE id = ?')
					.run(orderPk, li.lineItemIndex, linked.id);
				// Forward-transition from idea/planned to ordered.
				if (canTransition(linked.status, 'ordered')) {
					transitionGift(linked.id, 'ordered', userId);
				}
				createdGiftIds.push(linked.id);
				continue;
			}
		}

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
				line_item_index: li.lineItemIndex
			},
			userId
		);
		createdGiftIds.push(gift.id);
	}
	return createdGiftIds;
}

function applyLifecycleEvent(giftId: number, row: ImportRow, userId: number): void {
	// td-3e9ae2 / td-d08902: an order can fan out to N gifts (multi-recipient
	// case) and can ship in multiple batches. Lifecycle handling:
	//
	//   order_placed: refresh order facts; advance ALL siblings to 'ordered'
	//                 (no shipment yet, applies to whole order).
	//   shipped:      create/find an order_shipments row from the email's
	//                 tracking facts; advance ONLY the siblings whose titles
	//                 match items in this shipment's email body. If the
	//                 email doesn't enumerate items (single-item shipping
	//                 notification), advance all siblings as before.
	//   delivered:    same as shipped, but bumps delivered_at on shipment +
	//                 advances matched siblings to 'delivered'.
	const seed = getGiftById(giftId);
	if (!seed) return;
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

	// td-d08902: for shipment events on a known parent order, capture the
	// shipment row first, then narrow siblings to those actually in this box.
	let shipmentId: number | null = null;
	let advanceSiblings = siblings;
	if (isShipmentEvent && seed.order_pk) {
		const shipmentItems = parseRowItems(row);
		const shippedTitles = shipmentItems.map((it) => it.title).filter((t): t is string => !!t);
		const { matched, itemsHadTitles } = matchSiblingsToShipment(siblings, shippedTitles);
		if (itemsHadTitles && matched.length === 0) {
			// Items enumerated but none fuzzy-matched — fall back to advancing
			// all siblings rather than no-op'ing, but log so the parser/matcher
			// gap is visible. Real failure mode would be Amazon renaming items
			// in the shipping notification body.
			console.warn(
				`[amazon-import] shipment items present but no sibling match: order=${row.parsed_order_id ?? '∅'} items=${JSON.stringify(shippedTitles)} sibling_titles=${JSON.stringify(siblings.map((s) => s.title))}`
			);
			advanceSiblings = siblings;
		} else {
			advanceSiblings = matched;
		}

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
	}

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
			}
		}
	}
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
