import { describe, it, expect } from 'vitest';
import { amazonOrderUrl, giftFingerprint } from './amazon-import';

describe('giftFingerprint — Wave 1 Phase 3', () => {
	it('is case-insensitive', () => {
		expect(giftFingerprint('Hallmark Card')).toBe(giftFingerprint('HALLMARK CARD'));
	});

	it('collapses whitespace', () => {
		expect(giftFingerprint('Hallmark  Card')).toBe(giftFingerprint('Hallmark Card'));
	});

	it('trims surrounding whitespace', () => {
		expect(giftFingerprint('  Hallmark Card  ')).toBe(giftFingerprint('Hallmark Card'));
	});

	it('discriminates by title (canonical $100 vs $50 MasterCard case)', () => {
		// Amazon includes the denomination IN THE TITLE for fixed-amount
		// items, so title-only fingerprints distinguish them without
		// needing the parsed price field (which is unreliable across
		// order_placed vs shipped/delivered emails).
		const $100 = giftFingerprint('MasterCard Physical Gift Card – $100 (plus $5.95 Purchase Fee)');
		const $50 = giftFingerprint('MasterCard Physical Gift Card -$50 (plus $4.95 Purchase Fee)');
		expect($100).not.toBe($50);
	});

	it('discriminates by title (different items even with same denomination)', () => {
		const a = giftFingerprint('Hallmark Graduation Card');
		const b = giftFingerprint('Mcduldul Graduation Card for Grandson');
		expect(a).not.toBe(b);
	});

	it('produces stable output across calls', () => {
		const a = giftFingerprint('Endoscope Camera Kit');
		const b = giftFingerprint('Endoscope Camera Kit');
		expect(a).toBe(b);
	});
});

describe('amazonOrderUrl — td-2b5c81', () => {
	it('builds the order-details link from a standard order id', () => {
		expect(amazonOrderUrl('123-4567890-1234567')).toBe(
			'https://www.amazon.com/gp/css/order-details?orderID=123-4567890-1234567'
		);
	});

	it('returns null for null/undefined/empty order ids', () => {
		expect(amazonOrderUrl(null)).toBeNull();
		expect(amazonOrderUrl(undefined)).toBeNull();
		expect(amazonOrderUrl('')).toBeNull();
	});

	it('url-encodes a malformed order id so the link stays well-formed', () => {
		expect(amazonOrderUrl('a b&c')).toBe(
			'https://www.amazon.com/gp/css/order-details?orderID=a%20b%26c'
		);
	});
});
