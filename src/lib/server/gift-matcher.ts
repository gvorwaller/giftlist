import { getDb } from './db';

export interface GiftMatchCandidate {
	giftId: number;
	title: string;
	personId: number;
	personDisplayName: string;
	score: number; // 0..1, fraction of gift-title tokens that appear in the parsed email title
}

export type GiftMatchConfidence = 'strong' | 'weak' | 'none';

export interface GiftMatchResult {
	topId: number | null; // only set when confidence === 'strong'
	confidence: GiftMatchConfidence;
	candidates: GiftMatchCandidate[];
}

const STRONG_THRESHOLD = 0.6;
const WEAK_THRESHOLD = 0.3;
const TIE_BREAK_MARGIN = 0.15;

const STOP_WORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'this', 'that', 'set', 'pack', 'pcs',
	'piece', 'pieces', 'item', 'items', 'lot', 'each', 'pcs.', 'inch', 'inches',
	'ft', 'feet', 'cm', 'mm'
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

interface CandidateRow {
	id: number;
	title: string;
	person_id: number;
	display_name: string;
}

/**
 * Token-overlap fuzzy match between an Amazon-parsed item title and open
 * gifts that haven't been linked to an order yet. Lets the review UI propose
 * "this email looks like the Endoscope idea you logged for Benjamin" when
 * Amazon's emails strip recipient and gift designation.
 *
 * Score = fraction of gift-title tokens (the needle) found in the email
 * title (the haystack). Single-product needles like "Endoscope" against a
 * verbose Amazon title score 1.0; multi-item gift titles still match if at
 * least 30% of tokens align.
 */
export function matchGiftByTitle(parsedTitle: string | null | undefined): GiftMatchResult {
	if (!parsedTitle || !parsedTitle.trim()) {
		return { topId: null, confidence: 'none', candidates: [] };
	}
	const haystackTokens = new Set(tokens(parsedTitle));
	if (haystackTokens.size === 0) {
		return { topId: null, confidence: 'none', candidates: [] };
	}

	const db = getDb();
	const rows = db
		.prepare<[], CandidateRow>(
			`SELECT g.id, g.title, g.person_id, p.display_name
			   FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE g.is_archived = 0
			    AND g.order_id IS NULL
			    AND g.status IN ('idea', 'planned')`
		)
		.all();
	if (rows.length === 0) {
		return { topId: null, confidence: 'none', candidates: [] };
	}

	const scored = rows
		.map((r) => {
			const needle = tokens(r.title);
			if (needle.length === 0) return { row: r, score: 0 };
			const hits = needle.filter((t) => haystackTokens.has(t)).length;
			return { row: r, score: hits / needle.length };
		})
		.filter((x) => x.score >= WEAK_THRESHOLD)
		.sort((a, b) => b.score - a.score)
		.slice(0, 5);

	if (scored.length === 0) {
		return { topId: null, confidence: 'none', candidates: [] };
	}

	const top = scored[0];
	const runnerUp = scored[1];
	const clearWinner = !runnerUp || top.score - runnerUp.score >= TIE_BREAK_MARGIN;
	const confidence: GiftMatchConfidence =
		top.score >= STRONG_THRESHOLD && clearWinner
			? 'strong'
			: top.score >= WEAK_THRESHOLD
				? 'weak'
				: 'none';

	return {
		topId: confidence === 'strong' ? top.row.id : null,
		confidence,
		candidates: scored.map((s) => ({
			giftId: s.row.id,
			title: s.row.title,
			personId: s.row.person_id,
			personDisplayName: s.row.display_name,
			score: Number(s.score.toFixed(2))
		}))
	};
}
