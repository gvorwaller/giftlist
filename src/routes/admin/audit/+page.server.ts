import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getAuditFilterOptions, listAuditLog } from '$server/audit';

const PAGE_SIZE = 50;

function trimOrUndefined(v: string | null): string | undefined {
	if (!v) return undefined;
	const t = v.trim();
	return t === '' ? undefined : t;
}

function parsePositiveInt(v: string | null): number | undefined {
	if (!v) return undefined;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const page = Math.max(parsePositiveInt(url.searchParams.get('page')) ?? 1, 1);
	const actorUserId = parsePositiveInt(url.searchParams.get('actor'));
	const entityType = trimOrUndefined(url.searchParams.get('entity'));
	const action = trimOrUndefined(url.searchParams.get('action'));
	const q = trimOrUndefined(url.searchParams.get('q'));
	const since = trimOrUndefined(url.searchParams.get('since'));
	const until = trimOrUndefined(url.searchParams.get('until'));

	const offset = (page - 1) * PAGE_SIZE;
	const { rows, total } = listAuditLog({
		actorUserId,
		entityType,
		action,
		q,
		since,
		until,
		limit: PAGE_SIZE,
		offset
	});

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const filters = getAuditFilterOptions();

	return {
		rows,
		total,
		page,
		totalPages,
		pageSize: PAGE_SIZE,
		filters,
		applied: { actorUserId, entityType, action, q, since, until }
	};
};
