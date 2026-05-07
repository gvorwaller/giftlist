import { describe, it, expect } from 'vitest';
import { normalizeSenderForVendorMatch } from './tracking-import';

describe('normalizeSenderForVendorMatch', () => {
	it('strips .com TLD', () => {
		expect(normalizeSenderForVendorMatch('mybrand.com')).toBe('mybrand');
	});

	it('strips subdomain + .com', () => {
		expect(normalizeSenderForVendorMatch('shop.bestbuy.com')).toBe('bestbuy');
	});

	it('handles uppercase input', () => {
		expect(normalizeSenderForVendorMatch('Shop.BestBuy.Com')).toBe('bestbuy');
	});

	it('handles co.uk ccTLD (Codex P1 fix)', () => {
		expect(normalizeSenderForVendorMatch('mybrand.co.uk')).toBe('mybrand');
	});

	it('handles com.au ccTLD', () => {
		expect(normalizeSenderForVendorMatch('foo.com.au')).toBe('foo');
	});

	it('handles co.jp ccTLD', () => {
		expect(normalizeSenderForVendorMatch('rakuten.co.jp')).toBe('rakuten');
	});

	it('handles subdomain + ccTLD', () => {
		expect(normalizeSenderForVendorMatch('shop.amazon.co.uk')).toBe('amazon');
	});

	it('falls through on single-label input', () => {
		expect(normalizeSenderForVendorMatch('localhost')).toBe('localhost');
	});

	it('falls through on empty input', () => {
		expect(normalizeSenderForVendorMatch('')).toBe('');
	});
});
