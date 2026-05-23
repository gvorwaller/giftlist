import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGiftWithContext } from '$server/gifts';

// Redirect hop for the gift's source_url. Tapping an amazon.com link directly
// on iOS hands it to the Amazon app via Universal Links, which can't resolve
// the /gp/css/order-details web path and dumps the user at "Your Orders".
// Routing through our own (non-app-claimed) domain defeats that: iOS does not
// apply Universal-Link interception to server redirects, so the order page
// opens in the browser — same as pasting the URL into the address bar.
export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(400, 'Invalid gift id');

	const gift = getGiftWithContext(id);
	if (!gift) throw error(404, 'Gift not found');

	// Self-orders are private to their owner_user_id (td-68804e). Strict
	// equality denies foreign-owned AND orphaned (null-owner) self-gifts.
	if (gift.person.is_self === 1 && gift.person.owner_user_id !== locals.user.id) {
		throw error(404, 'Gift not found');
	}

	// Only ever redirect to a real web URL. source_url is our own data, but a
	// manually-entered value could be blank or a non-http scheme; in either
	// case fall back to the gift page rather than emitting an odd Location.
	const url = gift.source_url?.trim();
	if (!url || !/^https?:\/\//i.test(url)) {
		throw redirect(303, `/app/gifts/${id}`);
	}

	throw redirect(302, url);
};
