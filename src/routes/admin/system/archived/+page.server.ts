import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$server/db';
import { archiveGift } from '$server/gifts';

/**
 * td-dc1846: admin browser for archived gifts/packages, with chronological
 * sort (by archived_at, mig 022), search across title + person, and inline
 * restore.
 *
 * Complements — does NOT replace — the existing per-person "Past gifts"
 * section on /app/people/[id]. Use this when you need to find an archived
 * row without navigating through the person first.
 */

const PAGE_SIZE = 50;

function parsePositiveInt(v: string | null): number | undefined {
	if (!v) return undefined;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function trimOrUndefined(v: string | null): string | undefined {
	if (!v) return undefined;
	const t = v.trim();
	return t === '' ? undefined : t;
}

interface ArchivedRow {
	id: number;
	title: string;
	status: string;
	order_id: string | null;
	archived_at: string | null;
	updated_at: string;
	person_id: number;
	person_display_name: string;
	vendor_name: string | null;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Admin access only.');

	const pageNum = Math.max(parsePositiveInt(url.searchParams.get('page')) ?? 1, 1);
	const q = trimOrUndefined(url.searchParams.get('q'));
	const offset = (pageNum - 1) * PAGE_SIZE;

	const db = getDb();
	const where: string[] = ['g.is_archived = 1'];
	const params: (string | number)[] = [];
	if (q) {
		where.push('(g.title LIKE ? OR p.display_name LIKE ?)');
		const like = `%${q}%`;
		params.push(like, like);
	}
	const whereSql = where.join(' AND ');

	const total = db
		.prepare<typeof params, { c: number }>(
			`SELECT COUNT(*) AS c
			   FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE ${whereSql}`
		)
		.get(...params)!.c;

	const rows = db
		.prepare<(string | number)[], ArchivedRow>(
			`SELECT g.id, g.title, g.status, g.order_id, g.archived_at, g.updated_at,
			        g.person_id, p.display_name AS person_display_name,
			        v.name AS vendor_name
			   FROM gifts g
			   JOIN people p ON p.id = g.person_id
			   LEFT JOIN vendors v ON v.id = g.vendor_id
			  WHERE ${whereSql}
			  ORDER BY g.archived_at DESC NULLS LAST, g.id DESC
			  LIMIT ? OFFSET ?`
		)
		.all(...params, PAGE_SIZE, offset);

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return {
		rows,
		total,
		page: pageNum,
		totalPages,
		pageSize: PAGE_SIZE,
		q: q ?? ''
	};
};

export const actions: Actions = {
	restore: async ({ locals, request, url }) => {
		if (!locals.user) throw redirect(303, '/login');
		if (locals.user.role !== 'admin') throw error(403, 'Admin access only.');
		const fd = await request.formData();
		const giftId = Number(fd.get('gift_id'));
		if (!Number.isFinite(giftId) || giftId <= 0) {
			return fail(400, { error: 'Missing gift id.' });
		}
		archiveGift(giftId, false, locals.user.id);
		// Preserve current page + search context on redirect.
		const qs = new URLSearchParams();
		const page = url.searchParams.get('page');
		const q = url.searchParams.get('q');
		if (page) qs.set('page', page);
		if (q) qs.set('q', q);
		qs.set('restored', '1');
		throw redirect(303, `/admin/system/archived?${qs.toString()}`);
	}
};
