import { describe, it, expect } from 'vitest';
import { scoreGiftCandidates, type ScoringCandidate } from './gift-matcher';

function c(id: number, title: string): ScoringCandidate {
	return { id, title, person_id: 100 + id, display_name: `Person ${id}` };
}

describe('scoreGiftCandidates — td-1d01e9 Phase A heuristics', () => {
	it('rejects the Firehouse/graduation false positive from the user screenshot', () => {
		// Real example: gift "Firehouse gift card" should NOT weakly match an
		// Amazon row for a graduation card. Pre-fix, this scored 33% on
		// 'card' overlap. Post-fix, 'gift'/'card' are stopwords and the
		// anchor token 'firehouse' isn't in the haystack — rejected.
		const result = scoreGiftCandidates(
			'Mcduldul Graduation Card for Grandson, Congrats Grad Grandson Gifts Card for High School, College, University, 2026 Graduation Party',
			[c(1, 'Firehouse gift card')]
		);
		expect(result.confidence).toBe('none');
		expect(result.candidates).toHaveLength(0);
	});

	it('still strongly matches a real brand-name overlap', () => {
		// Gift "Firehouse Subs Gift Card" against an Amazon order email
		// that includes the brand name should still match — 'firehouse'
		// is an anchor token and appears in the haystack.
		const result = scoreGiftCandidates(
			'Firehouse Subs $50 Gift Card email delivery',
			[c(1, 'Firehouse Subs Gift Card')]
		);
		expect(result.confidence).toBe('strong');
		expect(result.topId).toBe(1);
	});

	it('rejects all-generic gift titles (no anchor token at all)', () => {
		// "Gift card" alone has no anchor token after stopword filtering —
		// the candidate is too generic to ever match meaningfully.
		const result = scoreGiftCandidates(
			'Some Random Birthday Gift Card from Aunt Mary',
			[c(1, 'Gift Card')]
		);
		expect(result.confidence).toBe('none');
	});

	it('weak-matches when anchor hits but only some other tokens overlap', () => {
		// "Endoscope Camera Kit" vs "Endoscope USB inspection probe" —
		// 'endoscope' is anchor and hits; 'camera'/'kit' don't appear,
		// but the anchor presence keeps it as a candidate.
		const result = scoreGiftCandidates(
			'Endoscope USB inspection probe with light',
			[c(1, 'Endoscope Camera Kit')]
		);
		expect(['weak', 'strong']).toContain(result.confidence);
		expect(result.candidates[0].giftId).toBe(1);
	});

	it('returns none for empty/whitespace inputs', () => {
		expect(scoreGiftCandidates(null, [c(1, 'Anything')]).confidence).toBe('none');
		expect(scoreGiftCandidates('', [c(1, 'Anything')]).confidence).toBe('none');
		expect(scoreGiftCandidates('   ', [c(1, 'Anything')]).confidence).toBe('none');
	});

	it('returns none when candidate list is empty', () => {
		expect(scoreGiftCandidates('Anything', []).confidence).toBe('none');
	});

	it('ranks multiple candidates and returns top-5', () => {
		const result = scoreGiftCandidates(
			'Endoscope USB camera inspection probe',
			[
				c(1, 'Endoscope Camera Kit'),
				c(2, 'Endoscope Probe'),
				c(3, 'Endoscope USB Tool'),
				c(4, 'Endoscope Inspection Light'),
				c(5, 'Endoscope With Camera'),
				c(6, 'Endoscope With USB Camera') // 6th — should still be considered but capped to top-5
			]
		);
		expect(result.candidates.length).toBeLessThanOrEqual(5);
		// Top candidate should have the best overlap with the haystack.
		expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1]?.score ?? 0);
	});
});
