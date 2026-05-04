import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getGiftWithContext, parseDollarsToCents, priceDollarsInput, updateGift } from '$server/gifts';
import { listPersonOccasions } from '$server/occasions';
import { getPersonById, listPeople } from '$server/people';
import { listVendors, getVendorById } from '$server/vendors';
import { listShippers, getShipperById } from '$server/shippers';
import { registerWithProvider } from '$server/tracking';

function trim(v: FormDataEntryValue | null): string {
	return typeof v === 'string' ? v.trim() : '';
}

function nullable(v: string): string | null {
	return v === '' ? null : v;
}

function numOrNull(v: string): number | null {
	if (v === '') return null;
	const n = Number(v);
	return Number.isInteger(n) ? n : null;
}

function requireGift(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(400, 'Invalid gift id');
	const gift = getGiftWithContext(id);
	if (!gift) throw error(404, 'Gift not found');
	return gift;
}

export const load: PageServerLoad = ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const gift = requireGift(params);
	// Always include the gift's currently-linked vendor in the dropdown even
	// if it's archived, so editing an old gift doesn't silently lose the link.
	const activeVendors = listVendors({ includeArchived: false });
	const currentVendor = gift.vendor ?? null;
	const vendors =
		currentVendor && currentVendor.is_archived === 1
			? [...activeVendors, currentVendor]
			: activeVendors;

	const activeShippers = listShippers({ includeArchived: false });
	const currentShipper = gift.shipper ?? null;
	const shippers =
		currentShipper && currentShipper.is_archived === 1
			? [...activeShippers, currentShipper]
			: activeShippers;

	return {
		gift,
		people: listPeople({ includeArchived: false, sort: 'alphabetical' }),
		personOccasions: listPersonOccasions(gift.person_id),
		vendors,
		shippers,
		priceInitial: priceDollarsInput(gift.price_cents)
	};
};

export const actions: Actions = {
	save: async ({ params, request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const gift = requireGift(params);
		const fd = await request.formData();

		const title = trim(fd.get('title'));
		if (!title) {
			return fail(400, { error: 'Title is required.', values: formValues(fd) });
		}

		const person_id = Number(fd.get('person_id'));
		if (!Number.isInteger(person_id) || !getPersonById(person_id)) {
			return fail(400, { error: 'Choose who the gift is for.', values: formValues(fd) });
		}

		let price_cents: number | null;
		try {
			price_cents = parseDollarsToCents(trim(fd.get('price')));
		} catch {
			return fail(400, { error: 'Price should look like 24.99', values: formValues(fd) });
		}

		// If person changed, ignore submitted occasion_id — the form clears
		// the dropdown but a stale value could survive a back-button submit.
		const personChanged = person_id !== gift.person_id;
		const occasion_id = personChanged ? null : numOrNull(trim(fd.get('occasion_id')));

		const vendor_id = numOrNull(trim(fd.get('vendor_id')));
		if (vendor_id != null && !getVendorById(vendor_id)) {
			return fail(400, { error: 'Pick a vendor from the list.', values: formValues(fd) });
		}

		const shipper_id = numOrNull(trim(fd.get('shipper_id')));
		if (shipper_id != null && !getShipperById(shipper_id)) {
			return fail(400, { error: 'Pick a shipper from the list.', values: formValues(fd) });
		}

		const newTracking = nullable(trim(fd.get('tracking_number')));
		const trackingChanged = newTracking !== gift.tracking_number;

		updateGift(
			gift.id,
			{
				person_id,
				title,
				vendor_id,
				shipper_id,
				source_url: nullable(trim(fd.get('source_url'))),
				occasion_id,
				occasion_year: numOrNull(trim(fd.get('occasion_year'))),
				order_id: nullable(trim(fd.get('order_id'))),
				tracking_number: newTracking,
				price_cents,
				notes: nullable(trim(fd.get('notes'))),
				// If the tracking number changed, clear the tracking-provider
				// linkage so the next save attempt re-registers under the new
				// number.
				...(trackingChanged
					? {
							tracking_provider_id: null,
							tracking_status: null,
							tracking_status_at: null,
							tracking_estimated_delivery: null
						}
					: {})
			},
			locals.user.id
		);

		// Register (or re-register) with Shippo if there's now a tracking
		// number and one wasn't previously registered. Fire-and-forget — don't
		// block the redirect; failures bubble to logs and the next refresh.
		if (newTracking && process.env.SHIPPO_API_KEY) {
			registerWithProvider(gift.id, locals.user.id).catch((err) => {
				console.warn('[gifts/edit] Shippo register failed:', err);
			});
		}

		throw redirect(303, `/app/gifts/${gift.id}`);
	}
};

function formValues(fd: FormData): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of [
		'person_id',
		'title',
		'vendor_id',
		'source_url',
		'occasion_id',
		'occasion_year',
		'order_id',
		'tracking_number',
		'shipper_id',
		'price',
		'notes'
	]) {
		out[key] = trim(fd.get(key));
	}
	return out;
}
