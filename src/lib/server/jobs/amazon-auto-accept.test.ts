import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	setupTestDb,
	teardownTestDb,
	seedUser,
	seedPerson,
	seedGift,
	seedImportRun,
	seedImportRow,
	itemsJson
} from '../test-harness';
import { buildAutoAcceptDecisions } from './amazon-import';
import { createExclusionKeyword } from '../exclusion-keywords';
import type { ImportRow } from '../types';

interface MatchSpec {
	itemIndex: number;
	giftId: number | null;
	confidence: 'high' | 'medium' | 'low';
}

function verdict(matches: MatchSpec[]): string {
	return JSON.stringify({
		matches: matches.map((m) => ({ ...m, reason: '' })),
		unmatched_items: [],
		safe_to_apply: true,
		summary: '',
		model: 'claude-opus-4-7',
		prompt_version: 'v1',
		created_at: '2026-05-21T00:00:00Z'
	});
}

describe('buildAutoAcceptDecisions — link-only gate', () => {
	let runId: number;
	let personId: number;
	beforeEach(() => {
		setupTestDb();
		seedUser();
		runId = seedImportRun({ actor_user_id: 1 });
		personId = seedPerson({ display_name: 'Aunt May' }).id;
	});
	afterEach(() => teardownTestDb());

	function rowWith(opts: {
		title?: string;
		items?: { title: string }[];
		verdict: string;
		email_type?: ImportRow['email_type'];
	}): ImportRow {
		return seedImportRow({
			import_run_id: runId,
			email_type: opts.email_type ?? 'delivered',
			parsed_title: opts.title ?? null,
			parsed_items_json: opts.items ? itemsJson(opts.items) : null,
			llm_verdict_json: opts.verdict
		});
	}

	it('qualifies a single-item high-confidence link to an existing gift', () => {
		const g = seedGift({ person_id: personId, title: 'Lego Set', status: 'ordered' });
		const row = rowWith({ title: 'Lego Set', verdict: verdict([{ itemIndex: 0, giftId: g.id, confidence: 'high' }]) });
		const decisions = buildAutoAcceptDecisions([row]);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({ rowId: row.id, action: 'accept', assignedGiftId: g.id });
	});

	it('does NOT qualify a medium-confidence match', () => {
		const g = seedGift({ person_id: personId, title: 'Lego Set' });
		const row = rowWith({ title: 'Lego Set', verdict: verdict([{ itemIndex: 0, giftId: g.id, confidence: 'medium' }]) });
		expect(buildAutoAcceptDecisions([row])).toHaveLength(0);
	});

	it('does NOT qualify a confident create-new (giftId null) — link-only', () => {
		const row = rowWith({ title: 'Brand New Thing', verdict: verdict([{ itemIndex: 0, giftId: null, confidence: 'high' }]) });
		expect(buildAutoAcceptDecisions([row])).toHaveLength(0);
	});

	it('does NOT qualify a link to an archived gift', () => {
		const g = seedGift({ person_id: personId, title: 'Old Gift', is_archived: 1 });
		const row = rowWith({ title: 'Old Gift', verdict: verdict([{ itemIndex: 0, giftId: g.id, confidence: 'high' }]) });
		expect(buildAutoAcceptDecisions([row])).toHaveLength(0);
	});

	it('qualifies a multi-item row when EVERY item is a high-confidence link', () => {
		const g1 = seedGift({ person_id: personId, title: 'Lego Set' });
		const g2 = seedGift({ person_id: personId, title: 'Board Game' });
		const row = rowWith({
			items: [{ title: 'Lego Set' }, { title: 'Board Game' }],
			verdict: verdict([
				{ itemIndex: 0, giftId: g1.id, confidence: 'high' },
				{ itemIndex: 1, giftId: g2.id, confidence: 'high' }
			])
		});
		const decisions = buildAutoAcceptDecisions([row]);
		expect(decisions).toHaveLength(1);
		expect(decisions[0].lineItems).toEqual([
			{ lineItemIndex: 0, assignedPersonId: personId, assignedGiftId: g1.id },
			{ lineItemIndex: 1, assignedPersonId: personId, assignedGiftId: g2.id }
		]);
	});

	it('bails the WHOLE multi-item row if any item is not a high-confidence link', () => {
		const g1 = seedGift({ person_id: personId, title: 'Lego Set' });
		const g2 = seedGift({ person_id: personId, title: 'Board Game' });
		const row = rowWith({
			items: [{ title: 'Lego Set' }, { title: 'Board Game' }],
			verdict: verdict([
				{ itemIndex: 0, giftId: g1.id, confidence: 'high' },
				{ itemIndex: 1, giftId: g2.id, confidence: 'medium' }
			])
		});
		expect(buildAutoAcceptDecisions([row])).toHaveLength(0);
	});

	it('skips an excluded item — survivors must still all qualify', () => {
		seedUser(); // actor for the keyword create
		createExclusionKeyword('Tide', 'contains', null, 1);
		const g1 = seedGift({ person_id: personId, title: 'Lego Set' });
		const row = rowWith({
			items: [{ title: 'Lego Set' }, { title: 'Tide Pods 81ct' }],
			verdict: verdict([
				{ itemIndex: 0, giftId: g1.id, confidence: 'high' },
				{ itemIndex: 1, giftId: null, confidence: 'low' } // excluded — would otherwise bail
			])
		});
		const decisions = buildAutoAcceptDecisions([row]);
		expect(decisions).toHaveLength(1);
		expect(decisions[0].lineItems).toEqual([
			{ lineItemIndex: 0, assignedPersonId: personId, assignedGiftId: g1.id }
		]);
	});

	it('ignores rows with no verdict', () => {
		const g = seedGift({ person_id: personId, title: 'Lego Set' });
		void g;
		const row = rowWith({ title: 'Lego Set', verdict: '' });
		// seedImportRow stores '' which parses to no verdict
		const row2 = { ...row, llm_verdict_json: null } as ImportRow;
		expect(buildAutoAcceptDecisions([row2])).toHaveLength(0);
	});
});
