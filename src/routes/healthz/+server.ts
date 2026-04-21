import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$server/db';
import { getLastSuccess } from '$server/jobs/runner';
import { JOB_NAME as REMINDER_JOB } from '$server/jobs/reminders';
import { lastBackupIso } from '$server/admin-home';

const START_TIME = Date.now();

export const GET: RequestHandler = () => {
	const db = getDb();
	const versionRow = db
		.prepare<[], { value: string }>("SELECT value FROM app_state WHERE key = 'schema_version'")
		.get();
	const lastReminder = getLastSuccess(REMINDER_JOB);
	return json({
		status: 'ok',
		schema_version: versionRow ? Number(versionRow.value) : null,
		uptime_seconds: Math.round((Date.now() - START_TIME) / 1000),
		last_backup_at: lastBackupIso(),
		last_reminder_ok_at: lastReminder?.started_at ?? null
	});
};
