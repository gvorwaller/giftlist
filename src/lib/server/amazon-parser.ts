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
	// Amazon shipping emails include "Tracking ID: <id>" sometimes with carrier context.
	const idMatch = body.match(/tracking (?:id|number|#)[:\s]*([A-Z0-9\-]{6,40})/i);
	const tracking = idMatch ? idMatch[1] : null;
	const carrier = extractCarrier(body, tracking);
	return { tracking, carrier };
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
			giftMessage: null
		};
	}

	const title = extractTitleFromSubject(subject);
	const orderId = extractOrderId(body);
	const priceCents = extractPriceCents(body);
	const { tracking, carrier } = extractTracking(body);
	const shippingAddress = extractShippingAddress(body);
	const recipientName = extractRecipientName(body, shippingAddress);
	const giftMessage = extractGiftMessage(body);

	return {
		emailType,
		title,
		orderId,
		priceCents,
		trackingNumber: tracking,
		carrier,
		recipientName,
		shippingAddress,
		giftMessage
	};
}
