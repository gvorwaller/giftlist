import { getDb } from './db';
import { nextOccurrenceDate } from './occasions';
import { getFreshDraft } from './drafts';
import type {
	Draft,
	Gift,
	Occasion,
	Person,
	PersonOccasion,
	RecentlyViewed
} from './types';

export interface UpcomingOccasion {
	personOccasionId: number;
	personId: number;
	personDisplayName: string;
	occasionId: number;
	occasionTitle: string;
	occasionKind: Occasion['kind'];
	occurrence: Date;
	daysUntil: number;
	occasionYear: number;
	turnsAge: number | null;
	hasHandledGift: boolean;
}

export interface TodayData {
	nextBestAction: UpcomingOccasion | null;
	comingUp: UpcomingOccasion[];
	packagesOnTheWay: Gift[];
	recentlyViewed: RecentlyViewed[];
	resumeDraft: Draft | null;
}

/** Any gift not still an idea — "handled" means we've committed to it. */
const HANDLED_STATUSES = new Set(['planned', 'ordered', 'shipped', 'delivered', 'wrapped', 'given']);

type OccasionJoin = PersonOccasion &
	Occasion & { po_id: number; o_id: number; display_name: string; person_id: number };

function loadUpcomingWindow(daysAhead: number): UpcomingOccasion[] {
	const db = getDb();
	const rows = db
		.prepare<[], OccasionJoin>(
			`SELECT po.id AS po_id, po.person_id AS person_id,
			        p.display_name AS display_name,
			        o.id AS o_id, o.title, o.kind, o.recurrence,
			        o.month, o.day, o.date, o.reminder_days, o.year,
			        o.created_at, o.updated_at
			   FROM person_occasions po
			   JOIN people p ON p.id = po.person_id AND p.is_archived = 0 AND p.is_self = 0
			   JOIN occasions o ON o.id = po.occasion_id
			  WHERE po.is_active = 1`
		)
		.all();

	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const cutoff = today.getTime() + daysAhead * 86_400_000;

	const out: UpcomingOccasion[] = [];
	for (const r of rows) {
		const occasion: Occasion = {
			id: r.o_id,
			title: r.title,
			kind: r.kind,
			recurrence: r.recurrence,
			month: r.month,
			day: r.day,
			date: r.date,
			reminder_days: r.reminder_days,
			year: r.year ?? null,
			created_at: r.created_at,
			updated_at: r.updated_at
		};
		const next = nextOccurrenceDate(occasion, today);
		if (!next || next.getTime() > cutoff) continue;
		const daysUntil = Math.round((next.getTime() - today.getTime()) / 86_400_000);
		const turnsAge =
			(occasion.kind === 'birthday' || occasion.kind === 'anniversary') && occasion.year != null
				? next.getFullYear() - occasion.year
				: null;
		out.push({
			personOccasionId: r.po_id,
			personId: r.person_id,
			personDisplayName: r.display_name,
			occasionId: r.o_id,
			occasionTitle: r.title,
			occasionKind: r.kind,
			occurrence: next,
			daysUntil,
			occasionYear: next.getFullYear(),
			turnsAge,
			hasHandledGift: false
		});
	}
	out.sort((a, b) => a.daysUntil - b.daysUntil);
	return out;
}

function markHandled(occasions: UpcomingOccasion[]): void {
	if (occasions.length === 0) return;
	const db = getDb();
	const handledList = Array.from(HANDLED_STATUSES);
	const stmt = db.prepare<
		[number, number, ...string[]],
		{ cnt: number }
	>(
		`SELECT COUNT(*) AS cnt FROM gifts
		  WHERE is_archived = 0
		    AND person_id = ?
		    AND occasion_id = ?
		    AND status IN (${handledList.map(() => '?').join(',')})`
	);
	for (const o of occasions) {
		const row = stmt.get(o.personId, o.occasionId, ...handledList);
		o.hasHandledGift = Boolean(row && row.cnt > 0);
	}
}

export function loadTodayData(userId: number): TodayData {
	const upcoming = loadUpcomingWindow(60);
	markHandled(upcoming);

	const needsAttention = upcoming.filter((o) => !o.hasHandledGift);
	const nextBestAction = needsAttention[0] ?? null;
	const comingUp = upcoming
		.filter((o) => o !== nextBestAction)
		.slice(0, 5);

	const db = getDb();
	const packagesOnTheWay = db
		.prepare<[], Gift>(
			`SELECT g.* FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE g.is_archived = 0
			    AND g.status IN ('ordered', 'shipped')
			    AND p.is_self = 0
			  ORDER BY COALESCE(g.shipped_at, g.ordered_at, g.created_at) DESC
			  LIMIT 5`
		)
		.all();

	// Filter recently_viewed so self-people don't leak back into Today's
	// recent-history strip. Per-user scoping (td-68804e): hide every self
	// entry whose owner isn't the current user — strict inequality denies
	// foreign-owned AND null-owned rows (treat null as not-mine for safety).
	const recentlyViewed = db
		.prepare<[number, number, number, number], RecentlyViewed>(
			`SELECT rv.* FROM recently_viewed rv
			  WHERE rv.user_id = ?
			    AND NOT (rv.entity_type = 'person' AND EXISTS (
			      SELECT 1 FROM people p
			       WHERE p.id = rv.entity_id
			         AND p.is_self = 1
			         AND (p.owner_user_id IS NOT ?)
			    ))
			    AND NOT (rv.entity_type = 'gift' AND EXISTS (
			      SELECT 1 FROM gifts g
			        JOIN people p ON p.id = g.person_id
			       WHERE g.id = rv.entity_id
			         AND p.is_self = 1
			         AND (p.owner_user_id IS NOT ?)
			    ))
			  ORDER BY rv.viewed_at DESC
			  LIMIT ?`
		)
		.all(userId, userId, userId, 3);

	return {
		nextBestAction,
		comingUp,
		packagesOnTheWay,
		recentlyViewed,
		resumeDraft: getFreshDraft(userId, 'gift') ?? null
	};
}

export function personForGift(personId: number): Person | undefined {
	const db = getDb();
	return db.prepare<[number], Person>('SELECT * FROM people WHERE id = ?').get(personId);
}
