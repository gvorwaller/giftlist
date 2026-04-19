import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { findUserByUsername, recordLogin, verifyPassword } from '$server/auth';
import { createSession } from '$server/session';
import { SESSION_COOKIE_OPTS } from '../../hooks.server';
import { SESSION_COOKIE_NAME } from '$server/session';

function landingFor(role: 'manager' | 'admin'): string {
	return role === 'admin' ? '/admin' : '/app/today';
}

function isSafeReturnTo(value: string | null): string | null {
	if (!value) return null;
	// Only allow absolute same-origin paths, no protocol-relative or off-site.
	if (!value.startsWith('/')) return null;
	if (value.startsWith('//')) return null;
	if (value === '/login') return null;
	return value;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) {
		const returnTo = isSafeReturnTo(url.searchParams.get('returnTo'));
		throw redirect(303, returnTo ?? landingFor(locals.user.role));
	}
	return {};
};

export const actions: Actions = {
	default: async ({ cookies, request, url }) => {
		const form = await request.formData();
		const username = (form.get('username') ?? '').toString().trim();
		const password = (form.get('password') ?? '').toString();

		if (!username || !password) {
			return fail(400, { username, error: 'Enter a username and password.' });
		}

		const user = findUserByUsername(username);
		if (!user) {
			// Constant-ish delay path: still do a hash compare to avoid user enumeration by timing.
			await verifyPassword(
				'$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$' +
					'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
				password
			);
			return fail(401, { username, error: 'Username or password is incorrect.' });
		}

		const ok = await verifyPassword(user.password_hash, password);
		if (!ok) {
			return fail(401, { username, error: 'Username or password is incorrect.' });
		}

		recordLogin(user.id);
		const session = createSession(user.id, request.headers.get('user-agent'));
		cookies.set(SESSION_COOKIE_NAME, session.id, SESSION_COOKIE_OPTS);

		const returnTo = isSafeReturnTo(url.searchParams.get('returnTo'));
		throw redirect(303, returnTo ?? landingFor(user.role));
	}
};
