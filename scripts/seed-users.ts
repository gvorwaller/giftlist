/**
 * Seed / update the two fixed accounts.
 *
 * Reads from environment variables (no interactive prompts, no hardcoded secrets):
 *   ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_DISPLAY_NAME
 *   MANAGER_USERNAME, MANAGER_PASSWORD, MANAGER_DISPLAY_NAME
 *
 * Idempotent: inserts on first run, updates password_hash + display_name thereafter.
 *
 * Usage:
 *   npm run seed
 *   (loads .env via dotenv/config)
 */

import 'dotenv/config';
import { getDb, closeDb } from '../src/lib/server/db.js';
import { runMigrations } from '../src/lib/server/migrate.js';
import { hashPassword } from '../src/lib/server/auth.js';
import type { Role, User } from '../src/lib/server/types.js';

interface SeedSpec {
	envPrefix: 'ADMIN' | 'MANAGER';
	role: Role;
	defaultDisplayName: string;
}

const SPECS: SeedSpec[] = [
	{ envPrefix: 'ADMIN', role: 'admin', defaultDisplayName: 'Admin' },
	{ envPrefix: 'MANAGER', role: 'manager', defaultDisplayName: 'Manager' }
];

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v || v.trim() === '') {
		throw new Error(`Missing required env var: ${name}`);
	}
	return v;
}

async function upsertUser(spec: SeedSpec): Promise<{ action: 'created' | 'updated'; user: User }> {
	const username = requireEnv(`${spec.envPrefix}_USERNAME`);
	const password = requireEnv(`${spec.envPrefix}_PASSWORD`);
	const displayName = process.env[`${spec.envPrefix}_DISPLAY_NAME`] ?? spec.defaultDisplayName;

	const db = getDb();
	const hash = await hashPassword(password);

	const existing = db
		.prepare<[string], User>(
			`SELECT id, username, password_hash, role, display_name,
			        last_login_at, last_seen_path, last_seen_at, created_at
			 FROM users WHERE username = ?`
		)
		.get(username);

	if (existing) {
		db.prepare(
			`UPDATE users
			    SET password_hash = ?, display_name = ?, role = ?
			  WHERE id = ?`
		).run(hash, displayName, spec.role, existing.id);
		return { action: 'updated', user: { ...existing, password_hash: hash, display_name: displayName, role: spec.role } };
	}

	const info = db
		.prepare(
			`INSERT INTO users (username, password_hash, role, display_name)
			 VALUES (?, ?, ?, ?)`
		)
		.run(username, hash, spec.role, displayName);

	const created = db
		.prepare<[number | bigint], User>(
			`SELECT id, username, password_hash, role, display_name,
			        last_login_at, last_seen_path, last_seen_at, created_at
			 FROM users WHERE id = ?`
		)
		.get(info.lastInsertRowid)!;
	return { action: 'created', user: created };
}

async function main(): Promise<void> {
	const db = getDb();
	runMigrations(db);

	for (const spec of SPECS) {
		const { action, user } = await upsertUser(spec);
		console.log(`[seed] ${action}: ${user.role} '${user.username}' (${user.display_name})`);
	}

	closeDb();
}

main().catch((err) => {
	console.error('[seed] failed:', err instanceof Error ? err.message : err);
	closeDb();
	process.exit(1);
});
