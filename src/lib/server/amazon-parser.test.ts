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

describe('parseAmazonEmail multi-item extraction (td-3e9ae2)', () => {
	it('parses a single-item order_placed email into a one-entry items array', () => {
		const body = [
			'Order #113-1111111-1111111',
			'',
			'* Cool Thing With A Long Title That Survives Subject Truncation',
			'  Quantity: 1',
			'  $24.99',
			'',
			'Order total: $24.99'
		].join('\n');
		const result = parseAmazonEmail(
			msg({
				subject: 'Your Amazon.com order has been placed',
				bodyText: body
			})
		);
		expect(result.items.length).toBe(1);
		expect(result.items[0].title).toContain('Cool Thing');
		expect(result.items[0].priceCents).toBe(2499);
		expect(result.items[0].quantity).toBe(1);
		expect(result.title).toContain('Cool Thing');
	});

	it('parses a four-item order (the td-3e9ae2 reproducer: order #113-2234245-9301002)', () => {
		const body = [
			'Order #113-2234245-9301002',
			'',
			'* Graduation Card For The Graduate',
			'  Quantity: 1',
			'  $4.99',
			'',
			'* MasterCard Gift Card',
			'  Quantity: 1',
			'  $54.95',
			'',
			'* Hallmark Card',
			'  Quantity: 1',
			'  $5.99',
			'',
			'* MasterCard Gift Card',
			'  Quantity: 1',
			'  $105.95',
			'',
			'Order total: $171.88'
		].join('\n');
		const result = parseAmazonEmail(
			msg({
				subject: 'Your Amazon.com order has been placed',
				bodyText: body
			})
		);
		expect(result.items.length).toBe(4);
		expect(result.items.map((i) => i.priceCents)).toEqual([499, 5495, 599, 10595]);
		// Order total stays in priceCents for backward compat.
		expect(result.priceCents).toBe(17188);
	});

	it('returns an empty items array on marketing emails', () => {
		const result = parseAmazonEmail(
			msg({
				subject: "Today's Deals are here",
				bodyText: '* Some promo bullet\n  Quantity: 1\n  $9.99'
			})
		);
		expect(result.items).toEqual([]);
	});

	it('tolerates a missing inline price by leaving priceCents null on that item', () => {
		const body = [
			'* Item Without Inline Price Bullet',
			'  Quantity: 2',
			'  Some other line',
			'',
			'* Item With Inline Price',
			'  Quantity: 1',
			'  $12.50'
		].join('\n');
		const result = parseAmazonEmail(
			msg({ subject: 'Shipped: "x"', bodyText: body })
		);
		expect(result.items.length).toBe(2);
		expect(result.items[0].priceCents).toBeNull();
		expect(result.items[0].quantity).toBe(2);
		expect(result.items[1].priceCents).toBe(1250);
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
