import cron from 'node-cron';
import { runReminderJob } from './jobs/reminders';
import { runAmazonScan, runProcessedCleanup } from './jobs/amazon-import';
import { getDb } from './db';

/**
 * In-process scheduler. Double-guarded: only registers when
 * NODE_ENV=production AND ENABLE_CRON=true.
 *
 * Dev / test can trigger every scheduled action manually from /admin/system
 * and /admin/imports/amazon, so accidental runs in dev can't happen.
 */

let started = false;

function isEnabled(): boolean {
	return process.env.NODE_ENV === 'production' && process.env.ENABLE_CRON === 'true';
}

function getAdminUserId(): number | null {
	const db = getDb();
	const row = db
		.prepare<[], { id: number }>("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
		.get();
	return row?.id ?? null;
}

export function startScheduler(): void {
	if (started) return;
	if (!isEnabled()) {
		console.log('[scheduler] disabled (NODE_ENV or ENABLE_CRON not set for prod)');
		return;
	}
	started = true;

	// Reminder digest — weekdays at 08:00 local time.
	cron.schedule('0 8 * * *', async () => {
		console.log('[cron] reminders.daily firing');
		try {
			await runReminderJob();
		} catch (err) {
			console.error('[cron] reminders.daily failed:', err);
		}
	});
	console.log('[scheduler] registered reminders.daily (0 8 * * *)');

	// Amazon scan — daily at 07:30 so new rows are ready before the digest runs.
	cron.schedule('30 7 * * *', async () => {
		const userId = getAdminUserId();
		if (!userId) {
			console.warn('[cron] amazon.scan skipped — no admin user');
			return;
		}
		console.log('[cron] amazon.scan firing');
		try {
			await runAmazonScan(userId);
		} catch (err) {
			console.error('[cron] amazon.scan failed:', err);
		}
	});
	console.log('[scheduler] registered amazon.scan (30 7 * * *)');

	// Processed cleanup — Sundays at 03:15, trashes messages older than 180 days.
	cron.schedule('15 3 * * 0', async () => {
		const userId = getAdminUserId();
		if (!userId) return;
		console.log('[cron] amazon.cleanup_processed firing');
		try {
			await runProcessedCleanup(userId);
		} catch (err) {
			console.error('[cron] amazon.cleanup_processed failed:', err);
		}
	});
	console.log('[scheduler] registered amazon.cleanup_processed (15 3 * * 0)');
}
