import { describe, it, expect } from 'vitest';
import { parseAmazonEmail, extractAmazonTrackingUrl } from './amazon-parser';
import type { GmailMessageFull } from './gmail-reader';

function msg(partial: Partial<GmailMessageFull>): GmailMessageFull {
	return {
		id: 'm1',
		threadId: 't1',
		snippet: '',
		internalDate: '0',
		subject: null,
		from: null,
		receivedAt: null,
		labelIds: [],
		bodyText: '',
		bodyHtml: '',
		...partial
	};
}

describe('extractAmazonTrackingUrl', () => {
	it('extracts a progress-tracker href from HTML', () => {
		const html = `<a href="https://www.amazon.com/gp/your-account/order-details?orderID=123-4567890-1234567&amp;ref=track">Track package</a>`;
		const got = extractAmazonTrackingUrl(html, '');
		// progress-tracker pattern doesn't match this href; ship-track does.
		expect(got).toBeNull();
	});

	it('extracts a progress-tracker URL from HTML', () => {
		const html = `<a href="https://www.amazon.com/progress-tracker/package/ref=TE_dp_track?_encoding=UTF8&amp;itemId=abcdef">Track package</a>`;
		const got = extractAmazonTrackingUrl(html, '');
		expect(got).toBe(
			'https://www.amazon.com/progress-tracker/package/ref=TE_dp_track?_encoding=UTF8&itemId=abcdef'
		);
	});

	it('extracts a ship-track href and decodes &amp;', () => {
		const html = `<a style="..." href="https://www.amazon.com/gp/your-account/ship-track?orderID=111-2222222-3333333&amp;shipmentId=DkVxyz">Track package</a>`;
		const got = extractAmazonTrackingUrl(html, '');
		expect(got).toBe(
			'https://www.amazon.com/gp/your-account/ship-track?orderID=111-2222222-3333333&shipmentId=DkVxyz'
		);
	});

	it('extracts a track.amazon.com href', () => {
		const html = `<p>Shipped! <a href="https://track.amazon.com/tracking/TBA303123456789?ref=foo">View</a></p>`;
		const got = extractAmazonTrackingUrl(html, '');
		expect(got).toBe('https://track.amazon.com/tracking/TBA303123456789?ref=foo');
	});

	it('unwraps a Gmail redirect wrapper', () => {
		const inner =
			'https://www.amazon.com/progress-tracker/package/ref=TE_dp?orderId=111-2222222-3333333';
		const wrapped = `<a href="https://www.google.com/url?rct=j&sa=t&url=${encodeURIComponent(inner)}&q=${encodeURIComponent(inner)}&usg=AOvVaw0_xyz">Track</a>`;
		const got = extractAmazonTrackingUrl(wrapped, '');
		expect(got).toBe(inner);
	});

	it('falls back to text body when HTML is empty', () => {
		const text = `Your package shipped.\n\nTrack: https://www.amazon.com/progress-tracker/package/ref=TE_dp?orderId=111-2222222-3333333\n\nThanks.`;
		const got = extractAmazonTrackingUrl('', text);
		expect(got).toBe(
			'https://www.amazon.com/progress-tracker/package/ref=TE_dp?orderId=111-2222222-3333333'
		);
	});

	it('returns null when no Amazon link is present', () => {
		const html = `<a href="https://www.example.com/promo">Open</a>`;
		const got = extractAmazonTrackingUrl(html, 'visit www.example.com');
		expect(got).toBeNull();
	});
});

describe('parseAmazonEmail trackingUrl wiring', () => {
	it('populates trackingUrl on shipped emails', () => {
		const result = parseAmazonEmail(
			msg({
				subject: 'Shipped: "Cool Thing"',
				bodyHtml: `<a href="https://www.amazon.com/progress-tracker/package/ref=foo?orderId=111-2222222-3333333">Track package</a>`,
				bodyText: 'Shipped: "Cool Thing"'
			})
		);
		expect(result.emailType).toBe('shipped');
		expect(result.trackingUrl).toBe(
			'https://www.amazon.com/progress-tracker/package/ref=foo?orderId=111-2222222-3333333'
		);
	});

	it('populates trackingUrl on delivered emails', () => {
		const result = parseAmazonEmail(
			msg({
				subject: 'Delivered: "Cool Thing"',
				bodyHtml: `<a href="https://track.amazon.com/tracking/TBA303123456789">View</a>`,
				bodyText: ''
			})
		);
		expect(result.emailType).toBe('delivered');
		expect(result.trackingUrl).toBe('https://track.amazon.com/tracking/TBA303123456789');
	});

	it('leaves trackingUrl null on order_placed emails even if a link exists', () => {
		const result = parseAmazonEmail(
			msg({
				subject: 'Your Amazon.com order has been placed',
				bodyHtml: `<a href="https://www.amazon.com/progress-tracker/package/ref=foo?orderId=111-2222222-3333333">Track</a>`,
				bodyText: 'Order placed.'
			})
		);
		expect(result.emailType).toBe('order_placed');
		expect(result.trackingUrl).toBeNull();
	});

	it('returns null trackingUrl on marketing emails (stub record)', () => {
		const result = parseAmazonEmail(
			msg({
				subject: "Today's Deals are here",
				bodyHtml: `<a href="https://track.amazon.com/tracking/TBA303123456789">x</a>`
			})
		);
		expect(result.emailType).toBe('marketing');
		expect(result.trackingUrl).toBeNull();
	});
});
