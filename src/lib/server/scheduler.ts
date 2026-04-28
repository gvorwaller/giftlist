import cron from 'node-cron';
import { runReminderJob } from './jobs/reminders';
import { runAmazonScan, runProcessedCleanup } from './jobs/amazon-import';
import { runChristmasKickoffJob } from './jobs/christmas-kickoff';
import { getDb } from './db';

/**
 * In-process scheduler. Double-guarded: only registers when
 * NODE_ENV=production AND ENABLE_CRON=true.
 *
 * Dev / test can trigger every scheduled action manually from /admin/system
 * and /admin/imports/amazon, so accidental runs in dev can't happen.
 *
 * Cron expressions are env-tunable so peak-season cadence (e.g. every 6h
 * in December) doesn't need a code change — see .env.example.
 */

let started = false;

const DEFAULTS = {
	reminders: '0 8 * * *', // 08:00 daily
	amazonScan: '30 7 * * *', // 07:30 daily, before reminders so the digest sees fresh pending counts
	cleanup: '15 3 * * 0', // 03:15 Sundays
	christmasKickoff: '0 8 1 9 *' // Sept 1 at 08:00 — wife's gift-shopping kickoff
};

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

function expr(envKey: string, fallback: string): string {
	const raw = (process.env[envKey] ?? '').trim();
	if (!raw) return fallback;
	if (!cron.validate(raw)) {
		console.warn(`[scheduler] invalid cron in ${envKey}=${raw}; using default ${fallback}`);
		return fallback;
	}
	return raw;
}

export function startScheduler(): void {
	if (started) return;
	if (!isEnabled()) {
		console.log('[scheduler] disabled (NODE_ENV or ENABLE_CRON not set for prod)');
		return;
	}
	started = true;

	const reminderCron = expr('REMINDER_CRON', DEFAULTS.reminders);
	cron.schedule(reminderCron, async () => {
		console.log('[cron] reminders.daily firing');
		try {
			await runReminderJob();
		} catch (err) {
			console.error('[cron] reminders.daily failed:', err);
		}
	});
	console.log(`[scheduler] registered reminders.daily (${reminderCron})`);

	const amazonScanCron = expr('AMAZON_SCAN_CRON', DEFAULTS.amazonScan);
	cron.schedule(amazonScanCron, async () => {
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
	console.log(`[scheduler] registered amazon.scan (${amazonScanCron})`);

	const cleanupCron = expr('AMAZON_CLEANUP_CRON', DEFAULTS.cleanup);
	cron.schedule(cleanupCron, async () => {
		const userId = getAdminUserId();
		if (!userId) return;
		console.log('[cron] amazon.cleanup_processed firing');
		try {
			await runProcessedCleanup(userId);
		} catch (err) {
			console.error('[cron] amazon.cleanup_processed failed:', err);
		}
	});
	console.log(`[scheduler] registered amazon.cleanup_processed (${cleanupCron})`);

	const christmasKickoffCron = expr('CHRISTMAS_KICKOFF_CRON', DEFAULTS.christmasKickoff);
	cron.schedule(christmasKickoffCron, async () => {
		console.log('[cron] christmas.kickoff firing');
		try {
			await runChristmasKickoffJob();
		} catch (err) {
			console.error('[cron] christmas.kickoff failed:', err);
		}
	});
	console.log(`[scheduler] registered christmas.kickoff (${christmasKickoffCron})`);
}
