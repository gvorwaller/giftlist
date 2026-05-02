import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDb } from '../db';
import { runJob, type JobResult } from './runner';

export const JOB_NAME = 'backup.sqlite';

// Path the admin home / system page already check via statBackup() — keep
// these in sync. Stored under data/backup/ so it sits alongside the existing
// pre-deploy snapshots.
const BACKUP_FILENAME = 'gifttracker.db';
const BACKUP_DIR = './data/backup';

export interface BackupResult {
	path: string;
	sizeBytes: number;
}

/**
 * Online SQLite backup of the live database. better-sqlite3's .backup() uses
 * SQLite's backup API under the hood: it acquires a read transaction and
 * copies pages without blocking writers. Safe to run while the app serves
 * requests.
 */
export async function runBackupJob(): Promise<JobResult<BackupResult>> {
	return runJob<BackupResult>(
		JOB_NAME,
		async () => {
			const target = resolve(process.cwd(), BACKUP_DIR, BACKUP_FILENAME);
			mkdirSync(dirname(target), { recursive: true });
			await getDb().backup(target);
			const sizeBytes = statSync(target).size;
			return { path: target, sizeBytes };
		},
		{
			summarize: (r) => `Snapshot at ${r.path} (${r.sizeBytes} bytes)`
		}
	);
}
