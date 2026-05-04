import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	createShipper,
	getShipperById,
	listShippers,
	setShipperArchived,
	shipperUsageCount,
	updateShipper
} from '$server/shippers';

function str(fd: FormData, key: string): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

function strOrNull(fd: FormData, key: string): string | null {
	const v = str(fd, key);
	return v === '' ? null : v;
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const shippers = listShippers({ includeArchived: true });
	const usageCounts = Object.fromEntries(shippers.map((s) => [s.id, shipperUsageCount(s.id)]));
	return { shippers, usageCounts };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const name = str(fd, 'name');
		const slug = strOrNull(fd, 'tracking_provider_slug');
		if (!name) return fail(400, { scope: 'create', error: 'Shipper name is required.' });
		try {
			createShipper({ name, tracking_provider_slug: slug }, locals.user.id);
		} catch (err) {
			return fail(400, {
				scope: 'create',
				error: err instanceof Error ? err.message : 'Could not create shipper.'
			});
		}
		return { scope: 'create', ok: true };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		const name = str(fd, 'name');
		const slug = strOrNull(fd, 'tracking_provider_slug');
		if (!Number.isInteger(id)) return fail(400, { scope: 'update', error: 'Invalid shipper id.' });
		if (!name) return fail(400, { scope: 'update', id, error: 'Shipper name is required.' });
		if (!getShipperById(id))
			return fail(404, { scope: 'update', id, error: 'Shipper not found.' });
		try {
			updateShipper(id, { name, tracking_provider_slug: slug }, locals.user.id);
		} catch (err) {
			return fail(400, {
				scope: 'update',
				id,
				error: err instanceof Error ? err.message : 'Could not update shipper.'
			});
		}
		return { scope: 'update', id, ok: true };
	},

	archive: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id)) return fail(400, { scope: 'archive', error: 'Invalid shipper id.' });
		if (!getShipperById(id))
			return fail(404, { scope: 'archive', id, error: 'Shipper not found.' });
		setShipperArchived(id, true, locals.user.id);
		return { scope: 'archive', id, ok: true };
	},

	unarchive: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id))
			return fail(400, { scope: 'unarchive', error: 'Invalid shipper id.' });
		if (!getShipperById(id))
			return fail(404, { scope: 'unarchive', id, error: 'Shipper not found.' });
		setShipperArchived(id, false, locals.user.id);
		return { scope: 'unarchive', id, ok: true };
	}
};
