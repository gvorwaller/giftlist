import { getDb } from '../db';
import { runJob, type JobResult } from './runner';
import {
	batchMoveToLabel,
	getFullMessage,
	listLabelMessages,
	trashMessagesUnderLabel
} from '../gmail-reader';
import { parseShipmentEmail } from '../shipment-parser';
import { logAudit } from '../audit';
import { createGift, getGiftById, updateGift } from '../gifts';
import { getOrCreateSelfPerson } from '../people';
import { getShipperByName } from '../shippers';
import { registerWithProvider } from '../tracking';
import type {
	Gift,
	ImportRow,
	ImportRowDisposition,
	ImportRun,
	ImportRunStatus
} from '../types';

export const INBOX_LABEL = 'Giftlist/Tracking/Inbox';
export const PROCESSED_LABEL = 'Giftlist/Tracking/Processed';
export const FAILED_LABEL = 'Giftlist/Tracking/Failed';
export const SCAN_JOB = 'tracking_email.scan';
export const CLEANUP_JOB = 'tracking_email.cleanup_processed';
export const PROCESSED_RETENTION_DAYS = 180;

export interface TrackingScanResult {
	runId: number;
	fetched: number;
	parsed: number;
	newRows: number;
	existingRows: number;
	autoMovedToProcessed: number;
	autoMovedToFailed: number;
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
	fields: Partial<{
		fetched_count: number;
		parsed_count: number;
		skipped_count: number;
		created_count: number;
	}>
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
			`INSERT INTO import_runs (source, actor_user_id, status) VALUES ('tracking_email', ?, 'running')`
		)
		.run(userId);
	return db
		.prepare<[number | bigint], ImportRun>('SELECT * FROM import_runs WHERE id = ?')
		.get(info.lastInsertRowid)!;
}

/**
 * Scans Giftlist/Tracking/Inbox, parses each shipment email, stages
 * import_rows. Idempotent via the source_message_id UNIQUE constraint.
 *
 * Disposition routing (P1 fix from Codex review):
 *   - parsed tracking# detected → disposition='pending', stays in Inbox label
 *   - parsed tracking# null     → disposition='failed', moved to FAILED_LABEL
 *
 * Disposition-aware stragglers: re-runs of the scan re-evaluate already-staged
 * messages still tagged INBOX_LABEL and route them by current disposition
 * (failed → FAILED, skipped/accepted → PROCESSED). Pending stragglers stay
 * in Inbox awaiting admin review.
 */
export async function runTrackingImportScan(
	userId: number,
	opts?: { limit?: number }
): Promise<JobResult<TrackingScanResult>> {
	return runJob<TrackingScanResult>(
		SCAN_JOB,
		async () => {
			const run = createRun(userId);
			const db = getDb();
			const existingRowStmt = db.prepare<[string], { id: number; disposition: string }>(
				'SELECT id, disposition FROM import_rows WHERE source_message_id = ?'
			);
			const insertRowStmt = db.prepare(
				`INSERT INTO import_rows (
				   import_run_id, source_message_id, source_thread_id, subject, received_at,
				   from_address, email_type, parsed_title, parsed_order_id,
				   parsed_tracking_number, parsed_carrier, parsed_sender_domain,
				   disposition, error_message
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);

			let summaries;
			try {
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

			// Disposition-aware straggler routing — replaces amazon-import.ts:194-204
			// which moves all stragglers to PROCESSED. With a separate Failed label,
			// previously-failed stragglers must route there instead.
			const idsToProcessed: string[] = [];
			const idsToFailed: string[] = [];

			const fresh: typeof summaries = [];
			for (const s of summaries) {
				const existing = existingRowStmt.get(s.id);
				if (!existing) {
					fresh.push(s);
					continue;
				}
				// Already staged. Route by current disposition.
				if (existing.disposition === 'failed') idsToFailed.push(s.id);
				else if (existing.disposition !== 'pending') idsToProcessed.push(s.id);
				// pending stays put; awaits review.
			}
			const existingCount = summaries.length - fresh.length;

			// Bounded parallelism for getFullMessage. Same concurrency budget as
			// amazon-import.ts:143 — 10 parallel fetches at 5 quota units each
			// stays well below Gmail's 250 units/sec/user throttle.
			const FETCH_CONCURRENCY = 10;
			let fetchFailures = 0;
			let authFailureSeen = false;
			for (let offset = 0; offset < fresh.length; offset += FETCH_CONCURRENCY) {
				const batch = fresh.slice(offset, offset + FETCH_CONCURRENCY);
				const results = await Promise.allSettled(
					batch.map((s) => getFullMessage(userId, s.id))
				);
				for (let i = 0; i < batch.length; i++) {
					const s = batch[i];
					const res = results[i];
					if (res.status !== 'fulfilled') {
						console.warn(`[tracking-import] failed to fetch ${s.id}:`, res.reason);
						fetchFailures += 1;
						const reasonText = String(
							(res.reason as { message?: string } | null)?.message ?? res.reason ?? ''
						);
						// 401/403 typically means the OAuth token expired or was
						// revoked. Don't pretend success — fail the run so the
						// admin sees the auth issue and reconnects.
						if (
							/\b40[13]\b/.test(reasonText) ||
							/invalid_grant|insufficient.scope|unauthorized/i.test(reasonText)
						) {
							authFailureSeen = true;
						}
						continue;
					}
					const parse = parseShipmentEmail(res.value);
					parsed += 1;

					// P0 fix (Codex review): Amazon Logistics TBA emails should
					// route through the existing Giftlist/Amazon/* flow. If one
					// landed here (e.g. mis-tagged Gmail filter), quarantine it
					// rather than register with Shippo using a fallback slug.
					// Shippo has no documented 'amazon' carrier; without a seeded
					// shipper row registerWithProvider would default to 'usps'.
					const isAmazonLogistics = parse.carrier === 'Amazon';

					let disposition: ImportRowDisposition;
					let errorMessage: string | null;
					if (parse.emailType === 'order_confirmation') {
						// td-c28c5e: merchant order email with strict "Order #…"
						// marker. No tracking# yet — admin accepts to create a
						// status='ordered' self-package; the eventual carrier email
						// upgrades it via order_id match.
						disposition = 'pending';
						errorMessage = null;
					} else if (!parse.trackingNumber) {
						disposition = 'failed';
						errorMessage = 'no tracking number detected';
					} else if (isAmazonLogistics) {
						disposition = 'failed';
						errorMessage =
							'Amazon Logistics — re-tag in Gmail to Giftlist/Amazon/Inbox; not supported here.';
					} else if (parse.confidence === 'low') {
						// P1 fix (Codex): persist the parser's confidence signal so
						// admin sees why a row needs extra scrutiny. Currently the
						// only "low" path is multi-tracking emails — treat as soft
						// warning, leave pending for review.
						disposition = 'pending';
						errorMessage =
							'Low confidence: multiple tracking numbers detected; verify before accepting.';
					} else {
						disposition = 'pending';
						errorMessage = null;
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
						parse.trackingNumber,
						parse.carrier,
						parse.senderDomain,
						disposition,
						errorMessage
					);
					newRows += 1;

					if (disposition === 'failed') idsToFailed.push(s.id);
				}
			}

			let autoMovedToProcessed = 0;
			let autoMovedToFailed = 0;
			if (idsToProcessed.length > 0) {
				try {
					await batchMoveToLabel(userId, idsToProcessed, INBOX_LABEL, PROCESSED_LABEL);
					autoMovedToProcessed = idsToProcessed.length;
				} catch (err) {
					console.warn('[tracking-import] processed label move failed:', err);
				}
			}
			if (idsToFailed.length > 0) {
				try {
					await batchMoveToLabel(userId, idsToFailed, INBOX_LABEL, FAILED_LABEL);
					autoMovedToFailed = idsToFailed.length;
				} catch (err) {
					console.warn('[tracking-import] failed label move failed:', err);
				}
			}

			bumpCounts(run.id, { parsed_count: parsed });

			// P1 fix (Codex review): don't mask systemic Gmail failures behind
			// 'ready_for_review'. Auth-shaped failures or majority-failed
			// fetches mean the inbox wasn't actually drained — flip the run
			// to error so admin sees the breakage instead of a silently
			// partial scan.
			const fetchFailureRate = fresh.length > 0 ? fetchFailures / fresh.length : 0;
			const systemicFailure = authFailureSeen || (fresh.length >= 5 && fetchFailureRate >= 0.5);
			if (systemicFailure) {
				const reason = authFailureSeen
					? 'Gmail auth failed mid-scan (token expired or scope revoked) — reconnect Google in Settings.'
					: `Gmail returned errors for ${fetchFailures}/${fresh.length} messages — inbox not fully drained.`;
				setRunStatus(run.id, 'error', reason);
			} else {
				setRunStatus(run.id, 'ready_for_review');
			}

			logAudit({
				actorUserId: userId,
				entityType: 'import',
				entityId: run.id,
				action: 'tracking_scan',
				summary: `Tracking scan: ${summaries.length} messages, ${newRows} new (${existingCount} already staged); moved ${autoMovedToProcessed} to processed, ${autoMovedToFailed} to failed${fetchFailures > 0 ? `, ${fetchFailures} fetch failures` : ''}`
			});

			return {
				runId: run.id,
				fetched: summaries.length,
				parsed,
				newRows,
				existingRows: existingCount,
				autoMovedToProcessed,
				autoMovedToFailed
			};
		},
		{
			summarize: (r) =>
				`run ${r.runId} — fetched ${r.fetched}, ${r.newRows} new, ${r.existingRows} already staged${r.autoMovedToProcessed > 0 ? `, ${r.autoMovedToProcessed} → processed` : ''}${r.autoMovedToFailed > 0 ? `, ${r.autoMovedToFailed} → failed` : ''}`
		}
	);
}

// ---------------------------------------------------------------------------
// Commit path
// (Concurrency guard for Shippo registration now lives inside
// registerWithProvider in tracking.ts so all callers — refresh, new-gift,
// edit-gift, this importer — share the same in-flight dedupe map.)

export interface CommitTrackingRowInput {
	rowId: number;
	action: 'accept' | 'skip';
}

export interface CommitTrackingResult {
	giftsCreated: number;
	giftsLinked: number;
	rowsSkipped: number;
	rowsFailed: number;
	labelMoveFailures: number;
}

/**
 * Applies admin review decisions for tracking_email rows.
 *   - accept: matches existing gift by tracking# (no-op), then by order_id +
 *     sender/vendor agreement (patch + register), else creates a new self-
 *     package owned by the actor and registers with Shippo.
 *   - skip: marks disposition='skipped', moves email to PROCESSED_LABEL.
 *
 * Sequential processing (P1 fix from Codex review): two rows in the same
 * commit batch sharing a tracking# would both pass the existence check if
 * processed in parallel. We process one at a time and re-query inside the
 * loop to handle within-batch dedupe.
 */
export async function commitTrackingReviewedRows(
	userId: number,
	decisions: CommitTrackingRowInput[]
): Promise<CommitTrackingResult> {
	const db = getDb();
	const result: CommitTrackingResult = {
		giftsCreated: 0,
		giftsLinked: 0,
		rowsSkipped: 0,
		rowsFailed: 0,
		labelMoveFailures: 0
	};

	// P0 fix (Codex review): JOIN to import_runs and require tracking_email
	// source so a crafted POST cannot run Amazon import rows through the
	// self-package path. Drops any cross-source row IDs silently — the
	// review UI never surfaces them, so this is purely a defense-in-depth
	// check against forged form submissions.
	const rowStmt = db.prepare<[number], ImportRow>(
		`SELECT ir.* FROM import_rows ir
		   JOIN import_runs r ON r.id = ir.import_run_id
		  WHERE ir.id = ? AND r.source = 'tracking_email'`
	);
	const updateRow = db.prepare(
		`UPDATE import_rows
		    SET disposition = ?, gift_id = ?, error_message = ?,
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	);

	const messagesToMove: string[] = [];

	for (const d of decisions) {
		const row = rowStmt.get(d.rowId);
		if (!row) continue;

		if (d.action === 'skip') {
			updateRow.run('skipped', row.gift_id, null, row.id);
			result.rowsSkipped += 1;
			messagesToMove.push(row.source_message_id);
			continue;
		}

		// Accept path. Dispatch by email_type: order_confirmation rows take a
		// no-Shippo path that creates a status='ordered' self-package; everything
		// else requires a parsed tracking# to proceed.
		const isOrderConfirmation =
			row.email_type === 'order_confirmation' && !!row.parsed_order_id;

		if (!isOrderConfirmation && !row.parsed_tracking_number) {
			updateRow.run(
				'failed',
				row.gift_id,
				'Cannot accept a row with no tracking number; quarantined to Failed.',
				row.id
			);
			result.rowsFailed += 1;
			continue;
		}

		// P0 fix (Codex review): defense-in-depth against Amazon Logistics rows
		// that pre-date the scan-time quarantine. Without this, an old TBA row
		// re-accepted via the Reassign UI would attempt Shippo registration
		// with a missing/invalid carrier slug.
		if (row.parsed_carrier === 'Amazon') {
			updateRow.run(
				'failed',
				row.gift_id,
				'Amazon Logistics not supported via tracking importer; re-tag email to Giftlist/Amazon/Inbox.',
				row.id
			);
			result.rowsFailed += 1;
			continue;
		}

		try {
			const outcome = isOrderConfirmation
				? await acceptOrderConfirmationRow(row, userId)
				: await acceptTrackingRow(row, userId);
			updateRow.run('accepted', outcome.giftId, outcome.error, row.id);
			if (outcome.error) {
				// Outcome surfaced a soft failure (e.g., tracking-number mismatch
				// on existing gift). Still mark accepted so the row leaves the
				// pending queue, but include the message for the admin.
				result.rowsFailed += 1;
			} else if (outcome.created) {
				result.giftsCreated += 1;
			} else {
				result.giftsLinked += 1;
			}
			messagesToMove.push(row.source_message_id);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			updateRow.run('failed', row.gift_id, message, row.id);
			result.rowsFailed += 1;
			// Don't move on hard error — leave email in Inbox so a future scan
			// re-surfaces it after the underlying issue is fixed.
		}
	}

	if (messagesToMove.length > 0) {
		try {
			await batchMoveToLabel(userId, messagesToMove, INBOX_LABEL, PROCESSED_LABEL);
		} catch (err) {
			console.warn('[tracking-import] batch label move failed:', err);
			result.labelMoveFailures = messagesToMove.length;
		}
	}

	logAudit({
		actorUserId: userId,
		entityType: 'import',
		entityId: 0, // batch operation, not tied to a single run
		action: 'tracking_commit',
		summary: `Tracking commit: ${result.giftsCreated} created, ${result.giftsLinked} linked, ${result.rowsSkipped} skipped, ${result.rowsFailed} failed`
	});

	return result;
}

interface AcceptOutcome {
	giftId: number;
	created: boolean;
	error: string | null;
}

async function acceptTrackingRow(row: ImportRow, userId: number): Promise<AcceptOutcome> {
	const db = getDb();
	const trackingNumber = row.parsed_tracking_number!.trim();

	// 1. Tracking-number match — exact, unique. Cross-import dedupe.
	const byTracking = db
		.prepare<[string], Gift>(
			`SELECT * FROM gifts
			  WHERE tracking_number = ? AND is_archived = 0
			  ORDER BY id ASC LIMIT 1`
		)
		.get(trackingNumber);
	if (byTracking) {
		return { giftId: byTracking.id, created: false, error: null };
	}

	// 2. Order-id match constrained by sender-domain / vendor agreement.
	//    Plain order_id match is too loose (merchants reuse short numeric
	//    order numbers across customers).
	//
	//    td-3d1ee6 added the self-package fallback (clause (c)). The order-
	//    confirmation accept path historically created self-packages with
	//    vendor_id=NULL AND source_url=NULL, so neither (a) nor (b) could
	//    fire and a later shipment email would orphan a duplicate. A
	//    self-package owned by the same actor on the same order_id is a
	//    safe match: the cross-customer collision the constraint was
	//    designed to prevent can't happen within one actor's own packages.
	if (row.parsed_order_id && row.parsed_sender_domain) {
		const sender = row.parsed_sender_domain;
		const byOrder = db
			.prepare<[string, string, string, number], Gift>(
				`SELECT g.*
				   FROM gifts g
				   LEFT JOIN vendors v ON v.id = g.vendor_id
				   LEFT JOIN people  p ON p.id = g.person_id
				  WHERE g.order_id = ? AND g.is_archived = 0
				    AND (
				      LOWER(v.name) = ?
				      OR INSTR(LOWER(COALESCE(g.source_url, '')), ?) > 0
				      OR (p.is_self = 1 AND p.owner_user_id = ?)
				    )
				  ORDER BY g.id DESC LIMIT 1`
			)
			.get(
				row.parsed_order_id,
				normalizeSenderForVendorMatch(sender),
				sender.toLowerCase(),
				userId
			);

		if (byOrder) {
			// Found a gift whose order_id + sender agree. Patch null fields and
			// register tracking. Refuse if existing gift already has a different,
			// registered tracking# — surface as soft failure for admin reconcile.
			if (
				byOrder.tracking_provider_id &&
				byOrder.tracking_number &&
				byOrder.tracking_number.trim() !== trackingNumber
			) {
				return {
					giftId: byOrder.id,
					created: false,
					error: `Existing gift #${byOrder.id} has a different registered tracking number (${byOrder.tracking_number}); reconcile manually.`
				};
			}

			const patch: Parameters<typeof updateGift>[1] = {};
			if (!byOrder.tracking_number) patch.tracking_number = trackingNumber;
			if (!byOrder.carrier && row.parsed_carrier) patch.carrier = row.parsed_carrier;
			if (!byOrder.shipper_id && row.parsed_carrier) {
				const shipper = getShipperByName(row.parsed_carrier);
				if (shipper) patch.shipper_id = shipper.id;
			}
			if (Object.keys(patch).length > 0) {
				updateGift(byOrder.id, patch, userId);
			}
			await registerWithProvider(byOrder.id, userId);
			return { giftId: byOrder.id, created: false, error: null };
		}
	}

	// 3. Create a new self-package owned by the actor.
	//
	// td-3d1ee6: log the unmatched-tracking event so orphan creations are
	// auditable in pm2 logs. If this fires when we believed an existing
	// gift should have matched, the order_id + sender shape + the actor's
	// self-package presence are enough to retrace the miss.
	console.warn(
		`[tracking-import] orphan self-package: no match on order_id=${row.parsed_order_id ?? '∅'} sender=${row.parsed_sender_domain ?? '∅'} tracking=${trackingNumber} — creating new self-package.`
	);
	const selfPerson = getOrCreateSelfPerson(userId); // throws if missing
	const shipper = row.parsed_carrier ? getShipperByName(row.parsed_carrier) : null;
	const title = row.subject?.trim() || row.parsed_sender_domain || '(imported package)';

	const gift = createGift(
		{
			person_id: selfPerson.id,
			title,
			vendor_id: null, // unknown for non-Amazon merchants; admin can link later
			occasion_id: null,
			occasion_year: new Date().getFullYear(),
			order_id: row.parsed_order_id,
			tracking_number: trackingNumber,
			carrier: row.parsed_carrier,
			// td-3d1ee6: stash the sender domain as source_url so a future
			// (re-)matched email can find this gift via the INSTR clause of
			// the order-id match query. Cheap to populate, no downside.
			source_url: row.parsed_sender_domain ? `https://${row.parsed_sender_domain}/` : null,
			shipper_id: shipper?.id ?? null,
			price_cents: null,
			status: 'ordered',
			is_idea: false
		},
		userId
	);

	await registerWithProvider(gift.id, userId);
	return { giftId: gift.id, created: true, error: null };
}

/**
 * td-c28c5e: accept path for merchant order-confirmation emails.
 * No tracking# yet, so no Shippo registration. If an existing gift already
 * has this order_id (and either no sender constraint applies or sender
 * agrees), link to it instead of creating a duplicate. Otherwise create a
 * self-package in status='ordered' that the eventual carrier shipment email
 * will upgrade via the existing order_id-match path in acceptTrackingRow.
 */
async function acceptOrderConfirmationRow(row: ImportRow, userId: number): Promise<AcceptOutcome> {
	const db = getDb();
	const orderId = row.parsed_order_id!.trim();

	// Look for an existing gift on this order_id. Use sender/vendor agreement
	// when we have a sender domain (matches acceptTrackingRow's pattern).
	// Without a sender domain, fall back to plain order_id match — the strict
	// regex already filtered out most accidents and admin reviews each row.
	let existing: Gift | undefined;
	if (row.parsed_sender_domain) {
		const sender = row.parsed_sender_domain;
		existing = db
			.prepare<[string, string, string], Gift>(
				`SELECT g.*
				   FROM gifts g
				   LEFT JOIN vendors v ON v.id = g.vendor_id
				  WHERE g.order_id = ? AND g.is_archived = 0
				    AND (
				      LOWER(v.name) = ?
				      OR INSTR(LOWER(COALESCE(g.source_url, '')), ?) > 0
				    )
				  ORDER BY g.id DESC LIMIT 1`
			)
			.get(orderId, normalizeSenderForVendorMatch(sender), sender.toLowerCase());
	}
	if (!existing) {
		existing = db
			.prepare<[string], Gift>(
				`SELECT * FROM gifts
				  WHERE order_id = ? AND is_archived = 0
				  ORDER BY id DESC LIMIT 1`
			)
			.get(orderId);
	}

	if (existing) {
		// Already have a gift on this order#. No fields to patch (we have no
		// tracking# / carrier / shipper to contribute), so just link.
		return { giftId: existing.id, created: false, error: null };
	}

	// Create a status='ordered' self-package. No Shippo call — there's nothing
	// to register yet. Title prefers the email subject; falls back to merchant
	// or sender domain if subject is missing.
	//
	// td-3d1ee6: stash sender_domain in source_url so the eventual shipment
	// email's order-id match query (acceptTrackingRow clause b — INSTR on
	// source_url) finds this gift and upgrades it, instead of creating a
	// duplicate self-package. Clause c (self-package owned by actor) covers
	// the legacy backfill case where source_url is already null.
	const selfPerson = getOrCreateSelfPerson(userId);
	const title =
		row.subject?.trim() || row.parsed_sender_domain || '(imported order)';
	const gift = createGift(
		{
			person_id: selfPerson.id,
			title,
			vendor_id: null,
			occasion_id: null,
			occasion_year: new Date().getFullYear(),
			order_id: orderId,
			tracking_number: null,
			carrier: null,
			source_url: row.parsed_sender_domain ? `https://${row.parsed_sender_domain}/` : null,
			shipper_id: null,
			price_cents: null,
			status: 'ordered',
			is_idea: false
		},
		userId
	);
	return { giftId: gift.id, created: true, error: null };
}

/**
 * Multi-part public suffixes we recognize. Without this, "mybrand.co.uk"
 * would normalize to "co" and false-positive against any vendor literally
 * named "Co". Not exhaustive — public suffix list has ~10K entries — but
 * covers the common ccTLDs admin is likely to encounter. P1 fix from Codex
 * review.
 */
const MULTI_PART_TLDS = new Set([
	'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
	'com.au', 'net.au', 'org.au',
	'co.nz', 'co.jp', 'co.kr', 'co.in', 'co.za',
	'com.br', 'com.mx', 'com.cn', 'com.tw', 'com.hk', 'com.sg'
]);

/**
 * Reduce a sender domain (e.g. "shop.bestbuy.com") to a vendor-name candidate
 * ("bestbuy"). Handles ccTLDs like "mybrand.co.uk" → "mybrand". Loose by
 * design — used as one half of a two-part match (the other being a substring
 * check on source_url), so false positives still require the order_id to
 * agree.
 */
export function normalizeSenderForVendorMatch(domain: string): string {
	const lower = domain.toLowerCase();
	const parts = lower.split('.').filter(Boolean);
	if (parts.length === 0) return lower;
	if (parts.length === 1) return parts[0];
	// If the last two labels form a known multi-part TLD, take the third-to-last.
	if (parts.length >= 3) {
		const lastTwo = parts.slice(-2).join('.');
		if (MULTI_PART_TLDS.has(lastTwo)) {
			return parts[parts.length - 3];
		}
	}
	return parts[parts.length - 2];
}

// ---------------------------------------------------------------------------
// Cleanup

export async function runTrackingProcessedCleanup(
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
		{
			summarize: (r) =>
				`Trashed ${r.trashed} messages older than ${days}d from ${PROCESSED_LABEL}`
		}
	);
}

// ---------------------------------------------------------------------------
// Query helpers for the admin UI.

export function getLatestTrackingRun(): ImportRun | undefined {
	const db = getDb();
	return db
		.prepare<[], ImportRun>(
			`SELECT * FROM import_runs WHERE source = 'tracking_email' ORDER BY started_at DESC LIMIT 1`
		)
		.get();
}

export interface TrackingRunSummary extends ImportRun {
	pending_count: number;
	failed_count: number;
	accepted_count: number;
}

export function listRecentTrackingRuns(limit = 20): TrackingRunSummary[] {
	const db = getDb();
	return db
		.prepare<[number], TrackingRunSummary>(
			`SELECT r.*,
			        (SELECT COUNT(*) FROM import_rows WHERE import_run_id = r.id AND disposition = 'pending') AS pending_count,
			        (SELECT COUNT(*) FROM import_rows WHERE import_run_id = r.id AND disposition = 'failed') AS failed_count,
			        (SELECT COUNT(*) FROM import_rows WHERE import_run_id = r.id AND disposition = 'accepted') AS accepted_count
			   FROM import_runs r
			  WHERE r.source = 'tracking_email'
			  ORDER BY r.started_at DESC
			  LIMIT ?`
		)
		.all(limit);
}

// getRun and listRowsForRun are source-agnostic and reusable from amazon-import.ts.
// Re-export them here so the tracking review page can import from one module.
export { getRun, listRowsForRun } from './amazon-import';
