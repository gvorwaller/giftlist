import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listJobRuns, getLastRun } from '$server/jobs/runner';
import { JOB_NAME as REMINDER_JOB, runReminderJob } from '$server/jobs/reminders';
import {
	JOB_NAME as CHRISTMAS_JOB,
	runChristmasKickoffJob
} from '$server/jobs/christmas-kickoff';
import { lastBackupIso } from '$server/admin-home';
import { configuredChannels } from '$server/notify';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const recentRuns = listJobRuns({ limit: 30 });
	const reminderLast = getLastRun(REMINDER_JOB);
	const christmasLast = getLastRun(CHRISTMAS_JOB);

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
			lastAt: lastBackupIso()
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
	}
};
