import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listPeople, getPersonById } from '$server/people';
import { listPersonOccasions, nextOccurrenceDate } from '$server/occasions';
import { createGift, parseDollarsToCents } from '$server/gifts';
import { deleteDraft, getFreshDraft, parseDraftPayload } from '$server/drafts';
import type { OccasionWithLink } from '$server/occasions';

export interface GiftDraftPayload {
	person_id?: number | null;
	title?: string;
	source?: string;
	source_url?: string;
	occasion_id?: number | null;
	occasion_year?: number | null;
	order_id?: string;
	tracking_number?: string;
	carrier?: string;
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

	const people = listPeople({ includeArchived: false, sort: 'alphabetical' });
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
		if (Number.isInteger(pid) && getPersonById(pid)) {
			prefill.person_id = pid;
		}
	}

	const activePersonId = prefill.person_id ?? null;
	const personOccasions = activePersonId ? listPersonOccasions(activePersonId) : [];

	// When the form opens for a specific person and no occasion was selected in
	// the draft, default to that person's next upcoming occasion so the Today
	// screen's "Next Best Action" can later recognize this gift as handling it.
	if (activePersonId && !prefill.occasion_id && personOccasions.length > 0) {
		const nearest = pickNearestOccurrence(personOccasions);
		if (nearest) {
			prefill.occasion_id = nearest.id;
			prefill.occasion_year = nearest.date.getFullYear();
		}
	}

	return {
		people,
		personOccasions,
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
		if (!Number.isInteger(person_id) || !getPersonById(person_id)) {
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

		const status = fd.get('status') === 'idea' ? 'idea' : 'planned';
		const gift = createGift(
			{
				person_id,
				title,
				source: nullable(trim(fd.get('source'))),
				source_url: nullable(trim(fd.get('source_url'))),
				occasion_id: numOrNull(trim(fd.get('occasion_id'))),
				occasion_year: numOrNull(trim(fd.get('occasion_year'))),
				order_id: nullable(trim(fd.get('order_id'))),
				tracking_number: nullable(trim(fd.get('tracking_number'))),
				carrier: nullable(trim(fd.get('carrier'))),
				price_cents,
				notes: nullable(trim(fd.get('notes'))),
				is_idea: status === 'idea',
				status
			},
			locals.user.id
		);
		deleteDraft(locals.user.id, 'gift');
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
		'source',
		'source_url',
		'occasion_id',
		'occasion_year',
		'order_id',
		'tracking_number',
		'carrier',
		'price',
		'notes',
		'status'
	]) {
		out[key] = trim(fd.get(key));
	}
	return out;
}
