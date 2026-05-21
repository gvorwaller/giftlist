import { getDb } from './db';
import { logAudit } from './audit';

/**
 * td-8360f4: admin-managed keyword list for filtering recurring non-gift
 * Amazon items out of the import pipeline. CRUD mirrors the vendors /
 * shippers lookup pattern (soft-delete via is_archived, restore on
 * un-archive). The pure matchers at the bottom are the only thing the
 * scan loop and review page consume — they take a pre-fetched keyword
 * list so callers query once, not per item.
 */

export type ExclusionMatchType = 'contains' | 'exact';

export interface ExclusionKeyword {
	id: number;
	keyword: string;
	match_type: ExclusionMatchType;
	notes: string | null;
	is_archived: 0 | 1;
	created_at: string;
	updated_at: string;
}

export interface ListExclusionKeywordsOptions {
	includeArchived?: boolean;
}

export function listExclusionKeywords(
	opts: ListExclusionKeywordsOptions = {}
): ExclusionKeyword[] {
	const db = getDb();
	const where = opts.includeArchived ? '' : 'WHERE is_archived = 0';
	return db
		.prepare<[], ExclusionKeyword>(
			`SELECT * FROM exclusion_keywords ${where} ORDER BY LOWER(keyword)`
		)
		.all();
}

/** Active (non-archived) keywords — the set both filters consume. */
export function getActiveExclusionKeywords(): ExclusionKeyword[] {
	const db = getDb();
	return db
		.prepare<[], ExclusionKeyword>(
			`SELECT * FROM exclusion_keywords WHERE is_archived = 0 ORDER BY LOWER(keyword)`
		)
		.all();
}

export function getExclusionKeywordById(id: number): ExclusionKeyword | undefined {
	const db = getDb();
	return db
		.prepare<[number], ExclusionKeyword>('SELECT * FROM exclusion_keywords WHERE id = ?')
		.get(id);
}

/** Find any keyword (archived or not) with the same canonical text + type. */
function findDuplicate(
	keyword: string,
	matchType: ExclusionMatchType
): ExclusionKeyword | undefined {
	const db = getDb();
	return db
		.prepare<[string, string], ExclusionKeyword>(
			`SELECT * FROM exclusion_keywords
			  WHERE LOWER(keyword) = LOWER(?) AND match_type = ?`
		)
		.get(keyword.trim(), matchType);
}

function normalizeMatchType(raw: string | null | undefined): ExclusionMatchType {
	return raw === 'exact' ? 'exact' : 'contains';
}

function cleanNotes(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const t = raw.trim();
	return t === '' ? null : t;
}

export function createExclusionKeyword(
	keyword: string,
	matchType: string | null | undefined,
	notes: string | null | undefined,
	actorUserId: number
): ExclusionKeyword {
	const trimmed = keyword.trim();
	if (!trimmed) throw new Error('Keyword is required');
	const type = normalizeMatchType(matchType);

	const existing = findDuplicate(trimmed, type);
	if (existing) {
		// Re-adding a previously-archived keyword just brings it back rather
		// than erroring — the admin's intent is clearly "exclude this again".
		if (existing.is_archived === 1) {
			return setExclusionKeywordArchived(existing.id, false, actorUserId);
		}
		throw new Error(`Keyword "${existing.keyword}" (${existing.match_type}) already exists`);
	}

	const db = getDb();
	const info = db
		.prepare('INSERT INTO exclusion_keywords (keyword, match_type, notes) VALUES (?, ?, ?)')
		.run(trimmed, type, cleanNotes(notes));
	const id = Number(info.lastInsertRowid);
	const created = getExclusionKeywordById(id)!;
	logAudit({
		actorUserId,
		entityType: 'exclusion_keyword',
		entityId: id,
		action: 'create',
		summary: `Added exclusion keyword "${created.keyword}" (${created.match_type})`
	});
	return created;
}

export interface ExclusionKeywordUpdate {
	keyword: string;
	matchType: string | null | undefined;
	notes: string | null | undefined;
}

export function updateExclusionKeyword(
	id: number,
	input: ExclusionKeywordUpdate,
	actorUserId: number
): ExclusionKeyword {
	const trimmed = input.keyword.trim();
	if (!trimmed) throw new Error('Keyword is required');
	const type = normalizeMatchType(input.matchType);
	const before = getExclusionKeywordById(id);
	if (!before) throw new Error(`Exclusion keyword ${id} not found`);

	const collision = findDuplicate(trimmed, type);
	if (collision && collision.id !== id) {
		throw new Error(
			`Another keyword "${collision.keyword}" (${collision.match_type}) already exists`
		);
	}

	const db = getDb();
	db.prepare(
		`UPDATE exclusion_keywords
		    SET keyword = ?, match_type = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	).run(trimmed, type, cleanNotes(input.notes), id);
	const after = getExclusionKeywordById(id)!;

	const changes: string[] = [];
	if (before.keyword !== after.keyword) changes.push(`keyword "${before.keyword}" → "${after.keyword}"`);
	if (before.match_type !== after.match_type) changes.push(`type ${before.match_type} → ${after.match_type}`);
	if (before.notes !== after.notes) changes.push('notes');
	if (changes.length > 0) {
		logAudit({
			actorUserId,
			entityType: 'exclusion_keyword',
			entityId: id,
			action: 'update',
			summary: `Updated exclusion keyword: ${changes.join(', ')}`
		});
	}
	return after;
}

export function setExclusionKeywordArchived(
	id: number,
	archived: boolean,
	actorUserId: number
): ExclusionKeyword {
	const before = getExclusionKeywordById(id);
	if (!before) throw new Error(`Exclusion keyword ${id} not found`);
	if (Boolean(before.is_archived) === archived) return before;

	const db = getDb();
	db.prepare(
		'UPDATE exclusion_keywords SET is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(archived ? 1 : 0, id);
	const after = getExclusionKeywordById(id)!;

	logAudit({
		actorUserId,
		entityType: 'exclusion_keyword',
		entityId: id,
		action: archived ? 'archive' : 'unarchive',
		summary: `${archived ? 'Archived' : 'Restored'} exclusion keyword "${after.keyword}"`
	});
	return after;
}

// ── Pure matchers (no DB) ──────────────────────────────────────────────

/** Lowercase, trim, collapse internal whitespace to a single space. */
export function normalizeForMatch(s: string): string {
	return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Returns the first keyword that matches `title`, or null. `contains` is a
 * normalized substring test; `exact` is normalized equality. A blank
 * keyword never matches (guards against an all-titles wildcard).
 */
export function matchExcluded(
	title: string | null | undefined,
	keywords: ExclusionKeyword[]
): ExclusionKeyword | null {
	if (!title) return null;
	const hay = normalizeForMatch(title);
	if (!hay) return null;
	for (const k of keywords) {
		const needle = normalizeForMatch(k.keyword);
		if (!needle) continue;
		if (k.match_type === 'exact') {
			if (hay === needle) return k;
		} else if (hay.includes(needle)) {
			return k;
		}
	}
	return null;
}
