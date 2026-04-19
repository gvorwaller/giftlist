import type { Handle } from '@sveltejs/kit';
import { getDb } from '$server/db';
import { runMigrations } from '$server/migrate';
import { SESSION_COOKIE_NAME, validateSession } from '$server/session';
import { recordLastSeen } from '$server/auth';
import { dev } from '$app/environment';

// Boot-time: open the DB, run pending migrations. Runs once per process.
const db = getDb();
const { applied, currentVersion } = runMigrations(db);
if (applied.length > 0) {
	console.log(`[boot] schema migrated to version ${currentVersion} (${applied.length} applied)`);
} else {
	console.log(`[boot] schema at version ${currentVersion}`);
}

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE_NAME);

	if (token) {
		const result = validateSession(token);
		if (result) {
			event.locals.user = result.user;

			// Track manager/admin's last-seen path for the Today screen and admin context.
			// Skip noisy asset routes.
			const path = event.url.pathname;
			if (!path.startsWith('/_app') && !path.startsWith('/api/')) {
				recordLastSeen(result.user.id, path);
			}
		} else {
			// Session invalid or expired — clear the cookie.
			event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
			event.locals.user = null;
		}
	} else {
		event.locals.user = null;
	}

	return resolve(event);
};

// Used by login/logout to set/clear the cookie with consistent attributes.
// SameSite=Lax (not Strict) so the cookie rides on cross-site redirects back
// to us — required for OAuth callbacks (Google -> /admin/settings/google/callback).
// SvelteKit's built-in CSRF guard (origin check on form POSTs) still protects
// mutations; SameSite=Lax blocks cross-site POSTs anyway.
export const SESSION_COOKIE_OPTS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure: !dev,
	maxAge: 60 * 60 * 24 * 30 // 30 days
};
