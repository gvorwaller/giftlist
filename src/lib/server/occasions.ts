import { getDb } from './db';
import type { Occasion, OccasionKind, OccasionRecurrence, PersonOccasion } from './types';
import { logAudit } from './audit';

export interface OccasionWithLink extends Occasion {
	personOccasionId: number;
	is_active: 0 | 1;
	link_notes: string | null;
}

export interface CreateOccasionInput {
	title: string;
	kind: OccasionKind;
	recurrence: OccasionRecurrence;
	month?: number | null;
	day?: number | null;
	date?: string | null;
	reminder_days?: number;
	year?: number | null;
}

export function listOccasions(): Occasion[] {
	const db = getDb();
	return db.prepare<[], Occasion>('SELECT * FROM occasions ORDER BY title').all();
}

export function getOccasionById(id: number): Occasion | undefined {
	const db = getDb();
	return db.prepare<[number], Occasion>('SELECT * FROM occasions WHERE id = ?').get(id);
}

export function listSharedOccasions(): Occasion[] {
	// Everything that isn't per-person (birthdays/anniversaries).
	const db = getDb();
	return db
		.prepare<
			[],
			Occasion
		>(`SELECT * FROM occasions WHERE kind NOT IN ('birthday', 'anniversary') ORDER BY title`)
		.all();
}

export function createOccasion(input: CreateOccasionInput): Occasion {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO occasions (title, kind, recurrence, month, day, date, reminder_days, year)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.title,
			input.kind,
			input.recurrence,
			input.month ?? null,
			input.day ?? null,
			input.date ?? null,
			input.reminder_days ?? 21,
			input.year ?? null
		);
	return getOccasionById(Number(info.lastInsertRowid))!;
}

export interface UpdateOccasionInput {
	title?: string;
	kind?: OccasionKind;
	recurrence?: OccasionRecurrence;
	month?: number | null;
	day?: number | null;
	date?: string | null;
	reminder_days?: number;
	year?: number | null;
}

export function updateOccasion(id: number, input: UpdateOccasionInput): Occasion {
	const db = getDb();
	const before = getOccasionById(id);
	if (!before) throw new Error(`Occasion ${id} not found`);

	const next = {
		title: input.title ?? before.title,
		kind: input.kind ?? before.kind,
		recurrence: input.recurrence ?? before.recurrence,
		month: input.month !== undefined ? input.month : before.month,
		day: input.day !== undefined ? input.day : before.day,
		date: input.date !== undefined ? input.date : before.date,
		reminder_days: input.reminder_days ?? before.reminder_days,
		year: input.year !== undefined ? input.year : before.year
	};

	db.prepare(
		`UPDATE occasions
		    SET title = ?, kind = ?, recurrence = ?, month = ?, day = ?, date = ?,
		        reminder_days = ?, year = ?, updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	).run(
		next.title,
		next.kind,
		next.recurrence,
		next.month,
		next.day,
		next.date,
		next.reminder_days,
		next.year,
		id
	);

	return getOccasionById(id)!;
}

/**
 * Counts how many active person_occasions reference this occasion. Used by
 * the admin UI to warn before deleting an occasion that's in use.
 */
export function countAssignmentsForOccasion(occasionId: number): number {
	const db = getDb();
	const row = db
		.prepare<[number], { cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM person_occasions WHERE occasion_id = ? AND is_active = 1`
		)
		.get(occasionId);
	return row?.cnt ?? 0;
}

/**
 * Hard-deletes an occasion. person_occasions cascades automatically
 * (ON DELETE CASCADE); gifts.occasion_id is set to NULL (ON DELETE SET NULL)
 * — gifts survive, just lose their occasion link. Returns true if a row
 * was deleted.
 */
export function deleteOccasion(occasionId: number): boolean {
	const db = getDb();
	const result = db.prepare(`DELETE FROM occasions WHERE id = ?`).run(occasionId);
	return result.changes > 0;
}

/** Convenience: create a per-person birthday occasion + link it. */
export function createPersonBirthday(
	personId: number,
	month: number,
	day: number,
	actorUserId: number,
	opts?: { title?: string; notes?: string | null; year?: number | null }
): { occasion: Occasion; link: PersonOccasion } {
	const title = opts?.title ?? 'Birthday';
	const occasion = createOccasion({
		title,
		kind: 'birthday',
		recurrence: 'annual',
		month,
		day,
		year: opts?.year ?? null,
		reminder_days: 21
	});
	const link = assignOccasionToPerson(personId, occasion.id, actorUserId, { notes: opts?.notes ?? null });
	return { occasion, link };
}

/**
 * Updates an occasion's year when it's missing. No-op if the occasion
 * already has a year or if the passed year is nullish. Used by the
 * contacts-import backfill path.
 */
export function setOccasionYearIfMissing(occasionId: number, year: number | null): boolean {
	if (year == null) return false;
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE occasions
			    SET year = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ? AND year IS NULL`
		)
		.run(year, occasionId);
	return result.changes > 0;
}

export function assignOccasionToPerson(
	personId: number,
	occasionId: number,
	actorUserId: number,
	opts?: { notes?: string | null; is_active?: boolean }
): PersonOccasion {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO person_occasions (person_id, occasion_id, is_active, notes)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(person_id, occasion_id) DO UPDATE SET
			   is_active = excluded.is_active,
			   notes = excluded.notes`
		)
		.run(
			personId,
			occasionId,
			opts?.is_active === false ? 0 : 1,
			opts?.notes ?? null
		);

	const row = db
		.prepare<[number, number], PersonOccasion>(
			'SELECT * FROM person_occasions WHERE person_id = ? AND occasion_id = ?'
		)
		.get(personId, occasionId)!;

	const occasion = getOccasionById(occasionId);
	logAudit({
		actorUserId,
		entityType: 'person_occasion',
		entityId: row.id,
		action: info.changes === 1 ? 'assign' : 'update',
		summary: `${info.changes === 1 ? 'Assigned' : 'Updated'} occasion "${occasion?.title ?? '?'}" for person ${personId}`
	});
	return row;
}

export function removePersonOccasion(personOccasionId: number, actorUserId: number): void {
	const db = getDb();
	const row = db
		.prepare<
			[number],
			PersonOccasion & { title: string }
		>(
			`SELECT po.*, o.title FROM person_occasions po
			   JOIN occasions o ON o.id = po.occasion_id
			   WHERE po.id = ?`
		)
		.get(personOccasionId);
	if (!row) return;
	db.prepare('DELETE FROM person_occasions WHERE id = ?').run(personOccasionId);
	logAudit({
		actorUserId,
		entityType: 'person_occasion',
		entityId: personOccasionId,
		action: 'remove',
		summary: `Removed occasion "${row.title}" from person ${row.person_id}`
	});
}

export function listPersonOccasions(personId: number): OccasionWithLink[] {
	const db = getDb();
	return db
		.prepare<[number], OccasionWithLink>(
			`SELECT o.*,
			        po.id        AS personOccasionId,
			        po.is_active AS is_active,
			        po.notes     AS link_notes
			   FROM person_occasions po
			   JOIN occasions o ON o.id = po.occasion_id
			  WHERE po.person_id = ?
			  ORDER BY o.kind = 'birthday' DESC, o.title`
		)
		.all(personId);
}

/**
 * Returns the next occurrence Date for the given occasion (annual or one_time).
 * Returns null if a one_time occasion is already in the past.
 */
export function nextOccurrenceDate(occasion: Occasion, today: Date = new Date()): Date | null {
	if (occasion.recurrence === 'one_time') {
		if (!occasion.date) return null;
		const d = new Date(occasion.date + 'T00:00:00');
		if (d.getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) {
			return null;
		}
		return d;
	}

	// annual
	const month = occasion.month;
	const day = occasion.day;
	if (month == null || day == null) return null;

	const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	let candidate = new Date(today.getFullYear(), month - 1, day);
	if (candidate.getTime() < todayStart.getTime()) {
		candidate = new Date(today.getFullYear() + 1, month - 1, day);
	}
	return candidate;
}

/** Human-friendly formatter for a Date in the local calendar. */
export function formatOccasionDate(d: Date): string {
	return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}
