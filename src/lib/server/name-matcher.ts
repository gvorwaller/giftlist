import { getDb } from './db';
import type { MatchConfidence, Person } from './types';

export interface MatchResult {
	personId: number | null;
	confidence: MatchConfidence;
	candidates: Array<{ personId: number; displayName: string; confidence: MatchConfidence; distance?: number }>;
}

const FUZZY_THRESHOLD = 3;

export function matchRecipient(name: string | null | undefined): MatchResult {
	if (!name || !name.trim()) {
		return { personId: null, confidence: 'none', candidates: [] };
	}
	const normalized = normalize(name);
	const db = getDb();

	// 1. Exact match on display_name or full_name.
	const exact = db
		.prepare<[string, string], Person>(
			`SELECT * FROM people
			  WHERE is_archived = 0
			    AND (LOWER(display_name) = ? OR LOWER(full_name) = ?)
			  LIMIT 1`
		)
		.get(normalized, normalized);
	if (exact) {
		return {
			personId: exact.id,
			confidence: 'exact',
			candidates: [{ personId: exact.id, displayName: exact.display_name, confidence: 'exact' }]
		};
	}

	// 2. Alias table hit.
	const alias = db
		.prepare<[string], Person & { alias_name: string }>(
			`SELECT p.*, a.alias_name AS alias_name
			   FROM person_aliases a
			   JOIN people p ON p.id = a.person_id
			  WHERE LOWER(a.alias_name) = ? AND p.is_archived = 0
			  LIMIT 1`
		)
		.get(normalized);
	if (alias) {
		return {
			personId: alias.id,
			confidence: 'alias',
			candidates: [{ personId: alias.id, displayName: alias.display_name, confidence: 'alias' }]
		};
	}

	// 3. Fuzzy (Levenshtein) against display_name and full_name.
	const people = db
		.prepare<[], Person>(`SELECT * FROM people WHERE is_archived = 0`)
		.all();
	const ranked = people
		.map((p) => {
			const candidates = [p.display_name, p.full_name].filter(
				(x): x is string => typeof x === 'string' && x.length > 0
			);
			const best = candidates.reduce<number>((acc, c) => {
				const d = levenshtein(normalized, normalize(c));
				return d < acc ? d : acc;
			}, Number.POSITIVE_INFINITY);
			return { person: p, distance: best };
		})
		.filter((r) => Number.isFinite(r.distance) && r.distance <= FUZZY_THRESHOLD)
		.sort((a, b) => a.distance - b.distance)
		.slice(0, 5);

	if (ranked.length === 0) {
		return { personId: null, confidence: 'none', candidates: [] };
	}

	const candidates = ranked.map((r) => ({
		personId: r.person.id,
		displayName: r.person.display_name,
		confidence: 'fuzzy' as const,
		distance: r.distance
	}));

	// Only auto-assign if the top is clearly better than the runner-up.
	const top = ranked[0];
	const runnerUp = ranked[1];
	const clearWinner = runnerUp ? runnerUp.distance > top.distance : true;

	return {
		personId: clearWinner ? top.person.id : null,
		confidence: clearWinner ? 'fuzzy' : 'none',
		candidates
	};
}

/** Persist a manual assignment as a learned alias for next time. */
export function saveAlias(personId: number, aliasName: string, source: 'manual' | 'import_assigned' = 'import_assigned'): void {
	const alias = aliasName.trim();
	if (!alias) return;
	const db = getDb();
	db.prepare(
		`INSERT INTO person_aliases (person_id, alias_name, source)
		 VALUES (?, ?, ?)
		 ON CONFLICT(alias_name) DO UPDATE SET
		   person_id = excluded.person_id,
		   source = excluded.source`
	).run(personId, alias, source);
}

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Iterative Levenshtein with O(min(m,n)) space. */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	if (a.length < b.length) [a, b] = [b, a];
	const m = a.length;
	const n = b.length;
	let prev = new Array<number>(n + 1);
	let curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}
