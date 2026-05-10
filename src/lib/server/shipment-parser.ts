import type { GmailMessageFull } from './gmail-reader';

/**
 * Parser for non-Amazon shipment-confirmation emails (td-61017c).
 * Lighter than the Amazon parser — carriers' shipment emails are mostly
 * just tracking#. We extract the tracking number, identify the carrier,
 * and best-effort extract an order#/merchant for downstream matching.
 *
 * The regex catalog uses sender-domain gating for the families that
 * false-positive on numeric noise (FedEx 12/15-digit, DHL 10-digit,
 * Canada Post 16-digit). The amazon-parser.ts:128-137 documentation
 * captures the lessons learned about bare-numeric tracking patterns.
 */

export type ShipmentCarrier = 'UPS' | 'USPS' | 'FedEx' | 'DHL' | 'Amazon' | 'OnTrac' | 'Lasership' | 'Canada Post';

export interface ParsedShipment {
	/**
	 * tracking_only — carrier shipment confirmation with a parsed tracking#.
	 * order_confirmation — merchant order email with no tracking# but a strict
	 *   "Order #…" / "Order number …" marker. Stages as pending so admin can
	 *   create a status='ordered' self-package without Shippo registration;
	 *   the eventual shipment email upgrades the gift via order_id match.
	 */
	emailType: 'tracking_only' | 'order_confirmation';
	trackingNumber: string | null;
	carrier: ShipmentCarrier | null;
	/** Slug aligned with shippers.tracking_provider_slug for Shippo registration. */
	carrierSlug: string | null;
	/** Best-effort merchant order# (vendor-supplied, not the carrier's). */
	orderId: string | null;
	/** Sender domain (e.g. "ups.com"). Used for order_id-match constraint. */
	senderDomain: string | null;
	/** Display name from From: header, or local-part fallback. Used as title hint. */
	merchant: string | null;
	title: string | null;
	confidence: 'high' | 'low';
}

const CARRIER_TO_SLUG: Record<ShipmentCarrier, string> = {
	UPS: 'ups',
	USPS: 'usps',
	FedEx: 'fedex',
	DHL: 'dhl_express',
	Amazon: 'amazon',
	OnTrac: 'ontrac',
	Lasership: 'lasership',
	'Canada Post': 'canada_post'
};

function extractMerchantFromFrom(from: string | null): string | null {
	// "Transparent Labs <noreply@…>" → "Transparent Labs"
	// "noreply@brand.com" → "noreply" (last-resort fallback)
	if (!from) return null;
	const trimmed = from.trim();
	const displayMatch = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
	if (displayMatch && displayMatch[1].trim()) return displayMatch[1].trim();
	const local = trimmed.match(/^([^@\s<]+)@/);
	if (local) return local[1];
	return null;
}

/**
 * Strict order-confirmation detector. Requires an explicit marker (#, "number",
 * "no", ":") between "order" and the captured value — looser than this would
 * pull from prose like "Order our newsletter today".
 *
 * Returns the captured order# string, or null. Never returns a value that
 * looks like a known carrier tracking#.
 */
function detectOrderConfirmationId(body: string, subject: string): string | null {
	const haystack = `${subject}\n${body}`;
	// Marker is required (#, "number", "no", or ":"); a trailing punctuation
	// like "Order Number: BBY01-…" or "Order #: ABC-…" is also tolerated.
	const re = /\border\s*(?:#|number|no\.?|:)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,30})/gi;
	for (const m of haystack.matchAll(re)) {
		const candidate = m[1].trim();
		if (/^1Z[A-Z0-9]{16}$/i.test(candidate)) continue;
		if (/^TBA\d{12}$/i.test(candidate)) continue;
		return candidate;
	}
	return null;
}

function extractSenderDomain(from: string | null): string | null {
	if (!from) return null;
	const m = from.match(/<([^@>]+@([^>]+))>/) ?? from.match(/([^\s<@]+@([^\s>]+))/);
	if (!m) return null;
	const domain = (m[2] ?? '').trim().toLowerCase();
	return domain || null;
}

function senderMatches(senderDomain: string | null, suffix: string): boolean {
	if (!senderDomain) return false;
	return senderDomain === suffix || senderDomain.endsWith('.' + suffix);
}

function bodyContainsCarrierUrl(body: string, host: string): boolean {
	// Look for href-like patterns referencing the carrier's tracking host.
	// Matches "ups.com/", "fedex.com/fedextrack", etc. Loose by design — a
	// false positive only graduates a "low" confidence row to "high"; the
	// admin still gates the registration.
	const re = new RegExp('\\b' + host.replace(/\./g, '\\.'), 'i');
	return re.test(body);
}

interface CarrierHit {
	carrier: ShipmentCarrier;
	tracking: string;
}

/**
 * Walks the regex catalog in priority order and returns the first
 * tracking-number hit. Distinctive patterns (UPS 1Z…, USPS 9[1-5]\d{20})
 * match anywhere; ambiguous numeric patterns (FedEx, DHL, Canada Post)
 * require sender-domain or carrier-URL evidence to fire.
 */
function detectTracking(
	body: string,
	subject: string,
	senderDomain: string | null
): CarrierHit | null {
	const haystack = `${subject}\n${body}`;

	// 1. UPS — 1Z + 16 chars. Very distinctive.
	const ups = haystack.match(/\b1Z[A-Z0-9]{16}\b/);
	if (ups) return { carrier: 'UPS', tracking: ups[0] };

	// 2. USPS domestic 22-digit (prefixes 91-95 per USPS published forms).
	const usps22 = haystack.match(/\b9[1-5]\d{20}\b/);
	if (usps22) return { carrier: 'USPS', tracking: usps22[0] };

	// 3. USPS GXG 10-digit (82xxxxxxxx).
	const uspsGxg = haystack.match(/\b82\d{8}\b/);
	if (uspsGxg) return { carrier: 'USPS', tracking: uspsGxg[0] };

	// 4. USPS Intl S10 — two letters + 9 digits + US.
	const uspsIntl = haystack.match(/\b[A-Z]{2}\d{9}US\b/);
	if (uspsIntl) return { carrier: 'USPS', tracking: uspsIntl[0] };

	// 5. Amazon Logistics — TBA + 12 digits. Distinctive.
	const amazonLog = haystack.match(/\bTBA\d{12}\b/);
	if (amazonLog) return { carrier: 'Amazon', tracking: amazonLog[0] };

	// 6. OnTrac — C + 14 digits.
	const ontrac = haystack.match(/\bC\d{14}\b/);
	if (ontrac) return { carrier: 'OnTrac', tracking: ontrac[0] };

	// 7. Lasership — sender-gated since the prefix isn't unique.
	if (senderMatches(senderDomain, 'lasership.com') || bodyContainsCarrierUrl(body, 'lasership.com')) {
		const lasership = haystack.match(/\bL[A-Z0-9]{10,15}\b/);
		if (lasership) return { carrier: 'Lasership', tracking: lasership[0] };
	}

	// 8. Canada Post — 16-digit, sender-gated.
	if (senderMatches(senderDomain, 'canadapost.ca') || bodyContainsCarrierUrl(body, 'canadapost.ca')) {
		const cpost = haystack.match(/\b\d{16}\b/);
		if (cpost) return { carrier: 'Canada Post', tracking: cpost[0] };
	}

	// 9. FedEx — 12 or 15 digit, sender-gated. Order matters: 15 first so
	//    we don't truncate to the first 12 digits of a 15-digit number.
	if (senderMatches(senderDomain, 'fedex.com') || bodyContainsCarrierUrl(body, 'fedex.com')) {
		const fedex15 = haystack.match(/\b\d{15}\b/);
		if (fedex15) return { carrier: 'FedEx', tracking: fedex15[0] };
		const fedex12 = haystack.match(/\b\d{12}\b/);
		if (fedex12) return { carrier: 'FedEx', tracking: fedex12[0] };
	}

	// 10. DHL — 10-digit, sender-gated.
	if (senderMatches(senderDomain, 'dhl.com') || bodyContainsCarrierUrl(body, 'dhl.com')) {
		const dhl = haystack.match(/\b\d{10}\b/);
		if (dhl) return { carrier: 'DHL', tracking: dhl[0] };
	}

	return null;
}

function detectMultipleTracking(
	body: string,
	subject: string,
	senderDomain: string | null
): boolean {
	// Quick "is there more than one?" check — if multiple distinctive
	// tracking patterns appear, mark confidence as 'low' so admin can
	// split manually. We only check the distinctive families (UPS, USPS,
	// Amazon Logistics, OnTrac) since the gated families need the sender
	// match and would produce the same tracking# anyway.
	const haystack = `${subject}\n${body}`;
	const all: string[] = [];
	for (const re of [
		/\b1Z[A-Z0-9]{16}\b/g,
		/\b9[1-5]\d{20}\b/g,
		/\bTBA\d{12}\b/g,
		/\bC\d{14}\b/g
	]) {
		const matches = haystack.match(re);
		if (matches) all.push(...matches);
	}
	const unique = new Set(all);
	return unique.size > 1;
}

function extractOrderId(body: string): string | null {
	// Best-effort: "Order #ABC123", "Order: 12345", "Order Number: ...".
	// Capture alphanumerics + dashes, length 4-30. Conservative on length
	// to avoid grabbing unrelated long strings.
	const patterns = [
		/order\s*(?:#|number|no\.?|id)?\s*[:#]?\s*([A-Z0-9-]{4,30})/i,
		/\border\s+([A-Z0-9-]{4,30})\b/i,
		/\b#([A-Z0-9-]{6,30})\b/
	];
	for (const re of patterns) {
		const m = body.match(re);
		if (m && m[1]) {
			const candidate = m[1].trim();
			// Reject if it's a known carrier-shape — we don't want the
			// tracking# leaking back into orderId.
			if (/^1Z[A-Z0-9]{16}$/i.test(candidate)) continue;
			if (/^TBA\d{12}$/i.test(candidate)) continue;
			return candidate;
		}
	}
	return null;
}

export function parseShipmentEmail(msg: GmailMessageFull): ParsedShipment {
	const subject = (msg.subject ?? '').trim();
	const body = msg.bodyText || '';
	const senderDomain = extractSenderDomain(msg.from);
	const merchant = extractMerchantFromFrom(msg.from);

	const hit = detectTracking(body, subject, senderDomain);
	const multi = hit ? detectMultipleTracking(body, subject, senderDomain) : false;
	const looseOrderId = extractOrderId(body);

	const carrier = hit?.carrier ?? null;
	const carrierSlug = carrier ? CARRIER_TO_SLUG[carrier] : null;

	let confidence: 'high' | 'low' = 'low';
	if (hit) {
		// Distinctive carriers OR sender-domain confirmation → high.
		// Bare regex hit on phishing-shaped email also rates high (the UPS
		// regex is distinctive enough to trust); admin review is the final
		// safety net.
		confidence = 'high';
		if (multi) confidence = 'low';
	}

	if (hit) {
		return {
			emailType: 'tracking_only',
			trackingNumber: hit.tracking,
			carrier,
			carrierSlug,
			orderId: looseOrderId,
			senderDomain,
			merchant,
			title: subject || null,
			confidence
		};
	}

	// No tracking#. Try order-confirmation intent with the strict detector.
	const strictOrderId = detectOrderConfirmationId(body, subject);
	if (strictOrderId) {
		return {
			emailType: 'order_confirmation',
			trackingNumber: null,
			carrier: null,
			carrierSlug: null,
			orderId: strictOrderId,
			senderDomain,
			merchant,
			title: subject || null,
			confidence: 'low'
		};
	}

	// Neither tracking# nor strict order# — falls through as tracking_only
	// with everything null so the scan disposition routes it to Failed.
	return {
		emailType: 'tracking_only',
		trackingNumber: null,
		carrier: null,
		carrierSlug: null,
		orderId: looseOrderId,
		senderDomain,
		merchant,
		title: subject || null,
		confidence: 'low'
	};
}
