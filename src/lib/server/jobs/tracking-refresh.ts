import { runJob, type JobResult } from './runner';
import { isAftershipConfigured, pullAllInFlight } from '../tracking';

export const TRACKING_REFRESH_JOB = 'tracking.refresh';

export interface TrackingRefreshResult {
	checked: number;
	updated: number;
	failed: number;
	skipped: boolean;
}

/**
 * Polls AfterShip for every gift with a registered tracking id that hasn't
 * reached a terminal status. Idempotent — duplicate checkpoint events are
 * dropped at the DB layer via the UNIQUE constraint on shipment_events.
 *
 * No-ops with skipped=true if AFTERSHIP_API_KEY isn't configured, so this is
 * safe to schedule regardless of env state.
 */
export async function runTrackingRefresh(
	userId: number
): Promise<JobResult<TrackingRefreshResult>> {
	return runJob<TrackingRefreshResult>(
		TRACKING_REFRESH_JOB,
		async () => {
			if (!isAftershipConfigured()) {
				return { checked: 0, updated: 0, failed: 0, skipped: true };
			}
			const result = await pullAllInFlight(userId);
			return { ...result, skipped: false };
		},
		{
			summarize: (r) =>
				r.skipped
					? 'Skipped — AfterShip not configured'
					: `Checked ${r.checked} in-flight; ${r.updated} updated, ${r.failed} failed`
		}
	);
}
