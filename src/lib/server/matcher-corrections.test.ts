import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, seedPerson, seedGift } from './test-harness';
import { appendCorrection, listRecentCorrections } from './matcher-corrections';

describe('matcher-corrections', () => {
	let personId: number;
	let giftId: number;
	beforeEach(() => {
		setupTestDb();
		personId = seedPerson({ display_name: 'Aunt May' }).id;
		giftId = seedGift({ person_id: personId, title: 'Lego Set' }).id;
	});
	afterEach(() => teardownTestDb());

	function add(emailTitle: string | null, giftTitle = 'Lego Set'): void {
		appendCorrection({
			sourceEmailTitle: emailTitle,
			sourceEmailSubject: 'subj',
			chosenGiftId: giftId,
			chosenGiftTitle: giftTitle,
			chosenPersonId: personId,
			chosenPersonName: 'Aunt May',
			action: 'override'
		});
	}

	it('append + listRecent maps to the prompt MatcherCorrection shape', () => {
		add('Your Amazon order of Lego Star Wars');
		const recent = listRecentCorrections(5);
		expect(recent).toEqual([
			{ emailTitle: 'Your Amazon order of Lego Star Wars', giftTitle: 'Lego Set', personDisplayName: 'Aunt May' }
		]);
	});

	it('returns the most recent N, newest first', () => {
		for (let i = 1; i <= 7; i++) add(`email ${i}`);
		const recent = listRecentCorrections(5);
		expect(recent).toHaveLength(5);
		expect(recent[0].emailTitle).toBe('email 7');
		expect(recent[4].emailTitle).toBe('email 3');
	});

	it('null source title maps to empty string', () => {
		add(null);
		expect(listRecentCorrections(5)[0].emailTitle).toBe('');
	});

	it('empty table returns []', () => {
		expect(listRecentCorrections(5)).toEqual([]);
	});

	it('upserts the same correction instead of duplicating it (Codex P2)', () => {
		// Same order's order_placed/shipped/delivered → identical correction.
		add('Lego Set');
		add('Lego Set');
		add('Lego Set');
		const recent = listRecentCorrections(5);
		expect(recent).toHaveLength(1);
		expect(recent[0]).toEqual({ emailTitle: 'Lego Set', giftTitle: 'Lego Set', personDisplayName: 'Aunt May' });
	});

	it('a different chosen gift for the same email title is a distinct correction', () => {
		const otherGift = seedGift({ person_id: personId, title: 'Board Game' }).id;
		add('Lego Set'); // → giftId
		appendCorrection({
			sourceEmailTitle: 'Lego Set',
			sourceEmailSubject: 'subj',
			chosenGiftId: otherGift,
			chosenGiftTitle: 'Board Game',
			chosenPersonId: personId,
			chosenPersonName: 'Aunt May',
			action: 'override'
		});
		expect(listRecentCorrections(5)).toHaveLength(2);
	});
});
