import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getGiftWithContext, parseDollarsToCents, priceDollarsInput, updateGift } from '$server/gifts';
import { listPersonOccasions } from '$server/occasions';
import { getPersonById, listPeople } from '$server/people';

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
	return {
		gift,
		people: listPeople({ includeArchived: false, sort: 'alphabetical' }),
		personOccasions: listPersonOccasions(gift.person_id),
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

		updateGift(
			gift.id,
			{
				person_id,
				title,
				source: nullable(trim(fd.get('source'))),
				source_url: nullable(trim(fd.get('source_url'))),
				occasion_id,
				occasion_year: numOrNull(trim(fd.get('occasion_year'))),
				order_id: nullable(trim(fd.get('order_id'))),
				tracking_number: nullable(trim(fd.get('tracking_number'))),
				carrier: nullable(trim(fd.get('carrier'))),
				price_cents,
				notes: nullable(trim(fd.get('notes')))
			},
			locals.user.id
		);
		throw redirect(303, `/app/gifts/${gift.id}`);
	}
};

function formValues(fd: FormData): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of [
		'person_id',
		'title',
		'source',
		'source_url',
		'occasion_id',
		'occasion_year',
		'order_id',
		'tracking_number',
		'carrier',
		'price',
		'notes'
	]) {
		out[key] = trim(fd.get(key));
	}
	return out;
}
