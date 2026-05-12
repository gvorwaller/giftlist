/**
 * td-b221ae: Amazon Logistics tracking module.
 *
 * Shippo can't track Amazon Logistics packages — their tracking IDs match
 * `TBA\d{12}` and Shippo has no carrier slug for them. We fall back to
 * Amazon's own (undocumented, unauthenticated) public tracker endpoints.
 *
 * This module is deliberately best-effort:
 *   - One shot per call, no retries.
 *   - 8s hard timeout via AbortSignal.timeout.
 *   - All parsing wrapped in try/catch — a miss returns an all-null result
 *     and never throws. Callers surface "all-null" as a soft UX note
 *     ("open the Amazon tracker for live status") rather than an error.
 *   - Tracker page is a SPA; the static HTML body rarely contains status
 *     text directly. We try the JSON endpoint first, then fall back to
 *     coarse HTML pattern matching. Either may return nothing.
 *
 * No anti-bot evasion. No cookie handling. No headless browser. If Amazon
 * ever locks this down further the module will simply return all-null and
 * the user's still got the "Open Amazon tracking" deep-link button in the
 * UI to manually check.
 */

export interface AmazonTrackerResult {
	/** Normalised status: 'DELIVERED' | 'OUT_FOR_DELIVERY' | 'TRANSIT' | 'UNKNOWN' | null */
	status: string | null;
	/** ISO timestamp of the status fetch (now() when status present). */
	statusAt: string | null;
	/** Best-effort ETA (free-text or ISO date — exact format varies by response). */
	estimatedDelivery: string | null;
	/** Raw status text Amazon used, for diagnostics. */
	rawStatusText: string | null;
}

const EMPTY: AmazonTrackerResult = {
	status: null,
	statusAt: null,
	estimatedDelivery: null,
	rawStatusText: null
};

export function isAmazonLogisticsTracking(
	trackingNumber: string | null | undefined
): boolean {
	return !!trackingNumber && /^TBA\d{12}$/i.test(trackingNumber.trim());
}

/**
 * Pull a five-digit US ZIP code out of a stored shipping_address string.
 * Best-effort — captures the *last* 5-digit run in the string to avoid
 * grabbing a building number that happens to be 5 digits. Returns null
 * when nothing matches.
 */
export function recipientZipFrom(address: string | null | undefined): string | null {
	if (!address) return null;
	const matches = address.match(/\b(\d{5})(?:-\d{4})?\b/g);
	if (!matches || matches.length === 0) return null;
	const last = matches[matches.length - 1];
	return last.slice(0, 5);
}

const REALISTIC_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function normaliseStatusText(raw: string | null): {
	status: string | null;
	rawStatusText: string | null;
} {
	if (!raw) return { status: null, rawStatusText: null };
	const trimmed = raw.replace(/\s+/g, ' ').trim();
	if (!trimmed) return { status: null, rawStatusText: null };
	const lower = trimmed.toLowerCase();
	let status: string;
	if (/\bdelivered\b/.test(lower)) status = 'DELIVERED';
	else if (/\bout for delivery\b/.test(lower)) status = 'OUT_FOR_DELIVERY';
	else if (/\b(in transit|on the way|shipped|on its way|arriving)\b/.test(lower)) status = 'TRANSIT';
	else status = 'UNKNOWN';
	return { status, rawStatusText: trimmed.slice(0, 200) };
}

interface AmazonJsonResponse {
	progressTracker?: {
		summary?: {
			status?: string;
			deliveryDate?: string | { startDateTime?: string; endDateTime?: string };
		};
	};
	deliveryProgress?: { summary?: { status?: string } };
	deliveryDateMessage?: { primary?: { value?: string } };
}

function extractFromJson(data: unknown): {
	status: string | null;
	rawStatusText: string | null;
	estimatedDelivery: string | null;
} {
	if (!data || typeof data !== 'object') {
		return { status: null, rawStatusText: null, estimatedDelivery: null };
	}
	const j = data as AmazonJsonResponse;
	// Amazon's progress-tracker JSON shape isn't documented and varies. Probe a
	// few likely locations and accept any string we find as the rawStatusText.
	let rawStatus: string | null = null;
	if (j.progressTracker?.summary?.status) rawStatus = j.progressTracker.summary.status;
	else if (j.deliveryProgress?.summary?.status) rawStatus = j.deliveryProgress.summary.status;
	else if (j.deliveryDateMessage?.primary?.value) rawStatus = j.deliveryDateMessage.primary.value;

	let eta: string | null = null;
	const dd = j.progressTracker?.summary?.deliveryDate;
	if (typeof dd === 'string') eta = dd;
	else if (dd && typeof dd === 'object') {
		eta = dd.endDateTime ?? dd.startDateTime ?? null;
	}

	const { status, rawStatusText } = normaliseStatusText(rawStatus);
	return { status, rawStatusText, estimatedDelivery: eta };
}

function extractFromHtml(html: string): {
	status: string | null;
	rawStatusText: string | null;
	estimatedDelivery: string | null;
} {
	// SPA shells rarely carry status text, but some responses inline an initial
	// state object via <script> tags. We scan for the obvious keywords and
	// accept the first hit.
	const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	const statusMatch =
		text.match(/\b(Delivered)\b[^.]{0,80}/i) ??
		text.match(/\b(Out for delivery)\b[^.]{0,80}/i) ??
		text.match(/\b(Arriving[^.]{0,40})/i) ??
		text.match(/\b(On the way|In transit|Shipped)\b[^.]{0,80}/i);
	const raw = statusMatch ? statusMatch[0] : null;
	const { status, rawStatusText } = normaliseStatusText(raw);

	// "Arriving Wednesday" / "Arriving Sep 23" — keep the noun phrase as eta.
	const etaMatch = text.match(/Arriving\s+([A-Z][a-z]+(?:\s+\d{1,2})?)/);
	const eta = etaMatch ? etaMatch[0].replace(/^Arriving\s+/i, '') : null;

	return { status, rawStatusText, estimatedDelivery: eta };
}

export async function fetchAmazonTracking(
	trackingNumber: string,
	destinationZip?: string | null
): Promise<AmazonTrackerResult> {
	const tba = trackingNumber.trim().toUpperCase();
	if (!isAmazonLogisticsTracking(tba)) return EMPTY;

	const zipParam = destinationZip ? `?destinationZip=${encodeURIComponent(destinationZip)}` : '';
	const url = `https://track.amazon.com/tracking/${encodeURIComponent(tba)}${zipParam}`;

	let html: string;
	try {
		const res = await fetch(url, {
			method: 'GET',
			redirect: 'follow',
			signal: AbortSignal.timeout(8000),
			headers: {
				'User-Agent': REALISTIC_UA,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9'
			}
		});
		if (!res.ok) return EMPTY;
		html = await res.text();
	} catch {
		return EMPTY;
	}

	// First pass: look for an inline JSON blob in the HTML. Amazon's SPA
	// sometimes embeds initial state as `window.__INITIAL_STATE__ = {...}` or
	// similar. Best-effort search for a plausible JSON object containing a
	// "deliveryDate" or "status" key.
	const jsonBlob = html.match(
		/(\{[^{}]*?"(?:deliveryDate|status|deliveryProgress|progressTracker)"[\s\S]{1,4000}\})/
	);
	if (jsonBlob) {
		try {
			const data = JSON.parse(jsonBlob[1]);
			const fromJson = extractFromJson(data);
			if (fromJson.status) {
				return {
					status: fromJson.status,
					statusAt: new Date().toISOString(),
					estimatedDelivery: fromJson.estimatedDelivery,
					rawStatusText: fromJson.rawStatusText
				};
			}
		} catch {
			/* JSON-shaped match wasn't actually JSON — fall through to HTML scrape. */
		}
	}

	const fromHtml = extractFromHtml(html);
	if (!fromHtml.status) return EMPTY;
	return {
		status: fromHtml.status,
		statusAt: new Date().toISOString(),
		estimatedDelivery: fromHtml.estimatedDelivery,
		rawStatusText: fromHtml.rawStatusText
	};
}
