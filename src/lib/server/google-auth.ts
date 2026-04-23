import { google } from 'googleapis';
import type { Credentials, OAuth2Client } from 'google-auth-library';
import { getDecryptedToken, saveToken } from './external-tokens';

export const GOOGLE_SCOPES = [
	'https://www.googleapis.com/auth/contacts.readonly',
	// gmail.modify is a superset of gmail.readonly; needed so the app can
	// add/remove labels and trash parsed messages during Amazon import.
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/userinfo.email',
	'openid'
];

export const REQUIRED_GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export function tokenHasGmailModify(scopeString: string | null | undefined): boolean {
	if (!scopeString) return false;
	return scopeString.split(/\s+/).includes(REQUIRED_GMAIL_SCOPE);
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

export function buildOAuth2Client(): OAuth2Client {
	return new google.auth.OAuth2(
		requireEnv('GOOGLE_CLIENT_ID'),
		requireEnv('GOOGLE_CLIENT_SECRET'),
		requireEnv('GOOGLE_REDIRECT_URI')
	);
}

export function buildAuthUrl(state: string): string {
	const client = buildOAuth2Client();
	return client.generateAuthUrl({
		access_type: 'offline',
		// Force the consent screen so Google returns a refresh_token every time —
		// without this the second connect only returns access_token and we lose
		// the long-lived grant.
		prompt: 'consent',
		scope: GOOGLE_SCOPES,
		include_granted_scopes: true,
		state
	});
}

export interface ExchangeResult {
	credentials: Credentials;
	email: string | null;
}

export async function exchangeCodeForTokens(code: string): Promise<ExchangeResult> {
	const client = buildOAuth2Client();
	const { tokens } = await client.getToken(code);
	client.setCredentials(tokens);

	// Fetch the account email so we can display which Google account is connected.
	let email: string | null = null;
	try {
		const oauth2 = google.oauth2({ version: 'v2', auth: client });
		const info = await oauth2.userinfo.get();
		email = info.data.email ?? null;
	} catch {
		// userinfo endpoint requires openid + email scopes; keep failure non-fatal.
	}

	return { credentials: tokens, email };
}

/**
 * Persist a successful OAuth exchange result for the given user.
 */
export function persistTokens(
	userId: number,
	result: ExchangeResult,
	actorUserId: number
): void {
	const { credentials, email } = result;
	saveToken(
		userId,
		'google',
		{
			access_token: credentials.access_token ?? null,
			refresh_token: credentials.refresh_token ?? null,
			expires_at: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
			scope: credentials.scope ?? GOOGLE_SCOPES.join(' '),
			token_type: credentials.token_type ?? 'Bearer',
			account_email: email
		},
		actorUserId
	);
}

/**
 * Returns an OAuth2Client ready to call Google APIs on behalf of the user.
 * Auto-refreshes the access token when it's near expiry, persisting the new
 * access token + expiry back to external_tokens.
 *
 * Throws if the user has no refresh token on file.
 */
export function getClientForUser(userId: number): OAuth2Client {
	const stored = getDecryptedToken(userId, 'google');
	if (!stored || !stored.refresh_token) {
		throw new Error(`No Google connection for user ${userId}`);
	}

	const client = buildOAuth2Client();
	client.setCredentials({
		access_token: stored.access_token ?? undefined,
		refresh_token: stored.refresh_token,
		expiry_date: stored.expires_at?.getTime() ?? undefined,
		token_type: stored.token_type ?? 'Bearer',
		scope: stored.scope
	});

	// googleapis fires this event when it refreshes the access token under us.
	client.on('tokens', (tokens) => {
		saveToken(
			userId,
			'google',
			{
				access_token: tokens.access_token ?? stored.access_token,
				refresh_token: tokens.refresh_token ?? stored.refresh_token,
				expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : stored.expires_at,
				scope: tokens.scope ?? stored.scope,
				token_type: tokens.token_type ?? stored.token_type,
				account_email: stored.account_email
			},
			userId
		);
	});

	return client;
}
