import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import type { User } from './types';

export const SESSION_COOKIE_NAME = 'giftlist_session';
export const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface SessionRow {
	id: string;
	user_id: number;
	created_at: string;
	expires_at: string;
	last_used_at: string;
	user_agent: string | null;
}

function newToken(): string {
	// 32 bytes -> 43 url-safe chars. Roomy enough for long-lived sessions.
	return randomBytes(32).toString('base64url');
}

function isoAfter(ms: number): string {
	return new Date(Date.now() + ms).toISOString();
}

export function createSession(userId: number, userAgent: string | null): SessionRow {
	const db = getDb();
	const id = newToken();
	const now = new Date().toISOString();
	const expiresAt = isoAfter(SESSION_TTL_MS);

	db.prepare(
		`INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, user_agent)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, userId, now, expiresAt, now, userAgent);

	return {
		id,
		user_id: userId,
		created_at: now,
		expires_at: expiresAt,
		last_used_at: now,
		user_agent: userAgent
	};
}

/**
 * Validates a session token. Returns {user, session} when valid; otherwise null.
 * Sliding expiry: refreshes last_used_at + extends expires_at each successful call.
 */
export function validateSession(
	token: string
): { user: User; session: SessionRow } | null {
	const db = getDb();
	const row = db
		.prepare<
			[string],
			SessionRow & User & { uid: number; u_created_at: string }
		>(
			`SELECT
			    s.id           AS id,
			    s.user_id      AS user_id,
			    s.created_at   AS created_at,
			    s.expires_at   AS expires_at,
			    s.last_used_at AS last_used_at,
			    s.user_agent   AS user_agent,
			    u.id           AS uid,
			    u.username     AS username,
			    u.password_hash AS password_hash,
			    u.role         AS role,
			    u.display_name AS display_name,
			    u.last_login_at AS last_login_at,
			    u.last_seen_path AS last_seen_path,
			    u.last_seen_at AS last_seen_at,
			    u.created_at   AS u_created_at
			 FROM sessions s
			 JOIN users u ON u.id = s.user_id
			 WHERE s.id = ?`
		)
		.get(token);

	if (!row) return null;

	const now = Date.now();
	const expiresAtMs = Date.parse(row.expires_at);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
		db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
		return null;
	}

	const nowIso = new Date(now).toISOString();
	const nextExpiry = isoAfter(SESSION_TTL_MS);
	db.prepare(
		'UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?'
	).run(nowIso, nextExpiry, token);

	const session: SessionRow = {
		id: row.id,
		user_id: row.user_id,
		created_at: row.created_at,
		expires_at: nextExpiry,
		last_used_at: nowIso,
		user_agent: row.user_agent
	};

	const user: User = {
		id: row.uid,
		username: row.username,
		password_hash: row.password_hash,
		role: row.role,
		display_name: row.display_name,
		last_login_at: row.last_login_at,
		last_seen_path: row.last_seen_path,
		last_seen_at: row.last_seen_at,
		created_at: row.u_created_at
	};

	return { user, session };
}

export function destroySession(token: string): void {
	const db = getDb();
	db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

export function destroyAllSessionsForUser(userId: number): void {
	const db = getDb();
	db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions(): number {
	const db = getDb();
	const result = db
		.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP")
		.run();
	return result.changes;
}
