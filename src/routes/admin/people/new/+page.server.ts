import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { createPerson } from '$server/people';

function str(fd: FormData, key: string): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

function nullable(fd: FormData, key: string): string | null {
	const v = str(fd, key);
	return v === '' ? null : v;
}

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const display_name = str(fd, 'display_name');
		if (!display_name) {
			return fail(400, {
				error: 'A display name is required.',
				values: {
					display_name,
					full_name: str(fd, 'full_name'),
					relationship: str(fd, 'relationship'),
					default_shipping_address: str(fd, 'default_shipping_address'),
					notes: str(fd, 'notes')
				}
			});
		}

		const person = createPerson(
			{
				display_name,
				full_name: nullable(fd, 'full_name'),
				relationship: nullable(fd, 'relationship'),
				default_shipping_address: nullable(fd, 'default_shipping_address'),
				notes: nullable(fd, 'notes')
			},
			locals.user.id
		);

		throw redirect(303, `/admin/people/${person.id}`);
	}
};
