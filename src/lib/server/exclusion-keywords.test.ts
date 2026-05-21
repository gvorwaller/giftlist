import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, seedUser } from './test-harness';
import {
	createExclusionKeyword,
	getActiveExclusionKeywords,
	getExclusionKeywordById,
	listExclusionKeywords,
	matchExcluded,
	normalizeForMatch,
	setExclusionKeywordArchived,
	type ExclusionKeyword
} from './exclusion-keywords';

function kw(
	keyword: string,
	match_type: 'contains' | 'exact' = 'contains'
): ExclusionKeyword {
	return {
		id: 1,
		keyword,
		match_type,
		notes: null,
		is_archived: 0,
		created_at: '',
		updated_at: ''
	};
}

describe('normalizeForMatch', () => {
	it('lowercases, trims, and collapses whitespace', () => {
		expect(normalizeForMatch('  Tide   PODS  ')).toBe('tide pods');
	});
});

describe('matchExcluded (pure)', () => {
	it('contains matches a substring case-insensitively', () => {
		const hit = matchExcluded('Tide PODS Laundry Detergent, 81 Count', [kw('tide pods')]);
		expect(hit?.keyword).toBe('tide pods');
	});

	it('contains tolerates extra/odd whitespace on both sides', () => {
		const hit = matchExcluded('Bounty  Paper   Towels', [kw('paper towels')]);
		expect(hit).not.toBeNull();
	});

	it('exact requires whole-title equality', () => {
		expect(matchExcluded('Paper Towels 12pk', [kw('Paper Towels', 'exact')])).toBeNull();
		expect(matchExcluded('Paper Towels', [kw('Paper Towels', 'exact')])).not.toBeNull();
	});

	it('returns the first matching keyword when several apply', () => {
		const hit = matchExcluded('Tide PODS', [kw('detergent'), kw('tide'), kw('pods')]);
		expect(hit?.keyword).toBe('tide');
	});

	it('a blank keyword never matches (no all-titles wildcard)', () => {
		expect(matchExcluded('anything', [kw('   ')])).toBeNull();
	});

	it('null/empty title never matches', () => {
		expect(matchExcluded(null, [kw('tide')])).toBeNull();
		expect(matchExcluded('', [kw('tide')])).toBeNull();
	});

	it('no match returns null', () => {
		expect(matchExcluded('Lego Star Wars Set', [kw('tide pods')])).toBeNull();
	});
});

describe('exclusion keyword CRUD', () => {
	let userId: number;
	beforeEach(() => {
		setupTestDb();
		userId = seedUser().id;
	});
	afterEach(() => teardownTestDb());

	it('creates a keyword with defaults', () => {
		const created = createExclusionKeyword('Tide PODS', 'contains', null, userId);
		expect(created.keyword).toBe('Tide PODS');
		expect(created.match_type).toBe('contains');
		expect(created.is_archived).toBe(0);
	});

	it('defaults an unknown match_type to contains', () => {
		const created = createExclusionKeyword('coffee pods', 'fuzzy', null, userId);
		expect(created.match_type).toBe('contains');
	});

	it('rejects a duplicate active keyword (same text + type)', () => {
		createExclusionKeyword('Tide PODS', 'contains', null, userId);
		expect(() => createExclusionKeyword('tide pods', 'contains', null, userId)).toThrow(/already exists/);
	});

	it('allows the same text under a different match_type', () => {
		createExclusionKeyword('Paper Towels', 'contains', null, userId);
		const exact = createExclusionKeyword('Paper Towels', 'exact', null, userId);
		expect(exact.match_type).toBe('exact');
	});

	it('re-adding an archived keyword un-archives it instead of erroring', () => {
		const created = createExclusionKeyword('Tide PODS', 'contains', null, userId);
		setExclusionKeywordArchived(created.id, true, userId);
		expect(getExclusionKeywordById(created.id)!.is_archived).toBe(1);

		const readded = createExclusionKeyword('TIDE pods', 'contains', null, userId);
		expect(readded.id).toBe(created.id);
		expect(readded.is_archived).toBe(0);
		// No duplicate row created.
		expect(listExclusionKeywords({ includeArchived: true })).toHaveLength(1);
	});

	it('getActiveExclusionKeywords omits archived rows', () => {
		const a = createExclusionKeyword('keep', 'contains', null, userId);
		const b = createExclusionKeyword('drop', 'contains', null, userId);
		setExclusionKeywordArchived(b.id, true, userId);
		const active = getActiveExclusionKeywords();
		expect(active.map((k) => k.keyword)).toEqual(['keep']);
		expect(active.map((k) => k.id)).toContain(a.id);
	});
});
