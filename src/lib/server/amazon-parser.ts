import type { EmailType } from './types';
import type { GmailMessageFull } from './gmail-reader';

/**
 * v1 Amazon parser: subject-based classification + body regex extraction.
 * Intentionally conservative — bails to `unknown` when anything is ambiguous,
 * and classifies marketing/review-request emails separately so the admin
 * review UI can batch-skip them.
 *
 * We iterate this module against real email samples collected in
 * Giftlist/Amazon/Inbox during Phase 4 verification.
 */

export interface ParsedAmazonEmail {
	emailType: EmailType;
	title: string | null;
	orderId: string | null;
	priceCents: number | null;
	trackingNumber: string | null;
	carrier: string | null;
	recipientName: string | null;
	shippingAddress: string | null;
	giftMessage: string | null;
	/**
	 * td-b221ae: "Track package" CTA URL parsed from shipped/delivered emails.
	 * Stored on the gift so /app/gifts/[id] can offer a tap-target into the
	 * Amazon tracker, especially when the email didn't expose a carrier
	 * tracking number (the Amazon Logistics TBA case). Populated only for
	 * `shipped` and `delivered` email types.
	 */
	trackingUrl: string | null;
}

const MARKETING_SUBJECT_HINTS = [
	/^how about another look/i,
	/^your personalized deal/i,
	/^today'?s deals/i,
	/deals? are here/i,
	/lightning deals/i,
	/save(\s+up\s+to)?\s+\$/i,
	/discreet.*health care/i,
	/limited[- ]time offer/i,
	/recommended for you/i,
	/\bprime day\b/i,
	/shop .* now/i
];

const REVIEW_SUBJECT_HINTS = [
	/review it on amazon/i,
	/meet your expectations/i,
	/share your experience/i,
	/rate your recent/i
];

const ORDERED_SUBJECT = /^(?:your )?(?:amazon(?:\.com)? )?order (?:has been )?placed/i;
const ORDERED_COLON = /^ordered:\s+"?(.+?)"?\s*$/i;
const SHIPPED = /^shipped:\s+"?(.+?)"?\s*$/i;
const SHIPPED_WORDY = /(has been|was)\s+shipped/i;
const DELIVERED = /^delivered:\s+"?(.+?)"?\s*$/i;
const DELIVERED_WORDY = /your .*package .*delivered|was delivered/i;

function classify(subject: string): EmailType {
	const s = subject.trim();
	if (!s) return 'unknown';

	if (ORDERED_COLON.test(s) || ORDERED_SUBJECT.test(s)) return 'order_placed';
	if (SHIPPED.test(s) || SHIPPED_WORDY.test(s)) return 'shipped';
	if (DELIVERED.test(s) || DELIVERED_WORDY.test(s)) return 'delivered';

	for (const re of REVIEW_SUBJECT_HINTS) if (re.test(s)) return 'review_request';
	for (const re of MARKETING_SUBJECT_HINTS) if (re.test(s)) return 'marketing';

	return 'unknown';
}

function extractTitleFromSubject(subject: string): string | null {
	const m =
		subject.match(ORDERED_COLON) ?? subject.match(SHIPPED) ?? subject.match(DELIVERED);
	if (m && m[1]) {
		return m[1].replace(/"$/, '').replace(/^"/, '').trim();
	}
	return null;
}

function extractTitleFromBody(body: string): string | null {
	// Modern Amazon emails put item lines as `* <title>\n  Quantity: N\n  $X USD`
	// bullets. The full title here isn't ellipsis-truncated like the subject is,
	// so it's strictly better for downstream gift matching.
	const m = body.match(/^\*\s+([^\n]{5,500})\n\s+Quantity:\s*\d+/m);
	if (!m) return null;
	return m[1].replace(/\s+/g, ' ').trim();
}

function extractOrderId(body: string): string | null {
	// Amazon order numbers look like 123-4567890-1234567.
	const m = body.match(/\b\d{3}-\d{7}-\d{7}\b/);
	return m ? m[0] : null;
}

function extractPriceCents(body: string): number | null {
	// Prefer the explicit "Order total" / "Total before tax" / "Grand Total" line.
	const patterns = [
		/(?:order total|grand total|total charged)[:\s]*\$?([0-9]+(?:\.[0-9]{2}))/i,
		/total (?:for this order)?[:\s]*\$?([0-9]+(?:\.[0-9]{2}))/i,
		/\bitem total[:\s]*\$?([0-9]+(?:\.[0-9]{2}))/i
	];
	for (const p of patterns) {
		const m = body.match(p);
		if (m) return Math.round(parseFloat(m[1]) * 100);
	}
	// Fallback: first standalone $XX.XX in first 2KB.
	const first = body.slice(0, 2048).match(/\$([0-9]+(?:\.[0-9]{2}))/);
	if (first) return Math.round(parseFloat(first[1]) * 100);
	return null;
}

function extractTracking(body: string): { tracking: string | null; carrier: string | null } {
	// 1) Explicit "Tracking ID/Number/#: <id>" label — older Amazon templates.
	const idMatch = body.match(/tracking (?:id|number|#)[:\s]*([A-Z0-9\-]{6,40})/i);
	if (idMatch) {
		const tracking = idMatch[1];
		return { tracking, carrier: extractCarrier(body, tracking) };
	}

	// 2) Carrier tracking URL params — modern shipped emails embed real
	// carrier IDs as query strings on the Track-package CTA. We deliberately
	// skip Amazon's internal `shipmentId=` because it's not pasteable into
	// any carrier site, so it would mislead the user.
	const usps = body.match(/[?&]q?tc_?tLabels1?=([0-9A-Z]{15,30})/i);
	if (usps) return { tracking: usps[1], carrier: 'USPS' };
	const ups = body.match(
		/[?&](?:tracknum|InquiryNumber1?|track(?:ing)?Number)=(1Z[A-Z0-9]{16})/i
	);
	if (ups) return { tracking: ups[1], carrier: 'UPS' };
	const fedex = body.match(/[?&](?:tracknumbers?|trknbr)=([0-9]{12,15})/i);
	if (fedex) return { tracking: fedex[1], carrier: 'FedEx' };

	// 3) Bare carrier-shaped IDs anywhere in the body. UPS = 1Z + 16 chars and
	// USPS = leading 9 + 15-21 digits are distinctive enough to be safe. We
	// deliberately do *not* fall back to bare 12-15-digit FedEx — that pattern
	// false-positives on prices, order subtotals, and other numeric noise.
	const upsBare = body.match(/\b1Z[A-Z0-9]{16}\b/);
	if (upsBare) return { tracking: upsBare[0], carrier: 'UPS' };
	const uspsBare = body.match(/\b9[0-9]{15,21}\b/);
	if (uspsBare) return { tracking: uspsBare[0], carrier: 'USPS' };

	return { tracking: null, carrier: null };
}

function extractCarrier(body: string, tracking: string | null): string | null {
	if (tracking) {
		// UPS: 1Z… USPS: 9XXX… FedEx: 12–15 digits.
		if (/^1Z[A-Z0-9]{16}$/i.test(tracking)) return 'UPS';
		if (/^9[0-9]{15,21}$/.test(tracking)) return 'USPS';
		if (/^\d{12,15}$/.test(tracking)) return 'FedEx';
	}
	const m = body.match(/\b(USPS|UPS|FedEx|DHL|Amazon Logistics|Lasership|OnTrac)\b/i);
	return m ? m[1] : null;
}

function extractShippingAddress(body: string): string | null {
	// Amazon confirmations typically include "Shipping Address" followed by the
	// recipient name and multi-line address block. We capture up to ~6 short lines.
	const anchor = body.match(/shipping address[:\s]*([\s\S]{0,400})/i);
	if (!anchor) return null;
	const raw = anchor[1]
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (raw.length === 0) return null;
	// Stop when we hit a section header again.
	const lines: string[] = [];
	for (const l of raw) {
		if (/^(order summary|payment|shipping speed|total|items ordered)/i.test(l)) break;
		lines.push(l);
		if (lines.length >= 6) break;
	}
	const joined = lines.join(', ');
	return joined.length > 0 ? joined : null;
}

function extractRecipientName(body: string, shippingAddress: string | null): string | null {
	// First line of the shipping block is usually the recipient name.
	if (shippingAddress) {
		const firstLine = shippingAddress.split(',')[0]?.trim();
		if (firstLine && /^[A-Z][A-Za-z .'-]+(\s+[A-Z][A-Za-z .'-]+)+$/.test(firstLine)) {
			return firstLine;
		}
	}
	// Fallback: "shipping to <Name>" pattern.
	const m = body.match(/shipping to\s+([A-Z][A-Za-z .'-]+(?:\s+[A-Z][A-Za-z .'-]+)+)/i);
	return m ? m[1].trim() : null;
}

/**
 * td-b221ae: extract the "Track package" CTA URL from a shipped/delivered email.
 *
 * Amazon's HTML body wraps the button as an anchor; the text alternative
 * often omits the href. We prefer HTML, fall back to text, decode HTML
 * entities + Gmail redirect wrappers, and only accept Amazon-hosted URLs so
 * we don't store unrelated promo or pixel-tracking links.
 */
const AMAZON_HREF_PATTERNS: RegExp[] = [
	// Modern progress-tracker deep link.
	/href=["'](https?:\/\/(?:www\.)?amazon\.com\/[^"'<>\s]*progress-tracker[^"'<>\s]*)["']/i,
	// ship-track / your-account legacy.
	/href=["'](https?:\/\/(?:www\.)?amazon\.com\/[^"'<>\s]*(?:gp\/your-account\/ship-track|ship-track)[^"'<>\s]*)["']/i,
	// Public Amazon Logistics tracker.
	/href=["'](https?:\/\/track\.amazon\.com\/[^"'<>\s]*)["']/i,
	// Gmail-rewritten outbound link that wraps an Amazon URL in the q= param.
	// We unwrap it before the host check so it has to mention amazon somewhere
	// in the wrapper to avoid false positives on other Google-redirected links.
	/href=["'](https?:\/\/(?:www\.)?google\.com\/url\?[^"'<>\s]*amazon[^"'<>\s]*)["']/i
];

const AMAZON_BARE_URL_PATTERNS: RegExp[] = [
	/(https?:\/\/(?:www\.)?amazon\.com\/[^\s<>"']*progress-tracker[^\s<>"']*)/i,
	/(https?:\/\/(?:www\.)?amazon\.com\/[^\s<>"']*(?:gp\/your-account\/ship-track|ship-track)[^\s<>"']*)/i,
	/(https?:\/\/track\.amazon\.com\/[^\s<>"']*)/i
];

function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&#x2F;/gi, '/')
		.replace(/&#47;/g, '/')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function unwrapGmailRedirect(url: string): string {
	// Gmail rewrites outbound links as https://www.google.com/url?...&q=ENCODED
	const m = url.match(/^https?:\/\/(?:www\.)?google\.com\/url\?[^"'<>\s]*[?&]q=([^&"'<>\s]+)/i);
	if (!m) return url;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return url;
	}
}

function looksLikeAmazonHost(url: string): boolean {
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();
		return (
			host === 'amazon.com' ||
			host.endsWith('.amazon.com') ||
			host === 'track.amazon.com' ||
			host === 'a.co'
		);
	} catch {
		return false;
	}
}

export function extractAmazonTrackingUrl(
	bodyHtml: string | null | undefined,
	bodyText: string | null | undefined
): string | null {
	const html = bodyHtml || '';
	if (html) {
		for (const re of AMAZON_HREF_PATTERNS) {
			const m = html.match(re);
			if (m) {
				const raw = unwrapGmailRedirect(decodeHtmlEntities(m[1]));
				if (looksLikeAmazonHost(raw)) return raw;
			}
		}
		// HTML present but anchors didn't match — still scan for bare URLs as a
		// last-ditch effort (some Amazon templates render the link inline).
		for (const re of AMAZON_BARE_URL_PATTERNS) {
			const m = html.match(re);
			if (m) {
				const raw = unwrapGmailRedirect(decodeHtmlEntities(m[1]));
				if (looksLikeAmazonHost(raw)) return raw;
			}
		}
	}
	const text = bodyText || '';
	if (text) {
		for (const re of AMAZON_BARE_URL_PATTERNS) {
			const m = text.match(re);
			if (m) {
				const raw = unwrapGmailRedirect(m[1]);
				if (looksLikeAmazonHost(raw)) return raw;
			}
		}
	}
	return null;
}

function extractGiftMessage(body: string): string | null {
	// Amazon includes "Gift Message:" or "Gift message:" in order confirmations
	// when the order was marked as a gift.
	const m = body.match(/gift\s*message[:\s]*([^\n]{1,500})/i);
	if (!m) return null;
	return m[1].trim();
}

export function parseAmazonEmail(msg: GmailMessageFull): ParsedAmazonEmail {
	const subject = (msg.subject ?? '').trim();
	const emailType = classify(subject);
	const body = msg.bodyText || '';

	// For non-gift-relevant emails we still keep a stub record so the admin
	// UI can batch-skip/dispose of them without re-fetching.
	if (emailType === 'marketing' || emailType === 'review_request') {
		return {
			emailType,
			title: null,
			orderId: null,
			priceCents: null,
			trackingNumber: null,
			carrier: null,
			recipientName: null,
			shippingAddress: null,
			giftMessage: null,
			trackingUrl: null
		};
	}

	// Body bullet has the full untruncated title; subject is ellipsis-truncated.
	const title = extractTitleFromBody(body) ?? extractTitleFromSubject(subject);
	const orderId = extractOrderId(body);
	const priceCents = extractPriceCents(body);
	const { tracking, carrier } = extractTracking(body);
	const shippingAddress = extractShippingAddress(body);
	const recipientName = extractRecipientName(body, shippingAddress);
	const giftMessage = extractGiftMessage(body);

	// Only populate trackingUrl for shipped/delivered. order_placed emails
	// occasionally embed a placeholder link too but storing it on the gift
	// before the package actually ships causes the UI to surface a button
	// that 404s on Amazon's end.
	const trackingUrl =
		emailType === 'shipped' || emailType === 'delivered'
			? extractAmazonTrackingUrl(msg.bodyHtml, msg.bodyText)
			: null;

	return {
		emailType,
		title,
		orderId,
		priceCents,
		trackingNumber: tracking,
		carrier,
		recipientName,
		shippingAddress,
		giftMessage,
		trackingUrl
	};
}
