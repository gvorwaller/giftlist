// Pure status-transition helpers — safe to import from .svelte client bundles.
// DB-touching transition logic lives in $server/gift-status.

import type { GiftStatus } from '$server/types';

const FORWARD: Record<GiftStatus, GiftStatus | null> = {
	idea: 'planned',
	planned: 'ordered',
	ordered: 'shipped',
	shipped: 'delivered',
	delivered: 'wrapped',
	wrapped: 'given',
	given: null,
	returned: null
};

const RETURN_ELIGIBLE: ReadonlySet<GiftStatus> = new Set([
	'ordered',
	'shipped',
	'delivered',
	'wrapped'
]);

export function nextForwardStatus(current: GiftStatus): GiftStatus | null {
	return FORWARD[current];
}

export function canReturn(current: GiftStatus): boolean {
	return RETURN_ELIGIBLE.has(current);
}

export function canTransition(from: GiftStatus, to: GiftStatus): boolean {
	if (FORWARD[from] === to) return true;
	if (to === 'returned' && RETURN_ELIGIBLE.has(from)) return true;
	return false;
}

export function managerLabel(s: GiftStatus): string {
	switch (s) {
		case 'idea':
			return 'Idea saved';
		case 'planned':
			return 'Chosen';
		case 'ordered':
			return 'Bought';
		case 'shipped':
			return 'On the way';
		case 'delivered':
			return 'Arrived';
		case 'wrapped':
			return 'Ready';
		case 'given':
			return 'Given';
		case 'returned':
			return 'Returned';
	}
}

export function forwardActionLabel(s: GiftStatus): string | null {
	switch (s) {
		case 'idea':
			return 'Mark Chosen';
		case 'planned':
			return 'Mark Bought';
		case 'ordered':
			return 'Mark Shipped';
		case 'shipped':
			return 'Mark Arrived';
		case 'delivered':
			return 'Mark Wrapped';
		case 'wrapped':
			return 'Mark Given';
		default:
			return null;
	}
}

export function transitionSummary(from: GiftStatus, to: GiftStatus, giftTitle: string): string {
	return `"${giftTitle}" → ${managerLabel(to)} (was ${managerLabel(from)})`;
}
