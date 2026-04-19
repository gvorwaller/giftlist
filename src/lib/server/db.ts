import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = Database.Database;

let instance: DB | null = null;

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

	return db;
}

/** Singleton handle. Lazily opens on first call. */
export function getDb(): DB {
	if (!instance) {
		instance = openDatabase();
	}
	return instance;
}

/** Close the singleton. Used by shutdown hooks and tests. */
export function closeDb(): void {
	if (instance) {
		instance.close();
		instance = null;
	}
}
