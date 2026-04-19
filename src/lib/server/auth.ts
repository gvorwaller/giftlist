import argon2 from 'argon2';
import { getDb } from './db';
import type { User } from './types';

const ARGON2_OPTS: argon2.Options & { raw?: false } = {
	type: argon2.argon2id,
	// OWASP 2024 guidance — keep conservative defaults; tune later if login latency becomes an issue.
	memoryCost: 19456, // 19 MiB
	timeCost: 2,
	parallelism: 1
};

export async function hashPassword(password: string): Promise<string> {
	return argon2.hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
	try {
		return await argon2.verify(hash, password);
	} catch {
		return false;
	}
}

export function findUserByUsername(username: string): User | undefined {
	const db = getDb();
	return db
		.prepare<[string], User>(
			`SELECT id, username, password_hash, role, display_name,
			        last_login_at, last_seen_path, last_seen_at, created_at
			 FROM users WHERE username = ?`
		)
		.get(username);
}

export function recordLogin(userId: number): void {
	const db = getDb();
	db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
}

export function recordLastSeen(userId: number, path: string): void {
	const db = getDb();
	db.prepare(
		`UPDATE users
		    SET last_seen_at = CURRENT_TIMESTAMP, last_seen_path = ?
		  WHERE id = ?`
	).run(path, userId);
}
