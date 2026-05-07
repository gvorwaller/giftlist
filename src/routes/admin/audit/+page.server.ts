import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getAuditFilterOptions, listAuditLog } from '$server/audit';
import { getDb } from '$server/db';

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

	// Map import-entity rows to their run source so the link can route to
	// the correct review page (Amazon vs Tracking). td-61017c source-aware
	// fan-out fix.
	const importEntityIds = rows
		.filter((r) => r.entity_type === 'import' && r.entity_id > 0)
		.map((r) => r.entity_id);
	const importSources: Record<number, string> = {};
	if (importEntityIds.length > 0) {
		const db = getDb();
		const placeholders = importEntityIds.map(() => '?').join(',');
		const sources = db
			.prepare<number[], { id: number; source: string }>(
				`SELECT id, source FROM import_runs WHERE id IN (${placeholders})`
			)
			.all(...importEntityIds);
		for (const s of sources) importSources[s.id] = s.source;
	}

	return {
		rows,
		total,
		page,
		totalPages,
		pageSize: PAGE_SIZE,
		filters,
		importSources,
		applied: { actorUserId, entityType, action, q, since, until }
	};
};
