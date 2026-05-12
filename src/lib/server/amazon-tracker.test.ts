import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	fetchAmazonTracking,
	isAmazonLogisticsTracking,
	recipientZipFrom
} from './amazon-tracker';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('isAmazonLogisticsTracking', () => {
	it('matches TBA + 12 digits', () => {
		expect(isAmazonLogisticsTracking('TBA303123456789')).toBe(true);
		expect(isAmazonLogisticsTracking('  TBA303123456789  ')).toBe(true);
		expect(isAmazonLogisticsTracking('tba303123456789')).toBe(true);
	});
	it('rejects non-TBA tracking shapes', () => {
		expect(isAmazonLogisticsTracking('1Z999AA10123456784')).toBe(false);
		expect(isAmazonLogisticsTracking('9400111899560123456789')).toBe(false);
		expect(isAmazonLogisticsTracking('TBA12345')).toBe(false);
		expect(isAmazonLogisticsTracking('')).toBe(false);
		expect(isAmazonLogisticsTracking(null)).toBe(false);
		expect(isAmazonLogisticsTracking(undefined)).toBe(false);
	});
});

describe('recipientZipFrom', () => {
	it('pulls a 5-digit ZIP', () => {
		expect(recipientZipFrom('123 Main St, Springfield, IL 62701')).toBe('62701');
	});
	it('handles ZIP+4 by trimming the +4', () => {
		expect(recipientZipFrom('123 Main St, Springfield, IL 62701-1234')).toBe('62701');
	});
	it('prefers the last 5-digit run', () => {
		expect(recipientZipFrom('42100 Apt 7, Springfield, IL 62701')).toBe('62701');
	});
	it('returns null when no ZIP is present', () => {
		expect(recipientZipFrom('123 Main St')).toBeNull();
		expect(recipientZipFrom(null)).toBeNull();
		expect(recipientZipFrom('')).toBeNull();
	});
});

describe('fetchAmazonTracking', () => {
	it('returns all-null on non-TBA input without calling fetch', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		const result = await fetchAmazonTracking('1Z999AA10123456784');
		expect(result.status).toBeNull();
		expect(result.statusAt).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});

	it('returns all-null on HTTP failure', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('not found', { status: 404 })
		);
		const result = await fetchAmazonTracking('TBA303123456789');
		expect(result.status).toBeNull();
		expect(result.statusAt).toBeNull();
	});

	it('returns all-null when fetch throws (timeout/network)', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('aborted'));
		const result = await fetchAmazonTracking('TBA303123456789');
		expect(result.status).toBeNull();
	});

	it('extracts DELIVERED from a coarse HTML body', async () => {
		const html = `
			<html><body>
				<header>...</header>
				<main>
					<h1>Delivered today</h1>
					<p>Your package was delivered to the front door.</p>
				</main>
			</body></html>
		`;
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(html, { status: 200 })
		);
		const result = await fetchAmazonTracking('TBA303123456789');
		expect(result.status).toBe('DELIVERED');
		expect(result.rawStatusText?.toLowerCase()).toContain('delivered');
		expect(result.statusAt).not.toBeNull();
	});

	it('extracts TRANSIT + ETA from "Arriving Wednesday"', async () => {
		const html = `<div>Arriving Wednesday</div><span>Status update pending.</span>`;
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(html, { status: 200 })
		);
		const result = await fetchAmazonTracking('TBA303123456789');
		expect(result.status).toBe('TRANSIT');
		expect(result.estimatedDelivery).toBe('Wednesday');
	});

	it('extracts from an inline JSON blob when present', async () => {
		const blob = JSON.stringify({
			progressTracker: { summary: { status: 'Out for delivery', deliveryDate: '2026-05-12' } }
		});
		const html = `<html><script>window.STATE = ${blob};</script></html>`;
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(html, { status: 200 })
		);
		const result = await fetchAmazonTracking('TBA303123456789');
		expect(result.status).toBe('OUT_FOR_DELIVERY');
		expect(result.estimatedDelivery).toBe('2026-05-12');
	});
});
