import type { Handle } from '@sveltejs/kit';
import { getDb } from '$server/db';
import { runMigrations } from '$server/migrate';

// Boot-time: open the DB, run pending migrations. Runs once per process.
const db = getDb();
const { applied, currentVersion } = runMigrations(db);
if (applied.length > 0) {
	console.log(`[boot] schema migrated to version ${currentVersion} (${applied.length} applied)`);
} else {
	console.log(`[boot] schema at version ${currentVersion}`);
}

export const handle: Handle = async ({ event, resolve }) => {
	// Phase 1 will attach the session user here.
	event.locals.user = null;
	return resolve(event);
};
