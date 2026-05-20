import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getDb } from './db';

/**
 * Wave 1 (post-Codex review): LLM-based matcher for Amazon email →
 * gift, and Amazon shipment → siblings. Replaces the prior
 * `matcher-llm.ts` (Haiku, weak-match-only, title-only context).
 *
 * Design tenets:
 * - LLM is the matcher, not a second opinion. The heuristic is now a
 *   candidate-shortlist ranker.
 * - Rich, structured context: full item array, candidates with person
 *   + occasion + notes + status, recipient hints, recent admin
 *   corrections as few-shot.
 * - Versioned cache key (mode + model + prompt_version + candidate
 *   ids + person ids + items fingerprint + recipient hint). Different
 *   prompt version → cache miss → re-evaluation. Different mode
 *   (import vs shipment) → separate cache entries.
 * - Structured output enforced via tool_use, never parsed from prose.
 * - `safe_to_apply` boolean for callers that mutate state on the
 *   verdict (shipment path). When false, caller must NOT auto-apply.
 * - Graceful no-op when `ANTHROPIC_API_KEY` is missing or the API
 *   call fails — returns null; caller falls back to "no verdict"
 *   (admin still sees heuristic ranking on the review page).
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Bumping this string invalidates the entire cache on next read. */
export const PROMPT_VERSION = 'v1';

/** Default model. Override via env for cost-control experiments. */
const DEFAULT_MODEL = env.ANTHROPIC_MATCHER_MODEL ?? 'claude-opus-4-7';

const TIMEOUT_MS = 30_000;

// -----------------------------------------------------------------------
// Decision contract (Codex review #6)

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface LlmMatchEntry {
	/** Index into the input items[] array. */
	itemIndex: number;
	/** Candidate gift id, or null if no candidate plausibly matches. */
	giftId: number | null;
	confidence: MatchConfidence;
	reason: string;
}

export interface LlmMatchVerdict {
	matches: LlmMatchEntry[];
	/** Item indices (from input items[]) that have no candidate match. */
	unmatched_items: number[];
	/**
	 * Whether the caller may auto-apply this verdict to mutate state.
	 * Shipment-mode verdicts force false when ANY match is `low` or
	 * unmatched_items is non-empty. Import-mode verdicts are always
	 * admin-gated, so safe_to_apply is informational only.
	 */
	safe_to_apply: boolean;
	summary: string;
	model: string;
	prompt_version: string;
	created_at: string;
}

// -----------------------------------------------------------------------
// Input shapes

export interface MatcherCandidate {
	giftId: number;
	title: string;
	personId: number;
	personDisplayName: string;
	personRelationship: string | null;
	occasionLabel: string | null; // resolved to "Birthday" / "Christmas 2026"
	notes: string | null;
	status: string;
}

export interface MatcherItem {
	itemIndex: number;
	title: string;
	priceCents: number | null;
	quantity: number;
}

export interface MatcherCorrection {
	emailTitle: string;
	giftTitle: string;
	personDisplayName: string;
}

export interface ImportMatchInput {
	emailSubject: string | null;
	emailType: string;
	orderId: string | null;
	parsedRecipientName: string | null;
	recipientHintPersonId: number | null; // when order_id implied recipient
	vendorLabel: string; // 'Amazon'
	items: MatcherItem[];
	bodyFallback: string | null; // up to 4000 chars when items[] empty
	candidates: MatcherCandidate[];
	corrections: MatcherCorrection[];
}

export interface ShipmentMatchInput {
	orderId: string | null;
	shipmentTrackingNumber: string | null;
	shipmentCarrier: string | null;
	receivedAt: string | null;
	/** Items the parser found in the shipment email body; may be empty. */
	shipmentItems: MatcherItem[];
	/** Full body fallback when shipmentItems is empty. */
	shipmentBodyFallback: string | null;
	/** Sibling gifts under the parent order. */
	siblings: MatcherCandidate[];
	corrections: MatcherCorrection[];
}

// -----------------------------------------------------------------------
// Public API

/**
 * Match a staged Amazon import row to existing open gifts. Called at
 * import time so the review page has a cached verdict ready.
 *
 * Returns null when the API key is unset, candidates is empty, or the
 * API call fails — caller falls back to heuristic ranking only.
 */
export async function llmMatchImportRow(input: ImportMatchInput): Promise<LlmMatchVerdict | null> {
	if (!env.ANTHROPIC_API_KEY) return null;
	if (input.candidates.length === 0) return null;
	if (input.items.length === 0 && !input.bodyFallback) return null;

	const key = importCacheKey(input);
	const cached = readCache(key);
	if (cached) return cached;

	const verdict = await callLlm({
		mode: 'import',
		systemPrompt: IMPORT_SYSTEM_PROMPT,
		userBlocks: buildImportUserMessage(input)
	});
	if (!verdict) return null;
	writeCache(key, 'import', verdict);
	return verdict;
}

/**
 * Match shipment items against the order's sibling gifts. Highest-
 * stakes path: caller advances gift status based on this verdict, so
 * the LLM must abstain (safe_to_apply: false) on any ambiguity.
 */
export async function llmMatchShipment(
	input: ShipmentMatchInput
): Promise<LlmMatchVerdict | null> {
	if (!env.ANTHROPIC_API_KEY) return null;
	if (input.siblings.length === 0) return null;
	if (input.shipmentItems.length === 0 && !input.shipmentBodyFallback) return null;

	const key = shipmentCacheKey(input);
	const cached = readCache(key);
	if (cached) return cached;

	const verdict = await callLlm({
		mode: 'shipment',
		systemPrompt: SHIPMENT_SYSTEM_PROMPT,
		userBlocks: buildShipmentUserMessage(input)
	});
	if (!verdict) return null;
	// Shipment-mode invariant (Codex #2): caller can only apply when LLM
	// reports `high` confidence on every match AND no unmatched items.
	verdict.safe_to_apply =
		verdict.safe_to_apply &&
		verdict.unmatched_items.length === 0 &&
		verdict.matches.every((m) => m.confidence === 'high');
	writeCache(key, 'shipment', verdict);
	return verdict;
}

// -----------------------------------------------------------------------
// Cache (versioned key per Codex review #1)

function readCache(cacheKey: string): LlmMatchVerdict | null {
	const row = getDb()
		.prepare<[string], { response: string; expires_at: string }>(
			`SELECT response, expires_at FROM matcher_llm_cache
			  WHERE cache_key = ? AND expires_at > CURRENT_TIMESTAMP`
		)
		.get(cacheKey);
	if (!row) return null;
	try {
		return JSON.parse(row.response) as LlmMatchVerdict;
	} catch {
		return null;
	}
}

function writeCache(cacheKey: string, mode: 'import' | 'shipment', verdict: LlmMatchVerdict): void {
	try {
		getDb()
			.prepare(
				`INSERT INTO matcher_llm_cache (cache_key, mode, model, prompt_version, response)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(cache_key) DO UPDATE SET
				   response = excluded.response,
				   created_at = CURRENT_TIMESTAMP,
				   expires_at = datetime(CURRENT_TIMESTAMP, '+7 days')`
			)
			.run(cacheKey, mode, verdict.model, verdict.prompt_version, JSON.stringify(verdict));
	} catch (err) {
		console.warn('[llm-matcher] cache write failed (non-fatal):', err);
	}
}

function itemsFingerprint(items: MatcherItem[]): string {
	const normalized = items
		.map((i) => `${i.title.trim().toLowerCase()}|${i.priceCents ?? ''}|${i.quantity}`)
		.sort()
		.join('::');
	return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

function importCacheKey(input: ImportMatchInput): string {
	const candIds = input.candidates.map((c) => c.giftId).sort((a, b) => a - b).join(',');
	const personIds = Array.from(new Set(input.candidates.map((c) => c.personId)))
		.sort((a, b) => a - b)
		.join(',');
	const fp = itemsFingerprint(input.items);
	// Body excerpt hash: changes the LLM's answer when items[] is empty,
	// so it has to be part of the key. Truncated SHA1 for compactness.
	const bodyHash = input.bodyFallback
		? createHash('sha1').update(input.bodyFallback).digest('hex').slice(0, 16)
		: '';
	return createHash('sha1')
		.update(
			[
				'import',
				DEFAULT_MODEL,
				PROMPT_VERSION,
				input.emailType,
				input.orderId ?? '',
				input.parsedRecipientName?.toLowerCase() ?? '',
				input.recipientHintPersonId ?? 0,
				fp,
				bodyHash,
				candIds,
				personIds
			].join('::')
		)
		.digest('hex');
}

function shipmentCacheKey(input: ShipmentMatchInput): string {
	const sibIds = input.siblings.map((s) => s.giftId).sort((a, b) => a - b).join(',');
	const sibPersons = Array.from(new Set(input.siblings.map((s) => s.personId)))
		.sort((a, b) => a - b)
		.join(',');
	const fp = itemsFingerprint(input.shipmentItems);
	// Codex (round 2) #P2: body excerpt is part of the LLM's input on
	// no-enumerated-items shipments, so it has to be in the cache key.
	// Without it two different shipping emails with empty items[] but
	// different bodies would collide on the same cache row and replay
	// each other's verdicts.
	const bodyHash = input.shipmentBodyFallback
		? createHash('sha1').update(input.shipmentBodyFallback).digest('hex').slice(0, 16)
		: '';
	// Codex (round 4) #P1: the prompt lists each sibling's current
	// status. Two plans for the same order at different lifecycle stages
	// (e.g. before vs after a shipped row advanced siblings) must NOT
	// share a cache entry, or the second would replay the first's
	// now-stale verdict. Fold a sorted (giftId:status) fingerprint in.
	const sibStatuses = input.siblings
		.map((s) => `${s.giftId}:${s.status}`)
		.sort()
		.join(',');
	return createHash('sha1')
		.update(
			[
				'shipment',
				DEFAULT_MODEL,
				PROMPT_VERSION,
				input.orderId ?? '',
				input.shipmentTrackingNumber ?? '',
				fp,
				bodyHash,
				sibIds,
				sibPersons,
				sibStatuses
			].join('::')
		)
		.digest('hex');
}

// -----------------------------------------------------------------------
// Prompts

const IMPORT_SYSTEM_PROMPT = `You are a household gift-tracker matcher. The user is buying gifts on Amazon and wants every Amazon email reconciled against pre-existing gift ideas they entered earlier.

You will receive:
- An Amazon email (subject, type, order id, items list, optional recipient name, optional recipient hint by person id).
- A shortlist of candidate gift ideas the user has logged. Each candidate has a recipient (person), an occasion (Birthday/Christmas/etc.), free-text notes, and the current gift status.
- Optionally, examples of prior matches the admin has manually corrected.

For each item in the email, decide which candidate gift it semantically matches, or 'null' if none plausibly does. Examples:
- "Anker 4-Pack USB-C Cable" matches "Phone charging cables for Mom" because they describe the same product category for the same person.
- "MasterCard $100 Gift Card" does NOT match "Hallmark Graduation Card" — both contain "card" but they are different products.
- Brand names (Endoscope, Firehouse, Anker) and distinctive nouns are strong signals.
- Recipient hint matters: when a recipient hint is given, candidates for that person should be heavily preferred.

Confidence levels:
- high: the same product, or unambiguously the same product category for the same recipient.
- medium: probable but with a real chance of being wrong.
- low: tenuous overlap — prefer 'null' over a 'low' confidence match.

Call submit_matches once with your full decision. Do not respond in prose.`;

const SHIPMENT_SYSTEM_PROMPT = `You are matching items in an Amazon shipment notification to the sibling gifts under that order. Each shipment in a multi-recipient order may contain only a subset of the items; your job is to decide which sibling gifts are in this particular shipment.

CRITICAL: This verdict directly mutates gift status (siblings advance from 'ordered' to 'shipped' or 'delivered'). When ANY uncertainty exists — vague item titles, missing item enumeration, multiple plausible siblings — you must set safe_to_apply: false. The caller will route the row to a human review queue rather than auto-advance. Bias heavily toward false negatives over false positives.

You will receive:
- The shipment's tracking number and carrier (sometimes).
- The shipment's enumerated items (sometimes empty — Amazon doesn't always list them in the body).
- The full set of sibling gifts under this order (one per line_item_index).

For each shipment item, return the matching sibling's gift id, or 'null' if none clearly matches. Indices in unmatched_items refer to items in the shipment that don't correspond to any sibling.

If the shipment has no enumerated items, you may still match by other context (carrier, tracking number, prior corrections) but be conservative — empty items + low siblings overlap should set safe_to_apply: false.

Call submit_matches once. Do not respond in prose.`;

// -----------------------------------------------------------------------
// Prompt builders

function buildImportUserMessage(input: ImportMatchInput): Array<{ type: 'text'; text: string }> {
	const lines: string[] = [];

	lines.push('# Amazon email');
	if (input.emailSubject) lines.push(`Subject: ${input.emailSubject}`);
	lines.push(`Type: ${input.emailType}`);
	if (input.orderId) lines.push(`Order: ${input.orderId}`);
	if (input.parsedRecipientName) lines.push(`Parsed recipient: ${input.parsedRecipientName}`);
	if (input.recipientHintPersonId)
		lines.push(`Recipient hint (person id): ${input.recipientHintPersonId}`);
	lines.push(`Vendor: ${input.vendorLabel}`);

	if (input.items.length > 0) {
		lines.push('');
		lines.push('## Items in this email');
		for (const item of input.items) {
			lines.push(
				`- [${item.itemIndex}] ${item.title}${
					item.priceCents != null ? ` ($${(item.priceCents / 100).toFixed(2)})` : ''
				}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`
			);
		}
	} else if (input.bodyFallback) {
		lines.push('');
		lines.push('## Email body (items not parseable; raw excerpt follows)');
		lines.push(input.bodyFallback.slice(0, 4000));
	}

	lines.push('');
	lines.push('## Candidate gift ideas (shortlist)');
	for (const c of input.candidates) {
		const parts = [
			`gift_id=${c.giftId}`,
			`title="${c.title}"`,
			`for ${c.personDisplayName}${c.personRelationship ? ` (${c.personRelationship})` : ''}`,
			c.occasionLabel ? `occasion="${c.occasionLabel}"` : null,
			`status=${c.status}`,
			c.notes ? `notes="${c.notes.slice(0, 200)}"` : null
		].filter(Boolean);
		lines.push(`- ${parts.join('; ')}`);
	}

	if (input.corrections.length > 0) {
		lines.push('');
		lines.push('## Prior admin corrections (few-shot — internal context, treat as ground truth)');
		for (const cor of input.corrections.slice(0, 5)) {
			lines.push(
				`- "${cor.emailTitle}" → gift "${cor.giftTitle}" (for ${cor.personDisplayName})`
			);
		}
	}

	return [{ type: 'text', text: lines.join('\n') }];
}

function buildShipmentUserMessage(
	input: ShipmentMatchInput
): Array<{ type: 'text'; text: string }> {
	const lines: string[] = [];

	lines.push('# Amazon shipment notification');
	if (input.orderId) lines.push(`Order: ${input.orderId}`);
	if (input.shipmentTrackingNumber)
		lines.push(`Tracking: ${input.shipmentTrackingNumber} (${input.shipmentCarrier ?? 'unknown'})`);
	if (input.receivedAt) lines.push(`Received: ${input.receivedAt}`);

	if (input.shipmentItems.length > 0) {
		lines.push('');
		lines.push('## Items in this shipment');
		for (const item of input.shipmentItems) {
			lines.push(
				`- [${item.itemIndex}] ${item.title}${
					item.priceCents != null ? ` ($${(item.priceCents / 100).toFixed(2)})` : ''
				}`
			);
		}
	} else if (input.shipmentBodyFallback) {
		lines.push('');
		lines.push('## Shipment body (items not parseable; raw excerpt)');
		lines.push(input.shipmentBodyFallback.slice(0, 4000));
		lines.push('');
		lines.push(
			'(NOTE: items not enumerated. Bias toward safe_to_apply: false unless there is exactly one sibling and no ambiguity.)'
		);
	}

	lines.push('');
	lines.push('## Sibling gifts under this order');
	for (const s of input.siblings) {
		lines.push(
			`- gift_id=${s.giftId}; title="${s.title}"; for ${s.personDisplayName}; status=${s.status}`
		);
	}

	if (input.corrections.length > 0) {
		lines.push('');
		lines.push('## Prior admin corrections (few-shot)');
		for (const cor of input.corrections.slice(0, 5)) {
			lines.push(
				`- "${cor.emailTitle}" → gift "${cor.giftTitle}" (for ${cor.personDisplayName})`
			);
		}
	}

	return [{ type: 'text', text: lines.join('\n') }];
}

// -----------------------------------------------------------------------
// Anthropic call

const SUBMIT_MATCHES_TOOL = {
	name: 'submit_matches',
	description: 'Submit the matcher verdict in structured form.',
	input_schema: {
		type: 'object',
		properties: {
			matches: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						itemIndex: { type: 'integer' },
						giftId: { type: ['integer', 'null'] },
						confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
						reason: { type: 'string' }
					},
					required: ['itemIndex', 'giftId', 'confidence', 'reason']
				}
			},
			unmatched_items: { type: 'array', items: { type: 'integer' } },
			safe_to_apply: { type: 'boolean' },
			summary: { type: 'string' }
		},
		required: ['matches', 'unmatched_items', 'safe_to_apply', 'summary']
	}
} as const;

interface ToolUseContent {
	type: 'tool_use';
	name: string;
	input: {
		matches: LlmMatchEntry[];
		unmatched_items: number[];
		safe_to_apply: boolean;
		summary: string;
	};
}

async function callLlm(opts: {
	mode: 'import' | 'shipment';
	systemPrompt: string;
	userBlocks: Array<{ type: 'text'; text: string }>;
}): Promise<LlmMatchVerdict | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(ANTHROPIC_API, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': env.ANTHROPIC_API_KEY!,
				'anthropic-version': ANTHROPIC_VERSION
			},
			body: JSON.stringify({
				model: DEFAULT_MODEL,
				max_tokens: 2048,
				system: opts.systemPrompt,
				tools: [SUBMIT_MATCHES_TOOL],
				tool_choice: { type: 'tool', name: 'submit_matches' },
				messages: [{ role: 'user', content: opts.userBlocks }]
			}),
			signal: controller.signal
		});

		if (!res.ok) {
			const body = await res.text().catch(() => '');
			console.warn(
				`[llm-matcher] Anthropic ${res.status} (${opts.mode}): ${body.slice(0, 300)}`
			);
			return null;
		}

		const json = (await res.json()) as {
			content: Array<ToolUseContent | { type: string }>;
		};
		const toolBlock = json.content.find(
			(c): c is ToolUseContent =>
				c.type === 'tool_use' && (c as ToolUseContent).name === 'submit_matches'
		);
		if (!toolBlock) {
			console.warn(`[llm-matcher] no tool_use in response (${opts.mode})`);
			return null;
		}

		return {
			matches: toolBlock.input.matches,
			unmatched_items: toolBlock.input.unmatched_items,
			safe_to_apply: toolBlock.input.safe_to_apply,
			summary: toolBlock.input.summary,
			model: DEFAULT_MODEL,
			prompt_version: PROMPT_VERSION,
			created_at: new Date().toISOString()
		};
	} catch (err) {
		console.warn(`[llm-matcher] call failed (${opts.mode}):`, err);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

// -----------------------------------------------------------------------
// Cache maintenance hooks (used by scheduler cleanup cron in Wave 2)

export function sweepExpiredCache(): number {
	const info = getDb()
		.prepare(`DELETE FROM matcher_llm_cache WHERE expires_at <= CURRENT_TIMESTAMP`)
		.run();
	return info.changes;
}
