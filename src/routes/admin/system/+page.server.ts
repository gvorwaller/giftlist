import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listJobRuns, getLastRun } from '$server/jobs/runner';
import { JOB_NAME as REMINDER_JOB, runReminderJob } from '$server/jobs/reminders';
import {
	JOB_NAME as CHRISTMAS_JOB,
	runChristmasKickoffJob
} from '$server/jobs/christmas-kickoff';
import { JOB_NAME as BACKUP_JOB, runBackupJob } from '$server/jobs/backup';
import { TRACKING_REFRESH_JOB, runTrackingRefresh } from '$server/jobs/tracking-refresh';
import { isTrackingProviderConfigured } from '$server/tracking';
import { lastBackupIso } from '$server/admin-home';
import { configuredChannels } from '$server/notify';
import { clearAllCache, countCacheRows } from '$server/matcher-feedback';
import { AUTO_ACCEPT_FLAG } from '$server/jobs/amazon-import';
import { getBoolFlag, setBoolFlag } from '$server/app-state';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const recentRuns = listJobRuns({ limit: 30 });
	const reminderLast = getLastRun(REMINDER_JOB);
	const christmasLast = getLastRun(CHRISTMAS_JOB);
	const backupLast = getLastRun(BACKUP_JOB);
	const trackingLast = getLastRun(TRACKING_REFRESH_JOB);

	return {
		recentRuns,
		reminderJob: {
			name: REMINDER_JOB,
			lastRun: reminderLast ?? null,
			channels: configuredChannels()
		},
		christmasJob: {
			name: CHRISTMAS_JOB,
			lastRun: christmasLast ?? null
		},
		backup: {
			path: './data/backup/gifttracker.db',
			lastAt: lastBackupIso(),
			lastRun: backupLast ?? null
		},
		tracking: {
			name: TRACKING_REFRESH_JOB,
			lastRun: trackingLast ?? null,
			configured: isTrackingProviderConfigured()
		},
		llmCache: {
			count: countCacheRows()
		},
		autoAccept: {
			enabled: getBoolFlag(AUTO_ACCEPT_FLAG)
		}
	};
};

export const actions: Actions = {
	runReminderNow: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		try {
			const result = await runReminderJob();
			if (result.status === 'error') {
				return fail(500, { error: result.error?.message ?? 'Unknown failure' });
			}
			return { ok: true, summary: `Ran reminders (run ${result.runId})` };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(409, { error: message });
		}
	},

	runChristmasKickoffNow: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		try {
			const result = await runChristmasKickoffJob();
			if (result.status === 'error') {
				return fail(500, { error: result.error?.message ?? 'Unknown failure' });
			}
			return { ok: true, summary: `Ran Christmas kickoff (run ${result.runId})` };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(409, { error: message });
		}
	},

	runBackupNow: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		try {
			const result = await runBackupJob();
			if (result.status === 'error') {
				return fail(500, { error: result.error?.message ?? 'Unknown failure' });
			}
			return { ok: true, summary: `Backup snapshot written (run ${result.runId})` };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(409, { error: message });
		}
	},

	runTrackingRefreshNow: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		try {
			const result = await runTrackingRefresh(locals.user.id);
			if (result.status === 'error') {
				return fail(500, { error: result.error?.message ?? 'Unknown failure' });
			}
			const r = result.result!;
			const summary = r.skipped
				? 'Skipped — Shippo not configured'
				: `Checked ${r.checked} in-flight, ${r.updated} updated, ${r.failed} failed`;
			return { ok: true, summary };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(409, { error: message });
		}
	},

	// Phase 4 (4b): manually nuke the LLM matcher cache. Non-destructive to
	// gift data — verdicts simply regenerate on the next scan/review. Useful
	// after a bulk gift edit when the admin wants fresh matches now instead of
	// waiting out the 7-day TTL.
	clearLlmCache: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		try {
			const count = clearAllCache();
			return { ok: true, summary: `Cleared LLM matcher cache (${count} entr${count === 1 ? 'y' : 'ies'})` };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return fail(409, { error: message });
		}
	},

	// Phase B (td-dbaa0c): flip the daily-scan auto-accept toggle. Off by
	// default; turn on once the manual "Commit all high-confidence" button
	// has earned trust. Link-only — never auto-creates a gift.
	toggleAutoAccept: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const now = getBoolFlag(AUTO_ACCEPT_FLAG);
		setBoolFlag(AUTO_ACCEPT_FLAG, !now);
		return {
			ok: true,
			summary: `Automatic auto-accept ${!now ? 'enabled' : 'disabled'}.`
		};
	}
};
