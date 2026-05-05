import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listPeople, getPersonById, isPersonVisibleToUser } from '$server/people';
import { listPersonOccasions, nextOccurrenceDate } from '$server/occasions';
import { createGift, parseDollarsToCents } from '$server/gifts';
import { deleteDraft, getFreshDraft, parseDraftPayload } from '$server/drafts';
import { listVendors, getVendorById } from '$server/vendors';
import { listShippers, getShipperById } from '$server/shippers';
import { registerWithProvider } from '$server/tracking';
import type { OccasionWithLink } from '$server/occasions';

export interface GiftDraftPayload {
	person_id?: number | null;
	title?: string;
	vendor_id?: number | null;
	source_url?: string;
	occasion_id?: number | null;
	occasion_year?: number | null;
	order_id?: string;
	tracking_number?: string;
	shipper_id?: number | null;
	price?: string;
	notes?: string;
	status?: 'planned' | 'idea';
}

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

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	// Include self-people in the dropdown so personal orders can be entered
	// here too (see td-24eac3). Scoped per-user (td-68804e): each signed-in
	// user only sees their own self-people, never the other user's. The
	// .svelte side flags them with " (me)".
	const people = listPeople({
		includeArchived: false,
		includeSelf: true,
		selfOwnerUserId: locals.user.id,
		sort: 'alphabetical'
	});
	const preselectedPersonId = url.searchParams.get('person');
	let prefill: GiftDraftPayload = {};
	let draftUpdatedAt: string | null = null;

	const draft = getFreshDraft(locals.user.id, 'gift');
	if (draft) {
		prefill = parseDraftPayload<GiftDraftPayload>(draft) ?? {};
		draftUpdatedAt = draft.updated_at;
	}
	if (preselectedPersonId && !prefill.person_id) {
		const pid = Number(preselectedPersonId);
		// Same privacy guard on the ?person= prefill: don't honor a query
		// param that points at another user's self-person.
		if (Number.isInteger(pid) && isPersonVisibleToUser(pid, locals.user.id)) {
			prefill.person_id = pid;
		}
	}

	const activePersonId = prefill.person_id ?? null;
	const activePerson = activePersonId ? getPersonById(activePersonId) : null;
	// Self-people don't track occasions (no birthday/holiday context for
	// "I bought myself a charger"), so skip the per-person occasion list and
	// the auto-pick of nearest occurrence when the active person is_self.
	const personOccasions =
		activePersonId && activePerson?.is_self !== 1 ? listPersonOccasions(activePersonId) : [];

	// When the form opens for a specific person and no occasion was selected in
	// the draft, default to that person's next upcoming occasion so the Today
	// screen's "Next Best Action" can later recognize this gift as handling it.
	if (activePerson?.is_self !== 1 && activePersonId && !prefill.occasion_id && personOccasions.length > 0) {
		const nearest = pickNearestOccurrence(personOccasions);
		if (nearest) {
			prefill.occasion_id = nearest.id;
			prefill.occasion_year = nearest.date.getFullYear();
		}
	}

	return {
		people,
		personOccasions,
		vendors: listVendors({ includeArchived: false }),
		shippers: listShippers({ includeArchived: false }),
		prefill,
		draftUpdatedAt,
		currentYear: new Date().getFullYear()
	};
};

function pickNearestOccurrence(
	occasions: OccasionWithLink[]
): { id: number; date: Date } | null {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	let best: { id: number; date: Date } | null = null;
	for (const o of occasions) {
		if (o.is_active === 0) continue;
		const d = nextOccurrenceDate(o, today);
		if (!d) continue;
		if (!best || d.getTime() < best.date.getTime()) {
			best = { id: o.id, date: d };
		}
	}
	return best;
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();

		const person_id = Number(fd.get('person_id'));
		const title = trim(fd.get('title'));
		// Server-side privacy check (td-68804e): the dropdown is filtered
		// client-side, but a crafted POST could still target another user's
		// self-person. isPersonVisibleToUser denies archived people and any
		// self-person not owned by the current user.
		if (
			!Number.isInteger(person_id) ||
			!getPersonById(person_id) ||
			!isPersonVisibleToUser(person_id, locals.user.id)
		) {
			return fail(400, { error: 'Choose who the gift is for.', values: formValues(fd) });
		}
		if (!title) {
			return fail(400, { error: 'What is the gift?', values: formValues(fd) });
		}

		let price_cents: number | null;
		try {
			price_cents = parseDollarsToCents(trim(fd.get('price')));
		} catch {
			return fail(400, { error: 'Price should look like 24.99', values: formValues(fd) });
		}

		const vendor_id_raw = numOrNull(trim(fd.get('vendor_id')));
		// vendor_id is optional but, if supplied, must point to an extant row.
		// Anything else suggests a stale form / tampered POST — reject loudly.
		if (vendor_id_raw != null && !getVendorById(vendor_id_raw)) {
			return fail(400, { error: 'Pick a vendor from the list.', values: formValues(fd) });
		}

		const shipper_id_raw = numOrNull(trim(fd.get('shipper_id')));
		if (shipper_id_raw != null && !getShipperById(shipper_id_raw)) {
			return fail(400, { error: 'Pick a shipper from the list.', values: formValues(fd) });
		}

		// `ordered` is the default for self-orders (personal packages already on
		// the way). For gift-flow it's "idea" or "planned" (default).
		const rawStatus = fd.get('status');
		const status = rawStatus === 'idea' ? 'idea' : rawStatus === 'ordered' ? 'ordered' : 'planned';
		const gift = createGift(
			{
				person_id,
				title,
				vendor_id: vendor_id_raw,
				shipper_id: shipper_id_raw,
				source_url: nullable(trim(fd.get('source_url'))),
				occasion_id: numOrNull(trim(fd.get('occasion_id'))),
				occasion_year: numOrNull(trim(fd.get('occasion_year'))),
				order_id: nullable(trim(fd.get('order_id'))),
				tracking_number: nullable(trim(fd.get('tracking_number'))),
				price_cents,
				notes: nullable(trim(fd.get('notes'))),
				is_idea: status === 'idea',
				status
			},
			locals.user.id
		);
		deleteDraft(locals.user.id, 'gift');

		// Fire-and-forget Shippo registration. We don't block the redirect on
		// the network call — failures are logged and the next manual or
		// scheduled refresh will pick up the slack.
		if (gift.tracking_number && process.env.SHIPPO_API_KEY) {
			registerWithProvider(gift.id, locals.user.id).catch((err) => {
				console.warn('[gifts/new] Shippo register failed:', err);
			});
		}

		throw redirect(303, `/app/gifts/${gift.id}`);
	},

	discardDraft: ({ locals }) => {
		if (!locals.user) throw error(401, 'Not authenticated');
		deleteDraft(locals.user.id, 'gift');
		throw redirect(303, '/app/gifts/new');
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
		'notes',
		'status'
	]) {
		out[key] = trim(fd.get(key));
	}
	return out;
}
