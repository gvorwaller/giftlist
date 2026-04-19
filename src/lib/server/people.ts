import { getDb } from './db';
import type { Gift, Occasion, Person, PersonOccasion } from './types';
import { logAudit } from './audit';
import { nextOccurrenceDate } from './occasions';

export interface PersonUpsertInput {
	display_name: string;
	full_name?: string | null;
	relationship?: string | null;
	default_shipping_address?: string | null;
	notes?: string | null;
}

export interface NextOccasion {
	personOccasionId: number;
	occasionId: number;
	title: string;
	kind: Occasion['kind'];
	date: Date;
	daysUntil: number;
}

export interface PersonWithContext extends Person {
	nextOccasion: NextOccasion | null;
	lastGift: Gift | null;
}

export interface ListPeopleOptions {
	search?: string;
	includeArchived?: boolean;
	sort?: 'upcoming' | 'alphabetical';
}

export function listPeople(opts: ListPeopleOptions = {}): PersonWithContext[] {
	const db = getDb();
	const { search, includeArchived = false, sort = 'alphabetical' } = opts;

	const whereClauses: string[] = [];
	const params: (string | number)[] = [];
	if (!includeArchived) whereClauses.push('p.is_archived = 0');
	if (search && search.trim()) {
		whereClauses.push('(p.display_name LIKE ? OR p.full_name LIKE ?)');
		const like = `%${search.trim()}%`;
		params.push(like, like);
	}

	const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
	const people = db.prepare<typeof params, Person>(`SELECT * FROM people p ${where}`).all(...params);

	// Enrich each person with next occasion + last gift.
	const enriched = people.map((p) => ({
		...p,
		nextOccasion: computeNextOccasionForPerson(p.id),
		lastGift: computeLastGiftForPerson(p.id)
	}));

	if (sort === 'upcoming') {
		// Ascending by daysUntil; null next-occasion goes last.
		enriched.sort((a, b) => {
			const ad = a.nextOccasion?.daysUntil ?? Number.POSITIVE_INFINITY;
			const bd = b.nextOccasion?.daysUntil ?? Number.POSITIVE_INFINITY;
			if (ad !== bd) return ad - bd;
			return a.display_name.localeCompare(b.display_name);
		});
	} else {
		enriched.sort((a, b) => a.display_name.localeCompare(b.display_name));
	}

	return enriched;
}

export function getPersonById(id: number): Person | undefined {
	const db = getDb();
	return db.prepare<[number], Person>('SELECT * FROM people WHERE id = ?').get(id);
}

export function getPersonWithContext(id: number): PersonWithContext | undefined {
	const person = getPersonById(id);
	if (!person) return undefined;
	return {
		...person,
		nextOccasion: computeNextOccasionForPerson(person.id),
		lastGift: computeLastGiftForPerson(person.id)
	};
}

export function createPerson(input: PersonUpsertInput, actorUserId: number): Person {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO people (display_name, full_name, relationship, default_shipping_address, notes)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(
			input.display_name,
			input.full_name ?? null,
			input.relationship ?? null,
			input.default_shipping_address ?? null,
			input.notes ?? null
		);
	const id = Number(info.lastInsertRowid);
	const person = getPersonById(id)!;
	logAudit({
		actorUserId,
		entityType: 'person',
		entityId: id,
		action: 'create',
		summary: `Created person "${person.display_name}"`
	});
	return person;
}

export function updatePerson(
	id: number,
	input: PersonUpsertInput,
	actorUserId: number
): Person {
	const db = getDb();
	const before = getPersonById(id);
	if (!before) throw new Error(`Person ${id} not found`);

	db.prepare(
		`UPDATE people
		    SET display_name = ?, full_name = ?, relationship = ?,
		        default_shipping_address = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	).run(
		input.display_name,
		input.full_name ?? null,
		input.relationship ?? null,
		input.default_shipping_address ?? null,
		input.notes ?? null,
		id
	);

	const after = getPersonById(id)!;

	const changedFields: string[] = [];
	for (const field of ['display_name', 'full_name', 'relationship', 'default_shipping_address', 'notes'] as const) {
		if (before[field] !== after[field]) changedFields.push(field);
	}
	logAudit({
		actorUserId,
		entityType: 'person',
		entityId: id,
		action: 'update',
		summary:
			changedFields.length > 0
				? `Updated ${after.display_name}: ${changedFields.join(', ')}`
				: `Updated ${after.display_name} (no field changes)`
	});

	return after;
}

export function setArchived(id: number, archived: boolean, actorUserId: number): Person {
	const db = getDb();
	const before = getPersonById(id);
	if (!before) throw new Error(`Person ${id} not found`);
	if (Boolean(before.is_archived) === archived) return before;

	db.prepare(
		'UPDATE people SET is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(archived ? 1 : 0, id);
	const after = getPersonById(id)!;

	logAudit({
		actorUserId,
		entityType: 'person',
		entityId: id,
		action: archived ? 'archive' : 'unarchive',
		summary: `${archived ? 'Archived' : 'Restored'} ${after.display_name}`
	});
	return after;
}

function computeNextOccasionForPerson(personId: number): NextOccasion | null {
	const db = getDb();
	const rows = db
		.prepare<[number], PersonOccasion & Occasion & { po_id: number; o_id: number }>(
			`SELECT po.id AS po_id, po.person_id, po.occasion_id, po.is_active, po.notes,
			        o.id AS o_id, o.title, o.kind, o.recurrence,
			        o.month, o.day, o.date, o.reminder_days,
			        o.created_at, o.updated_at
			   FROM person_occasions po
			   JOIN occasions o ON o.id = po.occasion_id
			  WHERE po.person_id = ? AND po.is_active = 1`
		)
		.all(personId);

	if (rows.length === 0) return null;

	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

	let best: NextOccasion | null = null;
	for (const row of rows) {
		const occasion: Occasion = {
			id: row.o_id,
			title: row.title,
			kind: row.kind,
			recurrence: row.recurrence,
			month: row.month,
			day: row.day,
			date: row.date,
			reminder_days: row.reminder_days,
			created_at: row.created_at,
			updated_at: row.updated_at
		};
		const next = nextOccurrenceDate(occasion, today);
		if (!next) continue;
		const daysUntil = Math.round((next.getTime() - today.getTime()) / 86_400_000);
		if (!best || daysUntil < best.daysUntil) {
			best = {
				personOccasionId: row.po_id,
				occasionId: row.o_id,
				title: row.title,
				kind: row.kind,
				date: next,
				daysUntil
			};
		}
	}
	return best;
}

function computeLastGiftForPerson(personId: number): Gift | null {
	const db = getDb();
	const g = db
		.prepare<[number], Gift>(
			`SELECT * FROM gifts
			  WHERE person_id = ? AND is_archived = 0
			  ORDER BY created_at DESC
			  LIMIT 1`
		)
		.get(personId);
	return g ?? null;
}
