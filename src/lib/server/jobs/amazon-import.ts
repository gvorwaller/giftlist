import { getDb } from '../db';
import { runJob, type JobResult } from './runner';
import {
	getFullMessage,
	listLabelMessages,
	moveToLabel,
	trashMessagesUnderLabel
} from '../gmail-reader';
import { parseAmazonEmail } from '../amazon-parser';
import { matchRecipient, saveAlias } from '../name-matcher';
import { logAudit } from '../audit';
import { createGift, getGiftById, updateGift } from '../gifts';
import { transitionGift, canTransition } from './../gift-status';
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
				   parsed_shipping_address, parsed_gift_message, match_person_id,
				   match_confidence, match_candidates_json, disposition
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);

			let summaries;
			try {
				summaries = await listLabelMessages(userId, INBOX_LABEL, {
					maxResults: opts?.limit ?? 200
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

			for (const s of summaries) {
				if (existingIdStmt.get(s.id)) {
					existing += 1;
					continue;
				}
				let full;
				try {
					full = await getFullMessage(userId, s.id);
				} catch (err) {
					console.warn(`[amazon-import] failed to fetch ${s.id}:`, err);
					continue;
				}
				const parse = parseAmazonEmail(full);
				parsed += 1;

				const match = matchRecipient(parse.recipientName);
				const candidatesJson = JSON.stringify(match.candidates);

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
					match.personId,
					match.confidence,
					candidatesJson,
					defaultDisposition(parse.emailType)
				);
				newRows += 1;
			}

			bumpCounts(run.id, { parsed_count: parsed });
			setRunStatus(run.id, 'ready_for_review');

			logAudit({
				actorUserId: userId,
				entityType: 'import',
				entityId: run.id,
				action: 'amazon_scan',
				summary: `Scanned ${summaries.length} messages; staged ${newRows} new (${existing} already staged)`
			});

			return { runId: run.id, fetched: summaries.length, parsed, newRows, existingRows: existing };
		},
		{
			summarize: (r) =>
				`run ${r.runId} — fetched ${r.fetched}, ${r.newRows} new rows, ${r.existingRows} already staged`
		}
	);
}

function defaultDisposition(emailType: EmailType): ImportRowDisposition {
	// Marketing / review-request emails default to skipped so the review UI
	// doesn't drown the admin. Order-lifecycle emails stay pending for review.
	if (emailType === 'marketing' || emailType === 'review_request') return 'skipped';
	return 'pending';
}

// ---------------------------------------------------------------------------
// Commit path

export interface CommitRowInput {
	rowId: number;
	action: 'accept' | 'skip';
	assignedPersonId?: number;
	saveAsAlias?: boolean;
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

	// Accept pass.
	for (const [, group] of byOrder) {
		// Sort the group by email_type in lifecycle order so the gift is created
		// from the order_placed email (if present) before shipped/delivered pile
		// on their status transitions.
		const orderedGroup = group
			.map((d) => ({ d, row: rowStmt.get(d.rowId)! }))
			.filter((x) => x.row)
			.sort((a, b) => lifecycleOrder(a.row.email_type) - lifecycleOrder(b.row.email_type));

		let giftId: number | null = null;
		for (const { d, row } of orderedGroup) {
			const personId = d.assignedPersonId ?? row.match_person_id ?? null;
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
					row.match_confidence ?? 'none',
					null,
					row.id
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				updateRow.run('failed', giftId, personId, row.match_confidence, message, row.id);
				result.rowsFailed += 1;
				continue;
			}

			try {
				await moveToLabel(userId, row.source_message_id, INBOX_LABEL, PROCESSED_LABEL);
			} catch (err) {
				console.warn(`[amazon-import] label move failed for ${row.source_message_id}:`, err);
				result.labelMoveFailures += 1;
			}
		}
	}

	// Skip pass.
	for (const d of skipped) {
		const row = rowStmt.get(d.rowId);
		if (!row) continue;
		updateRow.run('skipped', row.gift_id, row.match_person_id, row.match_confidence, null, row.id);
		result.rowsSkipped += 1;
		try {
			await moveToLabel(userId, row.source_message_id, INBOX_LABEL, PROCESSED_LABEL);
		} catch (err) {
			console.warn(`[amazon-import] label move failed for skipped ${row.source_message_id}:`, err);
			result.labelMoveFailures += 1;
		}
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
		if (hit) return hit.id;
	}
	const gift = createGift(
		{
			person_id: personId,
			title: row.parsed_title ?? row.subject ?? '(imported)',
			source: 'Amazon',
			occasion_id: null,
			occasion_year: new Date().getFullYear(),
			order_id: row.parsed_order_id,
			tracking_number: row.parsed_tracking_number,
			carrier: row.parsed_carrier,
			price_cents: row.parsed_price_cents,
			notes: row.parsed_gift_message ?? null,
			status: 'ordered',
			is_idea: false
		},
		userId
	);
	return gift.id;
}

function applyLifecycleEvent(giftId: number, row: ImportRow, userId: number): void {
	const current = getGiftById(giftId);
	if (!current) return;

	// Merge newly-parsed fields that the first email may have missed.
	const patch: Parameters<typeof updateGift>[1] = {};
	if (row.parsed_tracking_number && !current.tracking_number) patch.tracking_number = row.parsed_tracking_number;
	if (row.parsed_carrier && !current.carrier) patch.carrier = row.parsed_carrier;
	if (row.parsed_price_cents && !current.price_cents) patch.price_cents = row.parsed_price_cents;
	if (row.parsed_order_id && !current.order_id) patch.order_id = row.parsed_order_id;
	if (Object.keys(patch).length > 0) {
		updateGift(giftId, patch, userId);
	}

	// Advance status according to email type if the forward transition is legal.
	const target = lifecycleStatus(row.email_type);
	if (target) {
		const now = getGiftById(giftId)!;
		if (canTransition(now.status, target)) {
			transitionGift(giftId, target, userId);
		}
	}
}

function lifecycleStatus(t: EmailType): GiftStatus | null {
	if (t === 'order_placed') return 'ordered';
	if (t === 'shipped') return 'shipped';
	if (t === 'delivered') return 'delivered';
	return null;
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
