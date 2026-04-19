import { getDb } from './db';
import type { ExternalProvider, ExternalToken } from './types';
import { decryptString, encryptString } from './crypto';
import { logAudit } from './audit';

export interface DecryptedToken {
	access_token: string | null;
	refresh_token: string | null;
	expires_at: Date | null;
	scope: string;
	token_type: string | null;
	account_email: string | null;
}

export interface SaveTokenInput {
	access_token?: string | null;
	refresh_token?: string | null;
	expires_at?: Date | null;
	scope: string;
	token_type?: string | null;
	account_email?: string | null;
}

export function getTokenRow(
	userId: number,
	provider: ExternalProvider
): ExternalToken | undefined {
	const db = getDb();
	return db
		.prepare<[number, string], ExternalToken>(
			'SELECT * FROM external_tokens WHERE user_id = ? AND provider = ?'
		)
		.get(userId, provider);
}

export function getDecryptedToken(
	userId: number,
	provider: ExternalProvider
): DecryptedToken | null {
	const row = getTokenRow(userId, provider);
	if (!row) return null;
	return {
		access_token: row.access_token_encrypted ? decryptString(row.access_token_encrypted) : null,
		refresh_token: row.refresh_token_encrypted ? decryptString(row.refresh_token_encrypted) : null,
		expires_at: row.access_token_expires_at ? new Date(row.access_token_expires_at) : null,
		scope: row.scope,
		token_type: row.token_type,
		account_email: row.account_email
	};
}

export function saveToken(
	userId: number,
	provider: ExternalProvider,
	input: SaveTokenInput,
	actorUserId: number
): void {
	const db = getDb();
	const existing = getTokenRow(userId, provider);

	const encAccess = input.access_token ? encryptString(input.access_token) : null;
	const encRefresh = input.refresh_token ? encryptString(input.refresh_token) : null;
	const expiresAt = input.expires_at ? input.expires_at.toISOString() : null;

	if (existing) {
		// Update in place. Preserve existing refresh_token if the new exchange didn't return one
		// (Google only sends refresh_token on the first consent with access_type=offline+prompt=consent).
		const keepRefresh = encRefresh ?? existing.refresh_token_encrypted;
		db.prepare(
			`UPDATE external_tokens
			    SET access_token_encrypted = ?,
			        access_token_expires_at = ?,
			        refresh_token_encrypted = ?,
			        token_type = ?,
			        scope = ?,
			        account_email = COALESCE(?, account_email),
			        updated_at = CURRENT_TIMESTAMP
			  WHERE id = ?`
		).run(
			encAccess,
			expiresAt,
			keepRefresh,
			input.token_type ?? null,
			input.scope,
			input.account_email ?? null,
			existing.id
		);
		logAudit({
			actorUserId,
			entityType: 'user',
			entityId: userId,
			action: 'google_token_refresh',
			summary: `Refreshed ${provider} token for user ${userId}`
		});
		return;
	}

	db.prepare(
		`INSERT INTO external_tokens (
		    user_id, provider, scope, access_token_encrypted, access_token_expires_at,
		    refresh_token_encrypted, token_type, account_email
		  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		userId,
		provider,
		input.scope,
		encAccess,
		expiresAt,
		encRefresh,
		input.token_type ?? null,
		input.account_email ?? null
	);
	logAudit({
		actorUserId,
		entityType: 'user',
		entityId: userId,
		action: 'google_connect',
		summary: `Connected ${provider} account ${input.account_email ?? ''} (scope: ${input.scope})`
	});
}

export function deleteToken(
	userId: number,
	provider: ExternalProvider,
	actorUserId: number
): void {
	const db = getDb();
	const existing = getTokenRow(userId, provider);
	if (!existing) return;
	db.prepare('DELETE FROM external_tokens WHERE id = ?').run(existing.id);
	logAudit({
		actorUserId,
		entityType: 'user',
		entityId: userId,
		action: 'google_disconnect',
		summary: `Disconnected ${provider} account ${existing.account_email ?? ''}`
	});
}
