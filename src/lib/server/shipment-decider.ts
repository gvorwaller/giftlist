import { listGiftsForOrder, matchSiblingsToShipment } from './orders';
import { siblingsAsCandidates } from './gift-matcher';
import { llmMatchShipment } from './llm-matcher';
import type { Gift, ImportRow } from './types';
import type { ParsedAmazonItem } from './amazon-parser';

/**
 * Wave 1 Phase 2 (post-Codex review #2): the decider for shipment-event
 * lifecycle. Owns the safety policy around mutating gift status from
 * shipped/delivered emails:
 *
 *   1. If the email enumerated items AND the heuristic finds a match for
 *      every shipped item → `safe` plan, advance the matched siblings.
 *   2. Otherwise call the LLM with the shipment context. Honor
 *      `safe_to_apply`: when true, advance the siblings the LLM identified.
 *   3. Otherwise → `abstain` plan: the shipment row is still created
 *      (tracking info is real), but NO siblings advance. The caller marks
 *      the import row for admin review.
 *
 * The old "fall back to advance ALL siblings" behavior is removed
 * entirely. Empirically that was wrong about half the time on
 * multi-recipient orders and is exactly the bug we're fixing.
 */

export type ShipmentAdvancePlan =
	| {
			kind: 'safe';
			matchedSiblingIds: number[];
			source: 'heuristic' | 'llm';
			reason: string;
	  }
	| {
			kind: 'abstain';
			reason: string;
	  };

export interface PlanShipmentInput {
	row: ImportRow;
	orderPk: number;
	siblings: Gift[];
	items: ParsedAmazonItem[];
}

/**
 * Decide which siblings (if any) to advance for a shipment-event row.
 * Always returns a plan — never throws. LLM call failures (no API key,
 * timeout, etc.) degrade to `abstain` rather than wrong-answer advance.
 */
export async function planShipmentAdvance(
	input: PlanShipmentInput
): Promise<ShipmentAdvancePlan> {
	const { row, orderPk, siblings, items } = input;

	// No siblings = no order under this id yet (rare — typically means
	// the shipped email arrived before the order_placed email was
	// committed, OR the order has nothing to advance). Caller will
	// create the shipment row but advance nothing.
	if (siblings.length === 0) {
		return {
			kind: 'safe',
			matchedSiblingIds: [],
			source: 'heuristic',
			reason: 'No siblings under this order — nothing to advance.'
		};
	}

	const shippedTitles = items.map((it) => it.title).filter((t): t is string => !!t);
	const heuristic = matchSiblingsToShipment(siblings, shippedTitles);

	// Fast path: heuristic is confident every shipped item paired with a
	// sibling. Skip the LLM round-trip.
	if (heuristic.heuristicCertain) {
		return {
			kind: 'safe',
			matchedSiblingIds: heuristic.matched.map((s) => s.id),
			source: 'heuristic',
			reason: `Heuristic matched ${heuristic.matched.length} sibling(s) cleanly.`
		};
	}

	// Otherwise consult the LLM. We pass the full sibling set as
	// candidates so the LLM has the same information the heuristic did,
	// PLUS the shipment context (carrier, tracking, etc.).
	//
	// Codex P4: pass the persisted body excerpt as fallback context.
	// This is the whole point of migration 026 — when items[] is empty
	// (Amazon's terser shipping notifications), the body text often has
	// enough detail for the LLM to identify which siblings shipped.
	// Without this the verdict would always be null in that case and
	// every such row would force-abstain even when resolvable.
	const candidates = siblingsAsCandidates(orderPk);
	const verdict = await llmMatchShipment({
		orderId: row.parsed_order_id,
		shipmentTrackingNumber: row.parsed_tracking_number,
		shipmentCarrier: row.parsed_carrier,
		receivedAt: row.received_at,
		shipmentItems: items.map((it, idx) => ({
			itemIndex: idx,
			title: it.title,
			priceCents: it.priceCents,
			quantity: it.quantity
		})),
		shipmentBodyFallback: row.parsed_body_excerpt,
		siblings: candidates,
		corrections: []
	});

	if (!verdict) {
		// Either no inputs (items[] empty AND no body excerpt — typical
		// of older import rows scanned before the body-excerpt feature
		// shipped), the API key is missing, or the call failed. In any
		// case, abstain rather than guess.
		const hasContext = items.length > 0 || !!row.parsed_body_excerpt;
		const reason = hasContext
			? 'LLM consulted but could not confidently identify which siblings shipped. Open each sibling gift and advance its status manually.'
			: 'No item enumeration and no body excerpt captured on this row, so the LLM had no context to decide which siblings shipped. Open the affected gifts via the order detail page and advance status manually.';
		return { kind: 'abstain', reason };
	}

	if (!verdict.safe_to_apply) {
		return {
			kind: 'abstain',
			reason: `LLM ${verdict.summary}`
		};
	}

	// Safe-to-apply verdict: advance the siblings the LLM identified.
	// (giftId of `null` per match means "no sibling shipped this item"
	// — informational; doesn't advance anything.)
	const matchedIds = Array.from(
		new Set(verdict.matches.map((m) => m.giftId).filter((id): id is number => id != null))
	);
	return {
		kind: 'safe',
		matchedSiblingIds: matchedIds,
		source: 'llm',
		reason: `AI: ${verdict.summary}`
	};
}

/**
 * Helper for callers that need a plan but only have an `order_pk` (e.g.
 * pre-flight in commitReviewedRows where we need the siblings before
 * the transaction). Fetches siblings + items, then calls the planner.
 */
export async function planShipmentAdvanceForRow(
	row: ImportRow,
	orderPk: number,
	items: ParsedAmazonItem[]
): Promise<ShipmentAdvancePlan> {
	const siblings = listGiftsForOrder(orderPk);
	return planShipmentAdvance({ row, orderPk, siblings, items });
}
