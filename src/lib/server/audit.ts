import { getDb } from './db';

export type AuditEntityType =
	| 'person'
	| 'person_occasion'
	| 'occasion'
	| 'gift'
	| 'draft'
	| 'user'
	| 'import';

export interface AuditInput {
	actorUserId: number;
	entityType: AuditEntityType;
	entityId: number;
	action: string;
	summary: string;
}

export function logAudit(input: AuditInput): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO audit_log (actor_user_id, entity_type, entity_id, action, summary)
		 VALUES (?, ?, ?, ?, ?)`
	).run(input.actorUserId, input.entityType, input.entityId, input.action, input.summary);
}

export interface AuditLogRow {
	id: number;
	actor_user_id: number;
	actor_username: string;
	actor_display_name: string;
	entity_type: string;
	entity_id: number;
	action: string;
	summary: string;
	created_at: string;
}

export interface AuditLogQuery {
	actorUserId?: number;
	entityType?: string;
	action?: string;
	q?: string; // free-text in summary
	since?: string; // ISO date (inclusive)
	until?: string; // ISO date (inclusive — adds end-of-day below)
	limit?: number;
	offset?: number;
}

export interface AuditLogPage {
	rows: AuditLogRow[];
	total: number;
}

/**
 * Paginated audit log with optional filters. Joins users for the actor's
 * display name so the viewer doesn't need a second query.
 */
export function listAuditLog(query: AuditLogQuery = {}): AuditLogPage {
	const db = getDb();
	const where: string[] = [];
	const params: (string | number)[] = [];

	if (query.actorUserId != null) {
		where.push('a.actor_user_id = ?');
		params.push(query.actorUserId);
	}
	if (query.entityType) {
		where.push('a.entity_type = ?');
		params.push(query.entityType);
	}
	if (query.action) {
		where.push('a.action = ?');
		params.push(query.action);
	}
	if (query.q) {
		where.push('a.summary LIKE ?');
		params.push(`%${query.q}%`);
	}
	if (query.since) {
		where.push('a.created_at >= ?');
		params.push(query.since);
	}
	if (query.until) {
		// Inclusive end-of-day so a YYYY-MM-DD value catches everything that day.
		where.push('a.created_at <= ?');
		params.push(`${query.until} 23:59:59`);
	}

	const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
	const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
	const offset = Math.max(query.offset ?? 0, 0);

	const total = db
		.prepare<typeof params, { cnt: number }>(`SELECT COUNT(*) AS cnt FROM audit_log a ${whereSql}`)
		.get(...params)?.cnt ?? 0;

	const rows = db
		.prepare<typeof params, AuditLogRow>(
			`SELECT a.id, a.actor_user_id, a.entity_type, a.entity_id, a.action, a.summary, a.created_at,
			        u.username AS actor_username, u.display_name AS actor_display_name
			   FROM audit_log a
			   JOIN users u ON u.id = a.actor_user_id
			   ${whereSql}
			   ORDER BY a.created_at DESC, a.id DESC
			   LIMIT ${limit} OFFSET ${offset}`
		)
		.all(...params);

	return { rows, total };
}

/**
 * Distinct values for filter dropdowns. Pulled from the audit log itself so
 * we only show options that actually appear in the data.
 */
export function getAuditFilterOptions(): {
	actors: { id: number; display_name: string }[];
	entityTypes: string[];
	actions: string[];
} {
	const db = getDb();
	const actors = db
		.prepare<[], { id: number; display_name: string }>(
			`SELECT DISTINCT u.id, u.display_name
			   FROM audit_log a
			   JOIN users u ON u.id = a.actor_user_id
			  ORDER BY u.display_name`
		)
		.all();
	const entityTypes = db
		.prepare<[], { entity_type: string }>(
			`SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type`
		)
		.all()
		.map((r) => r.entity_type);
	const actions = db
		.prepare<[], { action: string }>(`SELECT DISTINCT action FROM audit_log ORDER BY action`)
		.all()
		.map((r) => r.action);
	return { actors, entityTypes, actions };
}
