import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	createVendor,
	getVendorById,
	listVendors,
	setVendorArchived,
	updateVendor,
	vendorUsageCount
} from '$server/vendors';

function str(fd: FormData, key: string): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const vendors = listVendors({ includeArchived: true });
	const usageCounts = Object.fromEntries(vendors.map((v) => [v.id, vendorUsageCount(v.id)]));
	return { vendors, usageCounts };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const name = str(fd, 'name');
		if (!name) return fail(400, { scope: 'create', error: 'Vendor name is required.' });
		try {
			createVendor(name, locals.user.id);
		} catch (err) {
			return fail(400, {
				scope: 'create',
				error: err instanceof Error ? err.message : 'Could not create vendor.'
			});
		}
		return { scope: 'create', ok: true };
	},

	rename: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		const name = str(fd, 'name');
		if (!Number.isInteger(id)) return fail(400, { scope: 'rename', error: 'Invalid vendor id.' });
		if (!name) return fail(400, { scope: 'rename', id, error: 'Vendor name is required.' });
		if (!getVendorById(id)) return fail(404, { scope: 'rename', id, error: 'Vendor not found.' });
		try {
			updateVendor(id, name, locals.user.id);
		} catch (err) {
			return fail(400, {
				scope: 'rename',
				id,
				error: err instanceof Error ? err.message : 'Could not rename vendor.'
			});
		}
		return { scope: 'rename', id, ok: true };
	},

	archive: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id)) return fail(400, { scope: 'archive', error: 'Invalid vendor id.' });
		if (!getVendorById(id)) return fail(404, { scope: 'archive', id, error: 'Vendor not found.' });
		setVendorArchived(id, true, locals.user.id);
		return { scope: 'archive', id, ok: true };
	},

	unarchive: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id)) return fail(400, { scope: 'unarchive', error: 'Invalid vendor id.' });
		if (!getVendorById(id)) return fail(404, { scope: 'unarchive', id, error: 'Vendor not found.' });
		setVendorArchived(id, false, locals.user.id);
		return { scope: 'unarchive', id, ok: true };
	}
};
