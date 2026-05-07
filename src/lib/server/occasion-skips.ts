import { getDb } from './db';
import { logAudit } from './audit';

export interface OccasionSkip {
	person_occasion_id: number;
	occasion_year: number;
	actor_user_id: number;
	skipped_at: string;
	reason: string | null;
}

/**
 * Mark a single iteration of a recurring occasion as skipped (td-927a2d).
 * Idempotent — re-skipping the same (person_occasion_id, year) is a no-op
 * and returns the existing row. Reversed by `unskipOccasion`.
 */
export function skipOccasion(
	personOccasionId: number,
	occasionYear: number,
	actorUserId: number,
	reason: string | null = null
): OccasionSkip {
	const db = getDb();
	db.prepare(
		`INSERT INTO occasion_skips (person_occasion_id, occasion_year, actor_user_id, reason)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (person_occasion_id, occasion_year) DO NOTHING`
	).run(personOccasionId, occasionYear, actorUserId, reason);

	const row = db
		.prepare<[number, number], OccasionSkip>(
			'SELECT * FROM occasion_skips WHERE person_occasion_id = ? AND occasion_year = ?'
		)
		.get(personOccasionId, occasionYear)!;

	logAudit({
		actorUserId,
		entityType: 'person_occasion',
		entityId: personOccasionId,
		action: 'skip',
		summary: `Skipped person_occasion ${personOccasionId} for ${occasionYear}${reason ? ` (${reason})` : ''}`
	});

	return row;
}

/**
 * Reverse a skip. No-op if there's no skip row for that (po, year).
 * Returns true if a row was actually removed.
 */
export function unskipOccasion(
	personOccasionId: number,
	occasionYear: number,
	actorUserId: number
): boolean {
	const db = getDb();
	const info = db
		.prepare(
			'DELETE FROM occasion_skips WHERE person_occasion_id = ? AND occasion_year = ?'
		)
		.run(personOccasionId, occasionYear);

	if (info.changes > 0) {
		logAudit({
			actorUserId,
			entityType: 'person_occasion',
			entityId: personOccasionId,
			action: 'unskip',
			summary: `Unskipped person_occasion ${personOccasionId} for ${occasionYear}`
		});
	}
	return info.changes > 0;
}

/**
 * Returns the set of (person_occasion_id, occasion_year) keys that are
 * currently skipped. Used by today.ts and reminders.ts to filter the
 * upcoming-occasions list. Single query, single Set membership check.
 */
export function loadSkipSet(): Set<string> {
	const db = getDb();
	const rows = db
		.prepare<[], { person_occasion_id: number; occasion_year: number }>(
			'SELECT person_occasion_id, occasion_year FROM occasion_skips'
		)
		.all();
	return new Set(rows.map((r) => `${r.person_occasion_id}:${r.occasion_year}`));
}

export function skipKey(personOccasionId: number, occasionYear: number): string {
	return `${personOccasionId}:${occasionYear}`;
}

/**
 * List active skips with person/occasion context for the "Skipped this year"
 * footer on Today. Filters self-people via the same is_self+owner_user_id
 * model used elsewhere — manager never sees admin's self-row skips.
 */
export interface SkipWithContext {
	person_occasion_id: number;
	occasion_year: number;
	person_id: number;
	person_display_name: string;
	occasion_id: number;
	occasion_title: string;
	skipped_at: string;
	reason: string | null;
}

export function listSkipsWithContext(viewerUserId: number, year?: number): SkipWithContext[] {
	const db = getDb();
	const yearFilter = year !== undefined ? 'AND s.occasion_year = ?' : '';
	const params: (number | string)[] = [viewerUserId];
	if (year !== undefined) params.push(year);
	return db
		.prepare<typeof params, SkipWithContext>(
			`SELECT s.person_occasion_id, s.occasion_year,
			        p.id AS person_id, p.display_name AS person_display_name,
			        o.id AS occasion_id, o.title AS occasion_title,
			        s.skipped_at, s.reason
			   FROM occasion_skips s
			   JOIN person_occasions po ON po.id = s.person_occasion_id
			   JOIN people p ON p.id = po.person_id
			   JOIN occasions o ON o.id = po.occasion_id
			  WHERE p.is_archived = 0
			    AND (p.is_self = 0 OR p.owner_user_id = ?)
			    ${yearFilter}
			  ORDER BY s.occasion_year DESC, s.skipped_at DESC`
		)
		.all(...params);
}
