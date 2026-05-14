import { getDb } from './db';
import { nextOccurrenceDate, todayMidnightUTC } from './occasions';
import { getFreshDraft } from './drafts';
import { listSkipsWithContext, loadSkipSet, skipKey, type SkipWithContext } from './occasion-skips';
import type {
	Draft,
	Gift,
	GiftStatus,
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
	/** Most-progressed open gift for this (person, occasion). Null when no
	 * non-archived gift exists or only an 'idea' exists. Surfaced as a
	 * status pill on /app/today's "Coming up soon" rows. td-8de343. */
	bestGiftStatus: GiftStatus | null;
}

export interface TodayData {
	nextBestAction: UpcomingOccasion | null;
	comingUp: UpcomingOccasion[];
	packagesOnTheWay: Gift[];
	recentlyViewed: RecentlyViewed[];
	resumeDraft: Draft | null;
	/** Active skips for the current year — surfaced in a "Skipped" footer
	 * so user can recover an iteration they skipped earlier. td-927a2d. */
	skippedThisYear: SkipWithContext[];
}

/**
 * A person drops off the Today list only once the gift is fully closed
 * out — handed to the recipient ('given') or abandoned ('returned'). The
 * lifecycle is idea → planned → ordered → shipped → delivered → wrapped
 * → given; everything before 'given' still needs the manager's attention
 * (delivered=arrived at home, wrapped=ready to give). td-9a7c2e.
 */
const HANDLED_STATUSES = new Set(['given', 'returned']);

/**
 * Statuses that disqualify an occasion from the Next-Best-Thing prompt.
 * The "no gift marked bought yet" copy is literally about purchase: once a
 * gift is in `ordered` or later, the manager has bought it and nextBestAction
 * should rotate to the next person who actually still needs a purchase.
 * `idea` and `planned` still nudge ("chosen but not bought yet" counts as
 * still-to-do). td-0c8de5 follow-up.
 */
const BOUGHT_STATUSES: ReadonlySet<string> = new Set([
	'ordered',
	'shipped',
	'delivered',
	'wrapped',
	'given',
	'returned'
]);

/** Open = anywhere in the lifecycle that needs manager follow-through.
 * Excludes 'idea' (just brainstorming) and the two terminal states. */
export const OPEN_GIFT_STATUSES: readonly string[] = [
	'planned',
	'ordered',
	'shipped',
	'delivered',
	'wrapped'
];

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

	// td-927a2d: drop iterations the user has explicitly skipped for the
	// computed occurrence year. Filter is per-(person_occasion_id, year), so
	// next year's birthday is unaffected by this year's skip.
	const skips = loadSkipSet();

	const today = todayMidnightUTC();
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
		const occurrenceYear = next.getFullYear();
		if (skips.has(skipKey(r.po_id, occurrenceYear))) continue;
		const daysUntil = Math.round((next.getTime() - today.getTime()) / 86_400_000);
		const turnsAge =
			(occasion.kind === 'birthday' || occasion.kind === 'anniversary') && occasion.year != null
				? occurrenceYear - occasion.year
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
			occasionYear: occurrenceYear,
			turnsAge,
			hasHandledGift: false,
			bestGiftStatus: null
		});
	}
	out.sort((a, b) => a.daysUntil - b.daysUntil);
	return out;
}

/** Annotate each upcoming row with handled-gift state and the most-progressed
 * open status. Returns the top status by lifecycle priority (given > returned
 * > wrapped > delivered > shipped > ordered > planned > idea). td-8de343
 * added bestGiftStatus; hasHandledGift retains the Today filter semantics
 * (given/returned only).
 *
 * Attribution: Amazon-imported gifts get `occasion_id = NULL` until the admin
 * assigns one. Without special handling, those gifts wouldn't count toward
 * any of the person's upcoming occasions and would surface false "no gift
 * marked bought yet" prompts. We attribute NULL-occasion gifts to the
 * person's NEAREST upcoming occasion only — a single Amazon gift can't
 * legitimately cover a graduation tomorrow *and* a birthday in 6 months.
 * td-0c8de5 follow-up.
 */
function annotateGiftState(occasions: UpcomingOccasion[]): void {
	if (occasions.length === 0) return;
	const db = getDb();
	const ORDER_CASE = `CASE status
		WHEN 'given' THEN 1
		WHEN 'returned' THEN 2
		WHEN 'wrapped' THEN 3
		WHEN 'delivered' THEN 4
		WHEN 'shipped' THEN 5
		WHEN 'ordered' THEN 6
		WHEN 'planned' THEN 7
		WHEN 'idea' THEN 8
		ELSE 9
	END`;
	const exactStmt = db.prepare<[number, number], { status: GiftStatus }>(
		`SELECT status FROM gifts
		  WHERE is_archived = 0
		    AND person_id = ?
		    AND occasion_id = ?
		  ORDER BY ${ORDER_CASE} LIMIT 1`
	);
	const looseStmt = db.prepare<[number], { status: GiftStatus }>(
		`SELECT status FROM gifts
		  WHERE is_archived = 0
		    AND person_id = ?
		    AND occasion_id IS NULL
		  ORDER BY ${ORDER_CASE} LIMIT 1`
	);

	// Group by person so the NEAREST occasion claims any NULL-occasion gift.
	const byPerson = new Map<number, UpcomingOccasion[]>();
	for (const o of occasions) {
		if (!byPerson.has(o.personId)) byPerson.set(o.personId, []);
		byPerson.get(o.personId)!.push(o);
	}
	for (const list of byPerson.values()) {
		list.sort((a, b) => a.daysUntil - b.daysUntil);
	}

	for (const [personId, list] of byPerson) {
		let looseClaimed = false;
		const looseRow = looseStmt.get(personId);
		for (const o of list) {
			let row = exactStmt.get(personId, o.occasionId);
			if (!row && looseRow && !looseClaimed) {
				row = looseRow;
				looseClaimed = true;
			}
			if (!row) continue;
			o.hasHandledGift = HANDLED_STATUSES.has(row.status);
			// 'idea' isn't a committed gift — don't surface a pill for brainstorming.
			o.bestGiftStatus = row.status === 'idea' ? null : row.status;
		}
	}
}

export function loadTodayData(userId: number): TodayData {
	const upcoming = loadUpcomingWindow(60);
	annotateGiftState(upcoming);

	// nextBestAction surfaces the next purchase to make. Filter out people
	// whose top gift is already bought (ordered+) — they're handled by the
	// Coming Up Soon list and its BOUGHT pill. hasHandledGift alone was too
	// narrow ({given, returned}) and would surface someone with 2 ordered
	// gifts as "no gift marked bought yet". td-0c8de5 follow-up.
	const needsAttention = upcoming.filter(
		(o) => !o.hasHandledGift && !(o.bestGiftStatus && BOUGHT_STATUSES.has(o.bestGiftStatus))
	);
	const nextBestAction = needsAttention[0] ?? null;
	const comingUp = upcoming
		.filter((o) => o !== nextBestAction)
		.slice(0, 5);

	const db = getDb();
	// td-9a7c2e: surface every gift that hasn't yet been given. People
	// whose occasion is past the 60-day cutoff still need to stay visible
	// somewhere on Today as long as their gift is open. Status priority:
	// wrapped > delivered > shipped > ordered > planned — most-actionable
	// (closest to "give it!") rises to the top.
	const openStatuses = [...OPEN_GIFT_STATUSES];
	const packagesOnTheWay = db
		.prepare<string[], Gift>(
			`SELECT g.* FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE g.is_archived = 0
			    AND g.status IN (${openStatuses.map(() => '?').join(',')})
			    AND p.is_archived = 0
			    AND p.is_self = 0
			  ORDER BY
			    CASE g.status
			      WHEN 'wrapped' THEN 1
			      WHEN 'delivered' THEN 2
			      WHEN 'shipped' THEN 3
			      WHEN 'ordered' THEN 4
			      ELSE 5
			    END,
			    COALESCE(g.shipped_at, g.ordered_at, g.created_at) DESC
			  LIMIT 20`
		)
		.all(...openStatuses);

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

	const skippedThisYear = listSkipsWithContext(userId, new Date().getFullYear());

	return {
		nextBestAction,
		comingUp,
		packagesOnTheWay,
		recentlyViewed,
		resumeDraft: getFreshDraft(userId, 'gift') ?? null,
		skippedThisYear
	};
}

export function personForGift(personId: number): Person | undefined {
	const db = getDb();
	return db.prepare<[number], Person>('SELECT * FROM people WHERE id = ?').get(personId);
}
