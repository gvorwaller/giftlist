import { describe, it, expect } from 'vitest';
import { parseShipmentEmail } from './shipment-parser';
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

describe('parseShipmentEmail', () => {
	it('UPS shipment from pkginfo@ups.com → high, UPS', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Your package is on the way',
				from: 'UPS Quantum View <pkginfo@ups.com>',
				bodyText: 'Tracking number: 1Z999AA10123456784\nDelivery expected Tuesday.'
			})
		);
		expect(result.trackingNumber).toBe('1Z999AA10123456784');
		expect(result.carrier).toBe('UPS');
		expect(result.carrierSlug).toBe('ups');
		expect(result.confidence).toBe('high');
		expect(result.senderDomain).toBe('ups.com');
	});

	it('USPS 22-digit domestic (94…) → high, USPS', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Shipment Notification',
				from: 'USPS <auto-reply@usps.com>',
				bodyText: 'Your package tracking number is 9400111202555012345671.'
			})
		);
		expect(result.trackingNumber).toBe('9400111202555012345671');
		expect(result.carrier).toBe('USPS');
		expect(result.carrierSlug).toBe('usps');
		expect(result.confidence).toBe('high');
	});

	it('USPS Intl S10 → high, USPS', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Express Mail International',
				from: 'tracking@usps.com',
				bodyText: 'Track at usps.com using EA123456789US.'
			})
		);
		expect(result.trackingNumber).toBe('EA123456789US');
		expect(result.carrier).toBe('USPS');
	});

	it('FedEx 12-digit from tracking@fedex.com → high, FedEx', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'FedEx Shipment 123456789012',
				from: 'TrackingUpdates@fedex.com',
				bodyText: 'Your tracking number is 123456789012.'
			})
		);
		expect(result.trackingNumber).toBe('123456789012');
		expect(result.carrier).toBe('FedEx');
		expect(result.carrierSlug).toBe('fedex');
		expect(result.confidence).toBe('high');
	});

	it('FedEx 15-digit (prefer 15 over truncating to 12)', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'FedEx Express Shipment',
				from: 'TrackingUpdates@fedex.com',
				bodyText: 'Tracking ID: 794633746362188'
			})
		);
		expect(result.trackingNumber).toBe('794633746362188');
		expect(result.carrier).toBe('FedEx');
	});

	it('DHL 10-digit from noreply@dhl.com → high, DHL', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Your DHL shipment',
				from: 'DHL Express <noreply@dhl.com>',
				bodyText: 'Track your package: 1234567890.'
			})
		);
		expect(result.trackingNumber).toBe('1234567890');
		expect(result.carrier).toBe('DHL');
		expect(result.carrierSlug).toBe('dhl_express');
	});

	it('OnTrac (C + 14 digits) → high, OnTrac', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'OnTrac Shipment Update',
				from: 'no-reply@ontrac.com',
				bodyText: 'Tracking: C12345678901234'
			})
		);
		expect(result.trackingNumber).toBe('C12345678901234');
		expect(result.carrier).toBe('OnTrac');
		expect(result.carrierSlug).toBe('ontrac');
	});

	it('Lasership from tracking@lasership.com → high, Lasership', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Lasership Tracking Update',
				from: 'tracking@lasership.com',
				bodyText: 'Track your delivery: LX123ABC4567 at lasership.com/track.'
			})
		);
		expect(result.trackingNumber).toBe('LX123ABC4567');
		expect(result.carrier).toBe('Lasership');
	});

	it('Canada Post from noreply@canadapost.ca → high, Canada Post', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Your Canada Post shipment',
				from: 'noreply@canadapost.ca',
				bodyText: 'Tracking number: 1234567890123456'
			})
		);
		expect(result.trackingNumber).toBe('1234567890123456');
		expect(result.carrier).toBe('Canada Post');
		expect(result.carrierSlug).toBe('canada_post');
	});

	it('Merchant promo with strict "Order #…" but no tracking# → order_confirmation', () => {
		// Side effect of the order_confirmation intent (td-c28c5e): emails
		// containing the strict marker now stage as pending order_confirmation
		// regardless of merchant intent. Admin Skip is the safety net.
		const result = parseShipmentEmail(
			msg({
				subject: 'Save 20% on your next order',
				from: 'marketing@somerandom.com',
				bodyText: 'Use code FALL20. Reference Order #123456789012 for 20% off.'
			})
		);
		expect(result.trackingNumber).toBeNull();
		expect(result.carrier).toBeNull();
		expect(result.emailType).toBe('order_confirmation');
		expect(result.orderId).toBe('123456789012');
	});

	it('Amazon Logistics TBA → high, Amazon', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Your Amazon package',
				from: 'shipment-tracking@amazon.com',
				bodyText: 'Track your shipment: TBA123456789012'
			})
		);
		expect(result.trackingNumber).toBe('TBA123456789012');
		expect(result.carrier).toBe('Amazon');
		expect(result.carrierSlug).toBe('amazon');
	});

	it('Phishing-shaped UPS (no carrier domain, no carrier URL) → still high, but admin gates', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'You have a package waiting',
				from: 'updates@suspicious-domain.xyz',
				bodyText: 'Click here to confirm: 1Z999AA10123456784'
			})
		);
		// UPS regex is distinctive enough to populate trackingNumber.
		// Admin review is the safety net.
		expect(result.trackingNumber).toBe('1Z999AA10123456784');
		expect(result.carrier).toBe('UPS');
		expect(result.confidence).toBe('high');
	});

	it('Multi-tracking email (two UPS numbers) → confidence low', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Your shipment',
				from: 'pkginfo@ups.com',
				bodyText:
					'Package 1: 1Z999AA10123456784. Package 2: 1Z999AA10987654321. Both shipped today.'
			})
		);
		expect(result.trackingNumber).toBe('1Z999AA10123456784');
		expect(result.confidence).toBe('low');
	});

	it('Mixed-numbers email (order# + tracking#) → resolves cleanly', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Your order has shipped',
				from: 'orders@mybrand.com',
				bodyText:
					'Order #ABC-12345 has shipped via UPS! Tracking: 1Z999AA10123456784. Visit ups.com to track.'
			})
		);
		expect(result.trackingNumber).toBe('1Z999AA10123456784');
		expect(result.carrier).toBe('UPS');
		expect(result.orderId).toBe('ABC-12345');
		expect(result.senderDomain).toBe('mybrand.com');
	});

	it('Empty / no-tracking email → trackingNumber null', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Shipping policy update',
				from: 'help@randombrand.com',
				bodyText: 'We have updated our shipping policy. Standard delivery now takes 3-5 days.'
			})
		);
		expect(result.trackingNumber).toBeNull();
		expect(result.carrier).toBeNull();
		expect(result.emailType).toBe('tracking_only');
	});

	// ------------------------------------------------------------------
	// td-c28c5e: order-confirmation intent

	it('Transparent Labs "Order #3613899 confirmed" → order_confirmation', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Order #3613899 confirmed',
				from: 'Transparent Labs <noreply@transparentlabs.com>',
				bodyText: 'Thank you for your purchase! ORDER #3613899 — 1 item. Visit our store.'
			})
		);
		expect(result.emailType).toBe('order_confirmation');
		expect(result.trackingNumber).toBeNull();
		expect(result.orderId).toBe('3613899');
		expect(result.merchant).toBe('Transparent Labs');
		expect(result.title).toBe('Order #3613899 confirmed');
		expect(result.confidence).toBe('low');
	});

	it('Best Buy "Order Number BBY01-..." → order_confirmation', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Thanks for your Best Buy order',
				from: 'BestBuyInfo@emailinfo.bestbuy.com',
				bodyText: 'Order Number: BBY01-806783654321. We will email you when it ships.'
			})
		);
		expect(result.emailType).toBe('order_confirmation');
		expect(result.orderId).toBe('BBY01-806783654321');
	});

	it('UPS shipment with "Order #12345" in body → tracking_only (carrier wins)', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'UPS shipment notification',
				from: 'pkginfo@ups.com',
				bodyText: 'Your Order #12345 has shipped. Tracking: 1Z999AA10123456784.'
			})
		);
		expect(result.emailType).toBe('tracking_only');
		expect(result.trackingNumber).toBe('1Z999AA10123456784');
		expect(result.orderId).toBe('12345');
	});

	it('Marketing fluff "Order our newsletter" → no order match, falls through unknown', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Discover our newest flavors',
				from: 'hello@brand.com',
				bodyText: 'Order our latest snacks today and save big!'
			})
		);
		// Strict detector requires a marker after "order"; "Order our" has none.
		expect(result.emailType).toBe('tracking_only');
		expect(result.trackingNumber).toBeNull();
		expect(result.orderId).toBeNull();
	});

	it('Order-confirmation merchant extraction without display name → local-part fallback', () => {
		const result = parseShipmentEmail(
			msg({
				subject: 'Your order',
				from: 'orders@circupool.com',
				bodyText: 'Thank you for your order. Order #: ABC-99887.'
			})
		);
		expect(result.emailType).toBe('order_confirmation');
		expect(result.merchant).toBe('orders');
		expect(result.orderId).toBe('ABC-99887');
	});
});
