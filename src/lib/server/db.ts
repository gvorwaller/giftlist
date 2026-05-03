import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = Database.Database;

let instance: DB | null = null;
let checkpointTimer: NodeJS.Timeout | null = null;

const CHECKPOINT_INTERVAL_MS = 1000;

function resolveDbPath(): string {
	// Reading process.env directly (not $env/dynamic/private) so this module
	// also loads cleanly from Node scripts (seed, migrations CLI, tests).
	const raw = process.env.DATABASE_PATH ?? './data/gifttracker.db';
	return resolve(process.cwd(), raw);
}

function openDatabase(): DB {
	const path = resolveDbPath();
	mkdirSync(dirname(path), { recursive: true });

	const db = new Database(path);

	// Forensic-grade durability + concurrent readers during a single writer.
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('foreign_keys = ON');
	db.pragma('busy_timeout = 5000');
	db.pragma('temp_store = MEMORY');

	// Default wal_autocheckpoint is 1000 pages (~4MB). For a low-traffic
	// single-process app that means the WAL can sit unflushed for days, so
	// external readers (TablePlus over SSH, ad-hoc sqlite3 CLI) see stale
	// data. Drop it so writes accumulate at most ~400KB between flushes.
	db.pragma('wal_autocheckpoint = 100');

	return db;
}

function startCheckpointTimer(): void {
	if (checkpointTimer) return;
	// External readers see only the main .db file, not the .db-wal, so they
	// can only ever be as fresh as the most recent checkpoint. Run a passive
	// checkpoint every second so any write becomes externally visible within
	// ~1s. PASSIVE is a no-op when nothing is pending and never blocks
	// active readers — cheap to run continuously.
	checkpointTimer = setInterval(() => {
		try {
			instance?.pragma('wal_checkpoint(PASSIVE)');
		} catch (err) {
			console.warn('[db] checkpoint timer failed:', err);
		}
	}, CHECKPOINT_INTERVAL_MS);
	// Don't let the timer alone keep the process alive on shutdown.
	checkpointTimer.unref();
}

/** Singleton handle. Lazily opens on first call. */
export function getDb(): DB {
	if (!instance) {
		instance = openDatabase();
		startCheckpointTimer();
	}
	return instance;
}

/** Close the singleton. Used by shutdown hooks and tests. */
export function closeDb(): void {
	if (checkpointTimer) {
		clearInterval(checkpointTimer);
		checkpointTimer = null;
	}
	if (instance) {
		instance.close();
		instance = null;
	}
}
