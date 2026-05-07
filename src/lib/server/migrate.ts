import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DB } from './db';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');

interface Migration {
	version: number;
	name: string;
	sql: string;
}

/**
 * Loads migrations from ./migrations. Files must be named NNN-description.sql
 * where NNN is a zero-padded integer (e.g. 001-initial-schema.sql).
 */
function loadMigrations(): Migration[] {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort();

	return files.map((filename) => {
		const match = /^(\d+)-(.+)\.sql$/.exec(filename);
		if (!match) {
			throw new Error(`Migration filename does not match NNN-name.sql: ${filename}`);
		}
		return {
			version: parseInt(match[1], 10),
			name: match[2],
			sql: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
		};
	});
}

function getCurrentVersion(db: DB): number {
	// app_state may not exist yet on a fresh DB — catch the "no such table" error.
	try {
		const row = db
			.prepare<[], { value: string }>("SELECT value FROM app_state WHERE key = 'schema_version'")
			.get();
		return row ? parseInt(row.value, 10) : 0;
	} catch {
		return 0;
	}
}

function setCurrentVersion(db: DB, version: number): void {
	db.prepare(
		`INSERT INTO app_state (key, value, updated_at)
		 VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	).run(String(version));
}

/**
 * Runs any migrations whose version > current schema_version.
 * Each migration runs inside a transaction.
 *
 * Foreign keys are toggled OFF before each migration's transaction and ON
 * after. SQLite's documented "12-step" recreate-table pattern requires
 * foreign_keys=OFF *outside* the transaction (the pragma is a no-op inside
 * one), so doing it here gives every migration access to that pattern.
 * After commit we run `PRAGMA foreign_key_check` and abort if the migration
 * left any orphan rows behind.
 */
export function runMigrations(db: DB): { applied: number[]; currentVersion: number } {
	const migrations = loadMigrations();
	const current = getCurrentVersion(db);
	const pending = migrations.filter((m) => m.version > current);
	const applied: number[] = [];

	for (const m of pending) {
		db.pragma('foreign_keys = OFF');
		try {
			db.transaction(() => {
				db.exec(m.sql);
				setCurrentVersion(db, m.version);
			})();
			const violations = db.pragma('foreign_key_check') as Array<{
				table: string;
				rowid: number;
				parent: string;
				fkid: number;
			}>;
			if (violations.length > 0) {
				throw new Error(
					`Migration ${m.version} left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations)}`
				);
			}
		} finally {
			db.pragma('foreign_keys = ON');
		}
		applied.push(m.version);
		console.log(`[migrate] applied ${String(m.version).padStart(3, '0')}-${m.name}`);
	}

	return {
		applied,
		currentVersion: pending.length > 0 ? pending[pending.length - 1].version : current
	};
}
