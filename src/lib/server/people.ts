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
	is_self?: boolean;
	/** Owner of a self-person (the user whose personal orders these are).
	 * Ignored when is_self is false; defaults to the actor on create. */
	owner_user_id?: number | null;
}

export interface NextOccasion {
	personOccasionId: number;
	occasionId: number;
	title: string;
	kind: Occasion['kind'];
	date: Date;
	daysUntil: number;
	/** For 'birthday' / 'anniversary' with a known start year, the age/count they'll be *on* this next occurrence. */
	turnsAge: number | null;
}

export interface PersonWithContext extends Person {
	nextOccasion: NextOccasion | null;
	lastGift: Gift | null;
}

export interface GiftWithOccasion extends Gift {
	occasion_title: string | null;
}

export interface PersonDetail extends PersonWithContext {
	gifts: GiftWithOccasion[];
}

export interface ListPeopleOptions {
	search?: string;
	includeArchived?: boolean;
	/** Self-people (is_self=1) are personal-order recipients, hidden from
	 * gift-manager views by default. Admin views opt in via includeSelf=true. */
	includeSelf?: boolean;
	/** Optional self-owner filter (td-68804e privacy scoping). When set with
	 * includeSelf=true, only includes self-people whose owner_user_id matches
	 * (or whose owner is null — unclaimed). Used by /app/gifts/new and the
	 * package list so each user only sees their own self-people. */
	selfOwnerUserId?: number;
	sort?: 'upcoming' | 'alphabetical';
}

export function listPeople(opts: ListPeopleOptions = {}): PersonWithContext[] {
	const db = getDb();
	const { search, includeArchived = false, includeSelf = false, selfOwnerUserId, sort = 'alphabetical' } = opts;

	const whereClauses: string[] = [];
	const params: (string | number)[] = [];
	if (!includeArchived) whereClauses.push('p.is_archived = 0');
	if (!includeSelf) {
		whereClauses.push('p.is_self = 0');
	} else if (selfOwnerUserId !== undefined) {
		// Self rows must match this user. Non-self rows pass. Strict equality
		// — null-owner self rows shouldn't exist (forms + backfill always set
		// owner) and treating them as visible would be a leak.
		whereClauses.push('(p.is_self = 0 OR p.owner_user_id = ?)');
		params.push(selfOwnerUserId);
	}
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
			return compareByLastName(a, b);
		});
	} else {
		enriched.sort(compareByLastName);
	}

	return enriched;
}

/**
 * Extracts a sortable last name from a person's full_name (falls back to display_name).
 * Handles "Last, First" format and single-name rows. Used anywhere we need
 * alphabetical sort — phone book ordering, not first-name ordering.
 */
export function sortKeyLastName(p: Pick<Person, 'full_name' | 'display_name'>): string {
	const source = (p.full_name ?? p.display_name ?? '').trim();
	if (!source) return '';
	if (source.includes(',')) {
		// "Player, Joshua" -> "Player"
		return source.split(',')[0].trim().toLocaleLowerCase();
	}
	const tokens = source.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return source.toLocaleLowerCase();
	return tokens[tokens.length - 1].toLocaleLowerCase();
}

function compareByLastName(a: Person, b: Person): number {
	const ka = sortKeyLastName(a);
	const kb = sortKeyLastName(b);
	const primary = ka.localeCompare(kb);
	if (primary !== 0) return primary;
	return a.display_name.localeCompare(b.display_name);
}

export function getPersonById(id: number): Person | undefined {
	const db = getDb();
	return db.prepare<[number], Person>('SELECT * FROM people WHERE id = ?').get(id);
}

/**
 * Returns the self-person owned by `actorUserId`. Throws if none exists —
 * the tracking importer (td-61017c) and other auto-create flows assume
 * a single canonical self-row per user, which td-68804e backfilled for
 * the existing admin. If you hit this error, create one via
 * /admin/people/new with "Personal orders" checked first.
 */
export function getOrCreateSelfPerson(actorUserId: number): Person {
	const db = getDb();
	const existing = db
		.prepare<[number], Person>(
			'SELECT * FROM people WHERE is_self = 1 AND owner_user_id = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1'
		)
		.get(actorUserId);
	if (existing) return existing;
	throw new Error(
		`No self-person found for user ${actorUserId}; create one via /admin/people/new (check "Personal orders") before running the tracking importer.`
	);
}

/**
 * Returns true if `userId` is allowed to act on `personId` from the manager
 * /app/* surface — i.e. the row exists, isn't archived, and (if it's a
 * self-person) is owned by `userId`. Use as a server-side guard on POST
 * actions that accept a `person_id` from the form. Without this, a crafted
 * POST could create or reassign a gift onto another user's self-person
 * even though the dropdown filter hides them client-side (td-68804e).
 */
export function isPersonVisibleToUser(personId: number, userId: number): boolean {
	const db = getDb();
	const row = db
		.prepare<[number], Pick<Person, 'is_archived' | 'is_self' | 'owner_user_id'>>(
			'SELECT is_archived, is_self, owner_user_id FROM people WHERE id = ?'
		)
		.get(personId);
	if (!row) return false;
	if (row.is_archived === 1) return false;
	// Strict equality — null owner on a self-row means orphaned (e.g. a
	// future user-deletion edge case); deny rather than fall open.
	if (row.is_self === 1 && row.owner_user_id !== userId) return false;
	return true;
}

export function getPersonWithContext(id: number): PersonDetail | undefined {
	const person = getPersonById(id);
	if (!person) return undefined;
	return {
		...person,
		nextOccasion: computeNextOccasionForPerson(person.id),
		lastGift: computeLastGiftForPerson(person.id),
		gifts: listGiftsForPerson(person.id)
	};
}

export function listGiftsForPerson(personId: number): GiftWithOccasion[] {
	const db = getDb();
	return db
		.prepare<[number], GiftWithOccasion>(
			`SELECT g.*, o.title AS occasion_title
			   FROM gifts g
			   LEFT JOIN occasions o ON o.id = g.occasion_id
			  WHERE g.person_id = ? AND g.is_archived = 0
			  ORDER BY g.updated_at DESC`
		)
		.all(personId);
}

export function createPerson(input: PersonUpsertInput, actorUserId: number): Person {
	const db = getDb();
	// owner_user_id only meaningful for self-rows. Default to creator when
	// is_self is set and no explicit owner was passed.
	const ownerUserId = input.is_self ? (input.owner_user_id ?? actorUserId) : null;
	const info = db
		.prepare(
			`INSERT INTO people (display_name, full_name, relationship, default_shipping_address, notes, is_self, owner_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.display_name,
			input.full_name ?? null,
			input.relationship ?? null,
			input.default_shipping_address ?? null,
			input.notes ?? null,
			input.is_self ? 1 : 0,
			ownerUserId
		);
	const id = Number(info.lastInsertRowid);
	const person = getPersonById(id)!;
	logAudit({
		actorUserId,
		entityType: 'person',
		entityId: id,
		action: 'create',
		summary: input.is_self
			? `Created self-person "${person.display_name}" (owner user ${ownerUserId})`
			: `Created person "${person.display_name}"`
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

	// is_self only mutates when the caller passes it explicitly — admin
	// forms send it on every save, but the bulk import path leaves it
	// undefined so we preserve whatever was previously stored. Same pattern
	// for owner_user_id; flipping is_self off auto-clears owner.
	const nextIsSelf = input.is_self === undefined ? before.is_self : input.is_self ? 1 : 0;
	const nextOwnerUserId = (() => {
		if (nextIsSelf === 0) return null;
		if (input.owner_user_id !== undefined) return input.owner_user_id;
		return before.owner_user_id ?? null;
	})();
	db.prepare(
		`UPDATE people
		    SET display_name = ?, full_name = ?, relationship = ?,
		        default_shipping_address = ?, notes = ?, is_self = ?,
		        owner_user_id = ?,
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	).run(
		input.display_name,
		input.full_name ?? null,
		input.relationship ?? null,
		input.default_shipping_address ?? null,
		input.notes ?? null,
		nextIsSelf,
		nextOwnerUserId,
		id
	);

	const after = getPersonById(id)!;

	const changedFields: string[] = [];
	for (const field of ['display_name', 'full_name', 'relationship', 'default_shipping_address', 'notes', 'is_self', 'owner_user_id'] as const) {
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
			        o.month, o.day, o.date, o.reminder_days, o.year,
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
			year: row.year ?? null,
			created_at: row.created_at,
			updated_at: row.updated_at
		};
		const next = nextOccurrenceDate(occasion, today);
		if (!next) continue;
		const daysUntil = Math.round((next.getTime() - today.getTime()) / 86_400_000);
		const turnsAge =
			(occasion.kind === 'birthday' || occasion.kind === 'anniversary') && occasion.year != null
				? next.getFullYear() - occasion.year
				: null;
		if (!best || daysUntil < best.daysUntil) {
			best = {
				personOccasionId: row.po_id,
				occasionId: row.o_id,
				title: row.title,
				kind: row.kind,
				date: next,
				daysUntil,
				turnsAge
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
