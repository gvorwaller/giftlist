import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTokenRow } from '$server/external-tokens';
import {
	commitImport,
	previewImport,
	refreshBirthYears,
	type NormalizedContact
} from '$server/contacts-import';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const token = getTokenRow(locals.user.id, 'google');
	if (!token || !token.refresh_token_encrypted) {
		return { connected: false as const };
	}

	try {
		const preview = await previewImport(locals.user.id);
		return {
			connected: true as const,
			preview,
			flash: {
				imported: Number(url.searchParams.get('imported') ?? '0'),
				birthdays: Number(url.searchParams.get('birthdays') ?? '0'),
				error: url.searchParams.get('error')
			}
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'fetch_failed';
		console.error('[contacts-import] preview failed:', msg);
		return {
			connected: true as const,
			preview: null,
			fetchError: msg,
			flash: { imported: 0, birthdays: 0, yearsBackfilled: 0, error: null as string | null }
		};
	}
};

export const actions: Actions = {
	import: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const fd = await request.formData();
		const selected = new Set(fd.getAll('resource_name').map(String));
		if (selected.size === 0) {
			return fail(400, { error: 'Pick at least one contact to import.' });
		}

		let preview;
		try {
			preview = await previewImport(locals.user.id);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'fetch_failed';
			return fail(502, { error: `Google People API failed: ${msg}` });
		}

		const chosen: NormalizedContact[] = preview.newContacts.filter((c) =>
			selected.has(c.resource_name)
		);
		if (chosen.length === 0) {
			return fail(400, { error: 'None of the selected contacts were still eligible.' });
		}

		const result = commitImport(locals.user.id, chosen, locals.user.id);
		throw redirect(
			303,
			`/admin/imports/contacts?imported=${result.peopleCreated}&birthdays=${result.birthdaysAssigned}&years=${result.yearsBackfilled}`
		);
	},

	refreshYears: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		try {
			const { updated } = await refreshBirthYears(locals.user.id, locals.user.id);
			throw redirect(303, `/admin/imports/contacts?years=${updated}`);
		} catch (err) {
			if (err instanceof Response || (err as { status?: number })?.status === 303) throw err;
			const msg = err instanceof Error ? err.message : 'refresh_failed';
			return fail(502, { error: `Refresh failed: ${msg}` });
		}
	}
};
