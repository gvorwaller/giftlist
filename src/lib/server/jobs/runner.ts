import { getDb } from '../db';
import type { JobRun, JobStatus } from '../types';

const STALE_RUNNING_THRESHOLD_MINUTES = 60;

export interface JobResult<T> {
	runId: number;
	status: JobStatus;
	result: T | null;
	error: Error | null;
}

/**
 * Runs a named job exactly once at a time. Writes a job_runs row for
 * observability (running → ok|error) and refuses to start if another
 * run of the same name is already in progress. Stale 'running' rows
 * older than STALE_RUNNING_THRESHOLD_MINUTES are swept to 'error' first
 * so a crashed job doesn't permanently block the name.
 */
export async function runJob<T>(
	name: string,
	fn: () => Promise<T> | T,
	opts?: { summarize?: (result: T) => string }
): Promise<JobResult<T>> {
	const db = getDb();

	// Sweep stuck jobs.
	db.prepare(
		`UPDATE job_runs
		    SET status = 'error',
		        finished_at = CURRENT_TIMESTAMP,
		        error_message = COALESCE(error_message, 'timed out / crashed')
		  WHERE job_name = ?
		    AND status = 'running'
		    AND started_at < datetime('now', '-${STALE_RUNNING_THRESHOLD_MINUTES} minutes')`
	).run(name);

	const existing = db
		.prepare<[string], { id: number }>(
			"SELECT id FROM job_runs WHERE job_name = ? AND status = 'running' LIMIT 1"
		)
		.get(name);
	if (existing) {
		throw new Error(`Job "${name}" is already running (run id ${existing.id})`);
	}

	const info = db
		.prepare(`INSERT INTO job_runs (job_name, status) VALUES (?, 'running')`)
		.run(name);
	const runId = Number(info.lastInsertRowid);

	try {
		const result = await fn();
		const summary = opts?.summarize?.(result) ?? null;
		db.prepare(
			`UPDATE job_runs
			    SET status = 'ok',
			        finished_at = CURRENT_TIMESTAMP,
			        summary = ?
			  WHERE id = ?`
		).run(summary, runId);
		return { runId, status: 'ok', result, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		db.prepare(
			`UPDATE job_runs
			    SET status = 'error',
			        finished_at = CURRENT_TIMESTAMP,
			        error_message = ?
			  WHERE id = ?`
		).run(message.slice(0, 2000), runId);
		const error = err instanceof Error ? err : new Error(message);
		return { runId, status: 'error', result: null, error };
	}
}

export function listJobRuns(opts?: { jobName?: string; limit?: number }): JobRun[] {
	const db = getDb();
	const limit = opts?.limit ?? 50;
	if (opts?.jobName) {
		return db
			.prepare<[string, number], JobRun>(
				`SELECT * FROM job_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`
			)
			.all(opts.jobName, limit);
	}
	return db
		.prepare<[number], JobRun>(`SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?`)
		.all(limit);
}

export function getLastSuccess(jobName: string): JobRun | undefined {
	const db = getDb();
	return db
		.prepare<[string], JobRun>(
			`SELECT * FROM job_runs
			  WHERE job_name = ? AND status = 'ok'
			  ORDER BY started_at DESC LIMIT 1`
		)
		.get(jobName);
}

export function getLastRun(jobName: string): JobRun | undefined {
	const db = getDb();
	return db
		.prepare<[string], JobRun>(
			`SELECT * FROM job_runs
			  WHERE job_name = ?
			  ORDER BY started_at DESC LIMIT 1`
		)
		.get(jobName);
}

export function countFailedRunsSince(iso: string): number {
	const db = getDb();
	const row = db
		.prepare<[string], { cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM job_runs WHERE status = 'error' AND started_at >= ?`
		)
		.get(iso);
	return row?.cnt ?? 0;
}
