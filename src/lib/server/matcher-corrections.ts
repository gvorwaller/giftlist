import { getDb } from './db';
import type { MatcherCorrection } from './llm-matcher';

/**
 * Wave 2 Phase 5 (td-4bfb59) — persistence for the admin's matcher
 * corrections, fed back into the Opus prompt as few-shot examples. Appended
 * from the commit path whenever the admin's chosen gift disagrees with the
 * LLM's pick (see applyOverrideFeedback in jobs/amazon-import.ts).
 */

export type CorrectionAction = 'override' | 'fill-in';

export interface AppendCorrectionInput {
	sourceEmailTitle: string | null;
	sourceEmailSubject: string | null;
	chosenGiftId: number;
	chosenGiftTitle: string;
	chosenPersonId: number;
	chosenPersonName: string;
	action: CorrectionAction;
}

export function appendCorrection(input: AppendCorrectionInput): void {
	try {
		// Upsert on the natural key (source title + gift + person + action) so an
		// order's order_placed/shipped/delivered rows don't append the same
		// correction 2-3x; a repeat just refreshes recency (Codex P2).
		getDb()
			.prepare(
				`INSERT INTO matcher_corrections
				   (source_email_title, source_email_subject, chosen_gift_id,
				    chosen_gift_title, chosen_person_id, chosen_person_name, action)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (source_email_title, chosen_gift_id, chosen_person_id, action)
				 DO UPDATE SET
				   source_email_subject = excluded.source_email_subject,
				   chosen_gift_title = excluded.chosen_gift_title,
				   chosen_person_name = excluded.chosen_person_name,
				   created_at = CURRENT_TIMESTAMP`
			)
			.run(
				input.sourceEmailTitle,
				input.sourceEmailSubject,
				input.chosenGiftId,
				input.chosenGiftTitle,
				input.chosenPersonId,
				input.chosenPersonName,
				input.action
			);
	} catch (err) {
		// Non-fatal: a learning-log write must never break a commit.
		console.warn('[matcher-corrections] append failed (non-fatal):', err);
	}
}

/**
 * Most-recent corrections, newest first, mapped into the prompt's
 * MatcherCorrection shape. Default 5 keeps the few-shot block small
 * (~under the 800-token budget).
 */
export function listRecentCorrections(limit = 5): MatcherCorrection[] {
	const rows = getDb()
		.prepare<[number], { source_email_title: string | null; chosen_gift_title: string; chosen_person_name: string }>(
			`SELECT source_email_title, chosen_gift_title, chosen_person_name
			   FROM matcher_corrections
			  ORDER BY created_at DESC, id DESC
			  LIMIT ?`
		)
		.all(Math.max(1, limit));
	return rows.map((r) => ({
		emailTitle: r.source_email_title ?? '',
		giftTitle: r.chosen_gift_title,
		personDisplayName: r.chosen_person_name
	}));
}
