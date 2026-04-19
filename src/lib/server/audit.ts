import { getDb } from './db';

export interface AuditInput {
	actorUserId: number;
	entityType: 'person' | 'person_occasion' | 'occasion' | 'gift' | 'draft' | 'user' | 'import';
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
