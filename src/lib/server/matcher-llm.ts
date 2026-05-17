import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getDb } from './db';
import { matchGiftByTitle, type ScoringCandidate } from './gift-matcher';
import type { ImportRow } from './types';

/**
 * td-1d01e9 Phase B: LLM-based semantic match confirmation.
 *
 * The heuristic matcher in gift-matcher.ts (Phase A) gates on stopwords +
 * anchor tokens. That kills most nonsense matches but still surfaces some
 * lexically-related but semantically-wrong pairings. For weak matches
 * (0.3 ≤ score < 0.6) that survive Phase A, we ask Haiku to either confirm
 * the match or reject it.
 *
 * Runs at IMPORT TIME (when amazon-import.ts stages a new row), not at
 * review-page load time. Results persist into match_candidates_json so
 * the page render is always synchronous + zero-latency.
 *
 * Failure mode: if ANTHROPIC_API_KEY is unset or the API call fails for
 * any reason, returns null and the caller keeps the heuristic-only result.
 * Matcher must never block scan progress.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 12_000;

export interface LlmMatchDecision {
	bestIndex: number | null; // index into the candidate list, or null if "none of these"
	reason: string;
}

/**
 * Ask Haiku to choose the best semantic match (or "none") from a list of
 * candidate gifts for a given email line item. Cached by needle + sorted
 * candidate titles, so re-evaluating the same row returns instantly.
 *
 * Returns null when no API key is configured OR the API call fails —
 * caller falls back to the Phase-A heuristic result.
 */
export async function llmConfirmMatch(
	needleTitle: string,
	candidates: ScoringCandidate[]
): Promise<LlmMatchDecision | null> {
	if (!env.ANTHROPIC_API_KEY) return null;
	if (!needleTitle.trim() || candidates.length === 0) return null;

	const key = computeCacheKey(needleTitle, candidates);
	const cached = readCache(key);
	if (cached) return cached;

	try {
		const decision = await callHaiku(needleTitle, candidates);
		writeCache(key, decision);
		return decision;
	} catch (err) {
		console.warn('[matcher-llm] call failed (falling back to heuristic):', err);
		return null;
	}
}

function computeCacheKey(needle: string, candidates: ScoringCandidate[]): string {
	const sortedTitles = candidates
		.map((c) => c.title.trim().toLowerCase())
		.sort()
		.join('|');
	return createHash('sha1')
		.update(`${needle.trim().toLowerCase()}::${sortedTitles}`)
		.digest('hex');
}

function readCache(key: string): LlmMatchDecision | null {
	const row = getDb()
		.prepare<[string], { response: string }>(
			'SELECT response FROM matcher_llm_cache WHERE cache_key = ?'
		)
		.get(key);
	if (!row) return null;
	try {
		const parsed = JSON.parse(row.response) as LlmMatchDecision;
		if (typeof parsed.reason !== 'string') return null;
		if (parsed.bestIndex !== null && typeof parsed.bestIndex !== 'number') return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeCache(key: string, decision: LlmMatchDecision): void {
	try {
		getDb()
			.prepare(
				`INSERT INTO matcher_llm_cache (cache_key, response)
				 VALUES (?, ?)
				 ON CONFLICT(cache_key) DO UPDATE SET response = excluded.response`
			)
			.run(key, JSON.stringify(decision));
	} catch (err) {
		console.warn('[matcher-llm] cache write failed (non-fatal):', err);
	}
}

async function callHaiku(
	needleTitle: string,
	candidates: ScoringCandidate[]
): Promise<LlmMatchDecision> {
	const candidateList = candidates
		.map((c, i) => `${i}. ${c.title}`)
		.join('\n');

	const prompt = `You are matching an incoming product description to a list of pre-existing gift ideas in a household gift tracker. Both sides describe physical products — your job is to decide if the incoming product is semantically the same item as one of the candidates.

INCOMING PRODUCT:
${needleTitle}

CANDIDATE GIFT IDEAS:
${candidateList}

Respond with strict JSON, no prose, no markdown fences:
{"bestIndex": <number or null>, "reason": "<one short sentence>"}

Rules:
- bestIndex is the index of the matching candidate, or null if NONE clearly match.
- Reject matches that only share generic words like "gift", "card", "set", "box".
- Brand names and distinctive product nouns (e.g. "Endoscope", "Firehouse Subs") are strong signals.
- When in doubt, return null.`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(ANTHROPIC_API, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': env.ANTHROPIC_API_KEY!,
				'anthropic-version': ANTHROPIC_VERSION
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 200,
				messages: [{ role: 'user', content: prompt }]
			}),
			signal: controller.signal
		});
	} finally {
		clearTimeout(timeoutId);
	}

	if (!res.ok) {
		const errBody = await res.text().catch(() => '');
		throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 200)}`);
	}

	const json = (await res.json()) as {
		content: Array<{ type: string; text?: string }>;
	};
	const text = json.content?.find((c) => c.type === 'text')?.text ?? '';
	const parsed = parseDecision(text, candidates.length);
	if (!parsed) {
		throw new Error(`Could not parse Haiku response: ${text.slice(0, 200)}`);
	}
	return parsed;
}

/**
 * Admin-triggered batch: walk every pending row in a run, re-run the
 * heuristic gift matcher, and call Haiku for each weak candidate set that
 * isn't already cached. Returns counts so the UI can flash a result.
 *
 * Idempotent — re-running is free for cached (needle, candidate set) pairs.
 */
export interface ReevaluateResult {
	evaluated: number;
	cacheHits: number;
	confirmed: number;
	rejected: number;
	apiCalls: number;
	apiErrors: number;
	skippedNoKey: boolean;
}

export async function reevaluateMatchesForRun(runId: number): Promise<ReevaluateResult> {
	const out: ReevaluateResult = {
		evaluated: 0,
		cacheHits: 0,
		confirmed: 0,
		rejected: 0,
		apiCalls: 0,
		apiErrors: 0,
		skippedNoKey: false
	};
	if (!env.ANTHROPIC_API_KEY) {
		out.skippedNoKey = true;
		return out;
	}
	const db = getDb();
	const rows = db
		.prepare<[number], ImportRow>(
			`SELECT * FROM import_rows
			  WHERE import_run_id = ? AND disposition = 'pending'
			    AND parsed_title IS NOT NULL`
		)
		.all(runId);

	for (const row of rows) {
		const result = matchGiftByTitle(row.parsed_title);
		if (result.confidence !== 'weak' || result.candidates.length === 0) continue;
		out.evaluated += 1;

		const scoringCandidates: ScoringCandidate[] = result.candidates.map((c) => ({
			id: c.giftId,
			title: c.title,
			person_id: c.personId,
			display_name: c.personDisplayName
		}));
		const key = computeCacheKey(row.parsed_title!, scoringCandidates);
		const cached = readCache(key);
		if (cached) {
			out.cacheHits += 1;
			if (cached.bestIndex !== null) out.confirmed += 1;
			else out.rejected += 1;
			continue;
		}

		try {
			const decision = await callHaiku(row.parsed_title!, scoringCandidates);
			writeCache(key, decision);
			out.apiCalls += 1;
			if (decision.bestIndex !== null) out.confirmed += 1;
			else out.rejected += 1;
		} catch (err) {
			console.warn(`[matcher-llm] reevaluate row ${row.id} failed:`, err);
			out.apiErrors += 1;
		}
	}
	return out;
}

function parseDecision(text: string, candidateCount: number): LlmMatchDecision | null {
	// Tolerate occasional markdown fence around the JSON.
	const stripped = text
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/```\s*$/i, '')
		.trim();
	try {
		const obj = JSON.parse(stripped) as { bestIndex: unknown; reason: unknown };
		const reason = typeof obj.reason === 'string' ? obj.reason : '';
		if (obj.bestIndex === null) {
			return { bestIndex: null, reason };
		}
		if (
			typeof obj.bestIndex === 'number' &&
			Number.isInteger(obj.bestIndex) &&
			obj.bestIndex >= 0 &&
			obj.bestIndex < candidateCount
		) {
			return { bestIndex: obj.bestIndex, reason };
		}
		return null;
	} catch {
		return null;
	}
}
