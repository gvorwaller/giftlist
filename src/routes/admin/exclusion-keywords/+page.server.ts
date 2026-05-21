import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	createExclusionKeyword,
	getExclusionKeywordById,
	listExclusionKeywords,
	setExclusionKeywordArchived,
	updateExclusionKeyword
} from '$server/exclusion-keywords';

function str(fd: FormData, key: string): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Admin access only.');
	const keywords = listExclusionKeywords({ includeArchived: true });
	return { keywords };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		if (locals.user.role !== 'admin') throw error(403, 'Admin access only.');
		const fd = await request.formData();
		const keyword = str(fd, 'keyword');
		const matchType = str(fd, 'match_type');
		const notes = str(fd, 'notes');
		if (!keyword) return fail(400, { scope: 'create', error: 'Keyword is required.' });
		try {
			createExclusionKeyword(keyword, matchType, notes, locals.user.id);
		} catch (err) {
			return fail(400, {
				scope: 'create',
				error: err instanceof Error ? err.message : 'Could not add keyword.'
			});
		}
		return { scope: 'create', ok: true };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		if (locals.user.role !== 'admin') throw error(403, 'Admin access only.');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		const keyword = str(fd, 'keyword');
		const matchType = str(fd, 'match_type');
		const notes = str(fd, 'notes');
		if (!Number.isInteger(id)) return fail(400, { scope: 'update', error: 'Invalid id.' });
		if (!keyword) return fail(400, { scope: 'update', id, error: 'Keyword is required.' });
		if (!getExclusionKeywordById(id)) return fail(404, { scope: 'update', id, error: 'Not found.' });
		try {
			updateExclusionKeyword(id, { keyword, matchType, notes }, locals.user.id);
		} catch (err) {
			return fail(400, {
				scope: 'update',
				id,
				error: err instanceof Error ? err.message : 'Could not update keyword.'
			});
		}
		return { scope: 'update', id, ok: true };
	},

	archive: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		if (locals.user.role !== 'admin') throw error(403, 'Admin access only.');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id)) return fail(400, { scope: 'archive', error: 'Invalid id.' });
		if (!getExclusionKeywordById(id)) return fail(404, { scope: 'archive', id, error: 'Not found.' });
		setExclusionKeywordArchived(id, true, locals.user.id);
		return { scope: 'archive', id, ok: true };
	},

	unarchive: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		if (locals.user.role !== 'admin') throw error(403, 'Admin access only.');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id)) return fail(400, { scope: 'unarchive', error: 'Invalid id.' });
		if (!getExclusionKeywordById(id)) return fail(404, { scope: 'unarchive', id, error: 'Not found.' });
		setExclusionKeywordArchived(id, false, locals.user.id);
		return { scope: 'unarchive', id, ok: true };
	}
};
