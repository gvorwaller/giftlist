import type { PageServerLoad } from './$types';
import { getDb } from '$server/db';

export const load: PageServerLoad = () => {
	const db = getDb();
	const row = db
		.prepare<[], { value: string }>("SELECT value FROM app_state WHERE key = 'schema_version'")
		.get();
	return {
		schemaVersion: row ? parseInt(row.value, 10) : 0
	};
};
