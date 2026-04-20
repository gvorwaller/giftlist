import { getDb } from './db';
import { logAudit } from './audit';
import {
	canTransition,
	nextForwardStatus,
	transitionSummary
} from '$lib/gift-status';
import type { Gift, GiftStatus } from './types';

// Re-export the pure helpers so existing server imports still work.
export {
	canReturn,
	canTransition,
	forwardActionLabel,
	managerLabel,
	nextForwardStatus,
	transitionSummary
} from '$lib/gift-status';

/**
 * Apply a transition. Writes status + the appropriate timestamp column
 * (ordered_at, shipped_at, delivered_at) atomically with an audit entry.
 * Throws if the transition isn't allowed from the current state.
 */
export function transitionGift(
	giftId: number,
	to: GiftStatus,
	actorUserId: number
): Gift {
	const db = getDb();
	const current = db.prepare<[number], Gift>('SELECT * FROM gifts WHERE id = ?').get(giftId);
	if (!current) throw new Error(`Gift ${giftId} not found`);
	if (current.status === to) return current;
	if (!canTransition(current.status, to)) {
		throw new Error(
			`Illegal transition: ${current.status} → ${to} (allowed forward: ${nextForwardStatus(current.status) ?? 'none'})`
		);
	}

	const timestampColumns: Partial<Record<GiftStatus, 'ordered_at' | 'shipped_at' | 'delivered_at'>> = {
		ordered: 'ordered_at',
		shipped: 'shipped_at',
		delivered: 'delivered_at'
	};
	const tsCol = timestampColumns[to];

	db.transaction(() => {
		if (tsCol) {
			db.prepare(
				`UPDATE gifts SET status = ?, ${tsCol} = COALESCE(${tsCol}, CURRENT_TIMESTAMP),
				        updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`
			).run(to, giftId);
		} else {
			db.prepare(
				`UPDATE gifts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
			).run(to, giftId);
		}

		logAudit({
			actorUserId,
			entityType: 'gift',
			entityId: giftId,
			action: `status_${to}`,
			summary: transitionSummary(current.status, to, current.title)
		});
	})();

	return db.prepare<[number], Gift>('SELECT * FROM gifts WHERE id = ?').get(giftId)!;
}
