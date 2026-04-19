import { getDb } from './db';
import type { RecentlyViewed, RecentlyViewedEntity } from './types';

const CAP_PER_USER = 10;

/** Insert or update the most recent entry and trim history to the cap. */
export function recordView(
	userId: number,
	entityType: RecentlyViewedEntity,
	entityId: number,
	label: string
): void {
	const db = getDb();
	db.transaction(() => {
		// Collapse duplicates: remove prior rows for the same (user, entity) tuple.
		db.prepare(
			'DELETE FROM recently_viewed WHERE user_id = ? AND entity_type = ? AND entity_id = ?'
		).run(userId, entityType, entityId);

		db.prepare(
			`INSERT INTO recently_viewed (user_id, entity_type, entity_id, label)
			 VALUES (?, ?, ?, ?)`
		).run(userId, entityType, entityId, label);

		// Trim history beyond CAP_PER_USER.
		db.prepare(
			`DELETE FROM recently_viewed
			  WHERE user_id = ?
			    AND id NOT IN (
			      SELECT id FROM recently_viewed
			       WHERE user_id = ?
			       ORDER BY viewed_at DESC
			       LIMIT ?
			    )`
		).run(userId, userId, CAP_PER_USER);
	})();
}

export function listRecent(userId: number, limit = 3): RecentlyViewed[] {
	const db = getDb();
	return db
		.prepare<[number, number], RecentlyViewed>(
			`SELECT * FROM recently_viewed
			  WHERE user_id = ?
			  ORDER BY viewed_at DESC
			  LIMIT ?`
		)
		.all(userId, limit);
}
