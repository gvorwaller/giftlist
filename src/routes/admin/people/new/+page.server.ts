import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createPerson } from '$server/people';
import { listUsers } from '$server/auth';

function str(fd: FormData, key: string): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

function nullable(fd: FormData, key: string): string | null {
	const v = str(fd, key);
	return v === '' ? null : v;
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	return {
		users: listUsers().map((u) => ({
			id: u.id,
			username: u.username,
			role: u.role,
			display_name: u.display_name,
			isMe: u.id === locals.user!.id
		}))
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const display_name = str(fd, 'display_name');
		const is_self = fd.get('is_self') === 'on' || fd.get('is_self') === '1';
		// owner_user_id only meaningful when is_self is set. Falsy/absent → null
		// (createPerson defaults to actorUserId in that case).
		const ownerRaw = str(fd, 'owner_user_id');
		const owner_user_id = is_self && ownerRaw ? Number(ownerRaw) : null;
		if (is_self && ownerRaw && !Number.isInteger(owner_user_id)) {
			return fail(400, {
				error: 'Pick a valid owner for the self-person.',
				values: {
					display_name,
					full_name: str(fd, 'full_name'),
					relationship: str(fd, 'relationship'),
					default_shipping_address: str(fd, 'default_shipping_address'),
					notes: str(fd, 'notes'),
					is_self,
					owner_user_id: ownerRaw
				}
			});
		}
		if (!display_name) {
			return fail(400, {
				error: 'A display name is required.',
				values: {
					display_name,
					full_name: str(fd, 'full_name'),
					relationship: str(fd, 'relationship'),
					default_shipping_address: str(fd, 'default_shipping_address'),
					notes: str(fd, 'notes'),
					is_self,
					owner_user_id: ownerRaw
				}
			});
		}

		const person = createPerson(
			{
				display_name,
				full_name: nullable(fd, 'full_name'),
				relationship: nullable(fd, 'relationship'),
				default_shipping_address: nullable(fd, 'default_shipping_address'),
				notes: nullable(fd, 'notes'),
				is_self,
				owner_user_id
			},
			locals.user.id
		);

		throw redirect(303, `/admin/people/${person.id}`);
	}
};
