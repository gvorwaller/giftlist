import { createHash } from 'node:crypto';
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
	// td-1d01e9 Phase B: when populated, the LLM has reviewed the heuristic
	// weak-match candidates and either confirmed one (confirmedGiftId set) or
	// rejected all (confirmedGiftId === null). UI prefers this verdict over
	// raw weak-match candidates when present.
	llmVerdict?: {
		confirmedGiftId: number | null;
		reason: string;
	};
}

const STRONG_THRESHOLD = 0.6;
const WEAK_THRESHOLD = 0.3;
const TIE_BREAK_MARGIN = 0.15;

const STOP_WORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'this', 'that', 'set', 'pack', 'pcs',
	'piece', 'pieces', 'item', 'items', 'lot', 'each', 'pcs.', 'inch', 'inches',
	'ft', 'feet', 'cm', 'mm',
	// td-1d01e9 Phase A: words too generic to anchor a meaningful match.
	// Without these, "Firehouse gift card" would score 33% against
	// "Mcduldul Graduation Card for Grandson..." purely on 'card' overlap.
	'gift', 'gifts', 'card', 'cards', 'box', 'boxes',
	'your', 'our', 'his', 'her', 'their',
	'christmas', 'birthday', 'holiday', 'graduation', 'party', 'wedding',
	'anniversary', 'new', 'old', 'best'
]);

// A token is "anchor-grade" if it's long enough and not a bare number —
// brand names, proper nouns, distinctive product words. Generic tokens
// like 'gift'/'card' are excluded by the stopword list above; very short
// tokens are excluded by the length filter in tokens().
const ANCHOR_MIN_LENGTH = 5;
function isAnchorToken(t: string): boolean {
	return t.length >= ANCHOR_MIN_LENGTH && !/^\d+$/.test(t);
}

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

export interface ScoringCandidate {
	id: number;
	title: string;
	person_id: number;
	display_name: string;
}

/**
 * Pure scoring function — separated from the DB query so it can be unit
 * tested with synthetic candidates. Given a parsed email title and a list
 * of candidate gifts, returns the top-5 scored matches and an overall
 * strong/weak/none confidence.
 *
 * Score = fraction of gift-title tokens (the needle) found in the email
 * title (the haystack). Single-product needles like "Endoscope" against a
 * verbose Amazon title score 1.0; multi-item gift titles still match if at
 * least 30% of tokens align AND the anchor-token gate is satisfied.
 */
export function scoreGiftCandidates(
	parsedTitle: string | null | undefined,
	rows: ScoringCandidate[]
): GiftMatchResult {
	if (!parsedTitle || !parsedTitle.trim()) {
		return { topId: null, confidence: 'none', candidates: [] };
	}
	const haystackTokens = new Set(tokens(parsedTitle));
	if (haystackTokens.size === 0) {
		return { topId: null, confidence: 'none', candidates: [] };
	}
	if (rows.length === 0) {
		return { topId: null, confidence: 'none', candidates: [] };
	}

	const scored = rows
		.map((r) => {
			const needle = tokens(r.title);
			if (needle.length === 0) return { row: r, score: 0 };
			// td-1d01e9 Phase A: anchor-token gate. The needle must contain at
			// least one anchor-grade token (≥5 char, non-digit) AND that anchor
			// must appear in the haystack. Otherwise we're matching on noise
			// like 'gift'/'card' alone — see Firehouse/graduation false positive.
			const needleAnchors = needle.filter(isAnchorToken);
			if (needleAnchors.length === 0) return { row: r, score: 0 };
			const anchorHit = needleAnchors.some((t) => haystackTokens.has(t));
			if (!anchorHit) return { row: r, score: 0 };
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

/**
 * Token-overlap fuzzy match between an Amazon-parsed item title and open
 * gifts that haven't been linked to an order yet. Lets the review UI propose
 * "this email looks like the Endoscope idea you logged for Benjamin" when
 * Amazon's emails strip recipient and gift designation.
 *
 * td-1d01e9 Phase B: for weak matches, also consults the matcher_llm_cache
 * (synchronous DB lookup only, never blocks on the Anthropic API). Cache
 * is warmed by the admin-triggered re-evaluate action.
 */
export function matchGiftByTitle(parsedTitle: string | null | undefined): GiftMatchResult {
	const db = getDb();
	const rows = db
		.prepare<[], ScoringCandidate>(
			`SELECT g.id, g.title, g.person_id, p.display_name
			   FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE g.is_archived = 0
			    AND g.order_id IS NULL
			    AND g.status IN ('idea', 'planned')`
		)
		.all();
	const result = scoreGiftCandidates(parsedTitle, rows);
	if (result.confidence === 'weak' && parsedTitle) {
		const cached = readLlmCacheForCandidates(parsedTitle, result.candidates);
		if (cached) result.llmVerdict = cached;
	}
	return result;
}

// td-1d01e9 Phase B: synchronous cache lookup. Matches the cache key
// computation in matcher-llm.ts (sha1 of needle + sorted candidate titles).
// Imported lazily via dynamic require to keep this module DB-aware but
// API-key-agnostic.
function readLlmCacheForCandidates(
	needle: string,
	candidates: GiftMatchCandidate[]
): { confirmedGiftId: number | null; reason: string } | null {
	if (candidates.length === 0) return null;
	const sortedTitles = candidates
		.map((c) => c.title.trim().toLowerCase())
		.sort()
		.join('|');
	const key = createHash('sha1')
		.update(`${needle.trim().toLowerCase()}::${sortedTitles}`)
		.digest('hex');
	const row = getDb()
		.prepare<[string], { response: string }>(
			'SELECT response FROM matcher_llm_cache WHERE cache_key = ?'
		)
		.get(key);
	if (!row) return null;
	try {
		const parsed = JSON.parse(row.response) as {
			bestIndex: number | null;
			reason: string;
		};
		if (parsed.bestIndex === null) {
			return { confirmedGiftId: null, reason: parsed.reason ?? '' };
		}
		const winner = candidates[parsed.bestIndex];
		if (!winner) return null;
		return { confirmedGiftId: winner.giftId, reason: parsed.reason ?? '' };
	} catch {
		return null;
	}
}
