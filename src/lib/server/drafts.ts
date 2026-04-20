import { getDb } from './db';
import type { Draft, DraftType } from './types';

export const DRAFT_STALE_DAYS = 7;
const DRAFT_STALE_MS = DRAFT_STALE_DAYS * 24 * 60 * 60 * 1000;

export function isStale(draft: Draft): boolean {
	const created = Date.parse(draft.created_at);
	if (!Number.isFinite(created)) return true;
	return Date.now() - created > DRAFT_STALE_MS;
}

export function getActiveDraft(userId: number, draftType: DraftType): Draft | undefined {
	const db = getDb();
	return db
		.prepare<[number, string], Draft>(
			'SELECT * FROM drafts WHERE user_id = ? AND draft_type = ?'
		)
		.get(userId, draftType);
}

/** Returns the draft only if it exists and is not stale (< DRAFT_STALE_DAYS old). */
export function getFreshDraft(userId: number, draftType: DraftType): Draft | undefined {
	const d = getActiveDraft(userId, draftType);
	if (!d) return undefined;
	return isStale(d) ? undefined : d;
}

export function upsertDraft(userId: number, draftType: DraftType, payload: unknown): Draft {
	const db = getDb();
	const json = JSON.stringify(payload);
	db.prepare(
		`INSERT INTO drafts (user_id, draft_type, payload_json)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id, draft_type) DO UPDATE SET
		   payload_json = excluded.payload_json,
		   updated_at = CURRENT_TIMESTAMP`
	).run(userId, draftType, json);
	return getActiveDraft(userId, draftType)!;
}

export function deleteDraft(userId: number, draftType: DraftType): void {
	const db = getDb();
	db.prepare('DELETE FROM drafts WHERE user_id = ? AND draft_type = ?').run(userId, draftType);
}

/** Decode a draft's JSON payload; returns null on parse failure. */
export function parseDraftPayload<T = unknown>(draft: Draft | undefined): T | null {
	if (!draft) return null;
	try {
		return JSON.parse(draft.payload_json) as T;
	} catch {
		return null;
	}
}
