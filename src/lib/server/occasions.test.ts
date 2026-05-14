import { describe, it, expect } from 'vitest';
import { nextOccurrenceDate, todayMidnightUTC } from './occasions';
import type { Occasion } from './types';

function occasion(overrides: Partial<Occasion> = {}): Occasion {
	return {
		id: 1,
		title: 'Birthday',
		kind: 'birthday',
		recurrence: 'annual',
		month: 12,
		day: 7,
		date: null,
		reminder_days: 21,
		year: 1946,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		...overrides
	};
}

describe('nextOccurrenceDate (td-68e82a)', () => {
	it('returns Dec 7 for a Dec 7 birthday when asked on May 13 — same calendar date in every US timezone', () => {
		const today = new Date('2026-05-13T12:00:00Z');
		const next = nextOccurrenceDate(occasion(), today);
		expect(next).not.toBeNull();
		expect(next!.toISOString().slice(0, 10)).toBe('2026-12-07');
		// Critical: any US timezone renders the same calendar date.
		const eastern = next!.toLocaleDateString('en-US', {
			timeZone: 'America/New_York',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
		const pacific = next!.toLocaleDateString('en-US', {
			timeZone: 'America/Los_Angeles',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
		expect(eastern).toBe('12/07/2026');
		expect(pacific).toBe('12/07/2026');
	});

	it('rolls past birthday to next year', () => {
		const today = new Date('2026-12-08T12:00:00Z');
		const next = nextOccurrenceDate(occasion(), today);
		expect(next!.toISOString().slice(0, 10)).toBe('2027-12-07');
	});

	it('returns today when birthday is today', () => {
		const today = new Date('2026-12-07T12:00:00Z');
		const next = nextOccurrenceDate(occasion(), today);
		expect(next!.toISOString().slice(0, 10)).toBe('2026-12-07');
	});

	it('handles one_time occasions with a future date', () => {
		const o = occasion({
			kind: 'custom',
			recurrence: 'one_time',
			month: null,
			day: null,
			date: '2026-06-15',
			year: null
		});
		const next = nextOccurrenceDate(o, new Date('2026-05-13T12:00:00Z'));
		expect(next!.toISOString().slice(0, 10)).toBe('2026-06-15');
	});

	it('returns null for one_time occasions in the past', () => {
		const o = occasion({
			kind: 'custom',
			recurrence: 'one_time',
			month: null,
			day: null,
			date: '2025-06-15',
			year: null
		});
		const next = nextOccurrenceDate(o, new Date('2026-05-13T12:00:00Z'));
		expect(next).toBeNull();
	});
});

describe('todayMidnightUTC', () => {
	it('produces a date that is the same calendar day in any US timezone', () => {
		const t = todayMidnightUTC(new Date('2026-05-13T22:00:00-04:00')); // 8 PM EDT = 02:00 UTC May 14
		// Local date components in the runtime tz drive the result; assert it's noon-anchored UTC.
		expect(t.getUTCHours()).toBe(12);
	});
});
