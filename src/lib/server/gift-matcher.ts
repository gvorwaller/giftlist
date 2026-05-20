import { getDb } from './db';
import type { MatcherCandidate } from './llm-matcher';

/**
 * Wave 1: gift-matcher is now a **candidate-shortlist ranker**, not a
 * pass/fail gate. The old STRONG/WEAK/NONE confidence levels are
 * removed — the LLM does the actual matching with full context, and
 * this module's job is to hand it a curated shortlist (top-20) ranked
 * by a cheap token-overlap heuristic, with recipient-hint priority.
 *
 * Why the change: Codex review (2026-05-18) noted that letting the
 * heuristic auto-accept on `score >= 0.6` rubber-stamps too many wrong
 * matches when the user is paying for Opus to do this work properly.
 * The shortlist approach lets the LLM see the most-relevant candidates
 * without bloating the prompt with hundreds of unrelated gifts.
 */

const STOP_WORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'this', 'that', 'set', 'pack', 'pcs',
	'piece', 'pieces', 'item', 'items', 'lot', 'each', 'pcs.', 'inch', 'inches',
	'ft', 'feet', 'cm', 'mm',
	// Generic gift-tracker stopwords (kept from Phase A).
	'gift', 'gifts', 'card', 'cards', 'box', 'boxes',
	'your', 'our', 'his', 'her', 'their',
	'christmas', 'birthday', 'holiday', 'graduation', 'party', 'wedding',
	'anniversary', 'new', 'old', 'best'
]);

function tokens(s: string): string[] {
	return Array.from(
		new Set(
			s
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, ' ')
				.split(/\s+/)
				.filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
		)
	);
}

/**
 * Pure token-overlap score: fraction of needle tokens that appear in
 * the haystack. Returns 0 for empty needles. Exported for tests.
 */
export function scoreOverlap(needle: string, haystack: string): number {
	const n = tokens(needle);
	if (n.length === 0) return 0;
	const h = new Set(tokens(haystack));
	const hits = n.filter((t) => h.has(t)).length;
	return hits / n.length;
}

interface RawCandidate {
	gift_id: number;
	title: string;
	person_id: number;
	person_display_name: string;
	person_relationship: string | null;
	occasion_label: string | null;
	notes: string | null;
	status: string;
}

const OPEN_GIFTS_QUERY = `
	SELECT
	  g.id            AS gift_id,
	  g.title         AS title,
	  g.person_id     AS person_id,
	  p.display_name  AS person_display_name,
	  p.relationship  AS person_relationship,
	  CASE
	    WHEN o.id IS NULL THEN NULL
	    WHEN g.occasion_year IS NOT NULL THEN o.title || ' ' || g.occasion_year
	    ELSE o.title
	  END             AS occasion_label,
	  g.notes         AS notes,
	  g.status        AS status
	FROM gifts g
	JOIN people p ON p.id = g.person_id
	LEFT JOIN occasions o ON o.id = g.occasion_id
	WHERE g.is_archived = 0
	  AND g.order_id IS NULL
	  AND g.status IN ('idea', 'planned')
`;

/**
 * Returns the top-N open gifts (status idea|planned, no existing
 * order_id) ranked against `needleTitle`. Recipient-hint matches
 * float to the top of the shortlist regardless of token score, so
 * the LLM sees the most-likely-correct candidates first.
 *
 * Always returns up to `limit` items, even when token overlap is
 * zero — the LLM may still find a semantic match the heuristic
 * cannot (e.g. brand-named gift idea vs generic Amazon title).
 */
export function rankCandidatesForImport(
	needleTitle: string | null | undefined,
	recipientHintPersonId: number | null,
	limit = 20
): MatcherCandidate[] {
	const db = getDb();
	const rows = db.prepare<[], RawCandidate>(OPEN_GIFTS_QUERY).all();
	if (rows.length === 0) return [];

	const needle = needleTitle ?? '';
	const scored = rows.map((r) => ({
		row: r,
		score: scoreOverlap(r.title, needle),
		hintMatch: recipientHintPersonId != null && r.person_id === recipientHintPersonId
	}));

	// Sort: hint-match first (any non-zero score for the hinted person,
	// then zero-score hinted), then by score desc, then by gift id desc
	// (newer gifts surfaced first as tiebreaker).
	scored.sort((a, b) => {
		if (a.hintMatch !== b.hintMatch) return a.hintMatch ? -1 : 1;
		if (a.score !== b.score) return b.score - a.score;
		return b.row.gift_id - a.row.gift_id;
	});

	return scored.slice(0, limit).map((s) => toCandidate(s.row));
}

/**
 * Codex P2 (rev 2): multi-item-aware shortlist as a TRUE per-item
 * top-K union — not a global max-score ranking.
 *
 * Why the original max-score approach was wrong:
 * if item 0's title aligns weakly with 20 different open gifts and
 * item 2's title aligns strongly with one outlier gift, a global
 * top-20 sort might still drop the outlier off the bottom of the
 * list (its max-score is below 20 other candidates' max-scores) and
 * item 2 never gets a candidate for the LLM to choose from.
 *
 * Per-item top-K guarantees every incoming item has its own slot in
 * the shortlist before the pool is filled with overall-best
 * tiebreakers.
 *
 * Algorithm:
 *   1. K per item = ceil(limit / itemCount). Each item gets its own
 *      top-K (scored only against that item's title).
 *   2. Union the per-item lists, deduping by gift id. Hint-matched
 *      gifts always survive dedup regardless of their per-item rank.
 *   3. If the union is shorter than `limit`, pad with globally-best
 *      remaining candidates by max-score.
 */
export function rankCandidatesForItems(
	itemTitles: string[],
	recipientHintPersonId: number | null,
	limit = 20
): MatcherCandidate[] {
	if (itemTitles.length === 0) return [];
	if (itemTitles.length === 1) {
		return rankCandidatesForImport(itemTitles[0], recipientHintPersonId, limit);
	}
	const db = getDb();
	const rows = db.prepare<[], RawCandidate>(OPEN_GIFTS_QUERY).all();
	if (rows.length === 0) return [];

	// Compute, for each row: per-item scores + an overall max-score
	// (used as the tie-breaker rank in the union and the padding step).
	const enriched = rows.map((r) => {
		const perItem = itemTitles.map((t) => scoreOverlap(r.title, t));
		const max = perItem.reduce((a, b) => (a > b ? a : b), 0);
		const hintMatch = recipientHintPersonId != null && r.person_id === recipientHintPersonId;
		return { row: r, perItem, max, hintMatch };
	});

	// Step 1: per-item top-K. Within each item's ranking, hint-matched
	// candidates win the tiebreaks (so the hint's gifts get the first
	// shot at each item's slots). This is the right place to express
	// "hint is a strong prior" — it doesn't crowd OTHER items' picks.
	const perItemK = Math.max(1, Math.ceil(limit / itemTitles.length));
	const selected = new Map<number, (typeof enriched)[number]>();
	for (let i = 0; i < itemTitles.length; i++) {
		const ranked = [...enriched]
			.map((e) => ({ ...e, scoreForItem: e.perItem[i] }))
			.sort((a, b) => {
				if (a.hintMatch !== b.hintMatch) return a.hintMatch ? -1 : 1;
				if (a.scoreForItem !== b.scoreForItem) return b.scoreForItem - a.scoreForItem;
				return b.row.gift_id - a.row.gift_id;
			})
			.slice(0, perItemK);
		for (const r of ranked) {
			if (!selected.has(r.row.gift_id)) selected.set(r.row.gift_id, r);
		}
	}

	// (Codex round 3 P2: do NOT unconditionally promote all hint-matched
	// candidates into `selected` here. On a multi-recipient order where
	// the hint resolves to one person with many open gifts, that would
	// fill all `limit` slots with that one person's gifts and crowd out
	// per-item outliers belonging to the OTHER recipients. The per-item
	// step above already gives hint-matched candidates the first shot at
	// each item's slots — that's the right amount of hint priority.)

	// Step 2: pad with globally-best remaining if we're under `limit`.
	// Sort score-first, hint as tiebreaker only — same reason as above.
	if (selected.size < limit) {
		const remaining = enriched
			.filter((e) => !selected.has(e.row.gift_id))
			.sort((a, b) => {
				if (a.max !== b.max) return b.max - a.max;
				if (a.hintMatch !== b.hintMatch) return a.hintMatch ? -1 : 1;
				return b.row.gift_id - a.row.gift_id;
			});
		for (const r of remaining) {
			if (selected.size >= limit) break;
			selected.set(r.row.gift_id, r);
		}
	}

	// Final ordering: score-first, hint as tiebreaker. Ordering only
	// affects the order the LLM sees candidates in the prompt; the
	// shortlist membership is fixed by steps 1-2 above.
	const out = Array.from(selected.values()).sort((a, b) => {
		if (a.max !== b.max) return b.max - a.max;
		if (a.hintMatch !== b.hintMatch) return a.hintMatch ? -1 : 1;
		return b.row.gift_id - a.row.gift_id;
	});
	return out.slice(0, limit).map((e) => toCandidate(e.row));
}

/**
 * Candidate pool for shipment matching: every sibling gift under the
 * given order_pk, full enriched shape. No scoring — the LLM is given
 * all siblings and decides which are in this shipment.
 */
export function siblingsAsCandidates(orderPk: number): MatcherCandidate[] {
	const db = getDb();
	const rows = db
		.prepare<[number], RawCandidate>(
			`${OPEN_GIFTS_QUERY.replace(
				"WHERE g.is_archived = 0\n\t  AND g.order_id IS NULL\n\t  AND g.status IN ('idea', 'planned')",
				'WHERE g.is_archived = 0 AND g.order_pk = ?'
			)}`
		)
		.all(orderPk);
	return rows.map(toCandidate);
}

function toCandidate(r: RawCandidate): MatcherCandidate {
	return {
		giftId: r.gift_id,
		title: r.title,
		personId: r.person_id,
		personDisplayName: r.person_display_name,
		personRelationship: r.person_relationship,
		occasionLabel: r.occasion_label,
		notes: r.notes,
		status: r.status
	};
}
