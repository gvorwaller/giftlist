import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getPersonById, setArchived, updatePerson } from '$server/people';
import {
	assignOccasionToPerson,
	createOccasion,
	createPersonBirthday,
	listPersonOccasions,
	listSharedOccasions,
	removePersonOccasion
} from '$server/occasions';
import { logAudit } from '$server/audit';

function str(fd: FormData, key: string): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

function nullable(fd: FormData, key: string): string | null {
	const v = str(fd, key);
	return v === '' ? null : v;
}

function requirePerson(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(400, 'Invalid id');
	const person = getPersonById(id);
	if (!person) throw error(404, 'Person not found');
	return { id, person };
}

export const load: PageServerLoad = ({ params }) => {
	const { person } = requirePerson(params);
	return {
		person,
		personOccasions: listPersonOccasions(person.id),
		sharedOccasions: listSharedOccasions()
	};
};

export const actions: Actions = {
	update: async ({ params, request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const { id } = requirePerson(params);
		const fd = await request.formData();
		const display_name = str(fd, 'display_name');
		if (!display_name) {
			return fail(400, { scope: 'update', error: 'Display name is required.' });
		}
		updatePerson(
			id,
			{
				display_name,
				full_name: nullable(fd, 'full_name'),
				relationship: nullable(fd, 'relationship'),
				default_shipping_address: nullable(fd, 'default_shipping_address'),
				notes: nullable(fd, 'notes')
			},
			locals.user.id
		);
		return { scope: 'update', ok: true };
	},

	archive: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const { id } = requirePerson(params);
		setArchived(id, true, locals.user.id);
		return { scope: 'archive', ok: true };
	},

	unarchive: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const { id } = requirePerson(params);
		setArchived(id, false, locals.user.id);
		return { scope: 'unarchive', ok: true };
	},

	assignShared: async ({ params, request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const { id } = requirePerson(params);
		const fd = await request.formData();
		const occasionId = Number(fd.get('occasion_id'));
		if (!Number.isInteger(occasionId) || occasionId <= 0) {
			return fail(400, { scope: 'occasion', error: 'Choose an occasion.' });
		}
		assignOccasionToPerson(id, occasionId, locals.user.id, {
			notes: nullable(fd, 'notes')
		});
		return { scope: 'occasion', ok: true };
	},

	addBirthday: async ({ params, request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const { id } = requirePerson(params);
		const fd = await request.formData();
		const month = Number(fd.get('month'));
		const day = Number(fd.get('day'));
		if (!Number.isInteger(month) || month < 1 || month > 12) {
			return fail(400, { scope: 'birthday', error: 'Month must be 1-12.' });
		}
		if (!Number.isInteger(day) || day < 1 || day > 31) {
			return fail(400, { scope: 'birthday', error: 'Day must be 1-31.' });
		}
		createPersonBirthday(id, month, day, locals.user.id, {
			title: 'Birthday',
			notes: nullable(fd, 'notes')
		});
		return { scope: 'birthday', ok: true };
	},

	removeOccasion: async ({ params, request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		requirePerson(params);
		const fd = await request.formData();
		const poId = Number(fd.get('person_occasion_id'));
		if (!Number.isInteger(poId)) return fail(400, { scope: 'occasion', error: 'Invalid id' });
		removePersonOccasion(poId, locals.user.id);
		return { scope: 'occasion', ok: true };
	},

	addCustom: async ({ params, request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const { id, person } = requirePerson(params);
		const fd = await request.formData();

		const title = str(fd, 'title');
		const recurrenceRaw = str(fd, 'recurrence');
		const recurrence = recurrenceRaw === 'one_time' ? 'one_time' : 'annual';
		const monthRaw = fd.get('month');
		const dayRaw = fd.get('day');
		const dateRaw = nullable(fd, 'date');
		const reminderRaw = fd.get('reminder_days');
		const reminder_days = (() => {
			const n = Number(reminderRaw);
			return Number.isFinite(n) && n > 0 ? Math.floor(n) : 21;
		})();

		if (!title) return fail(400, { scope: 'custom', error: 'Title is required.' });

		let month: number | null = null;
		let day: number | null = null;
		let date: string | null = null;

		if (recurrence === 'annual') {
			const m = Number(monthRaw);
			const d = Number(dayRaw);
			if (!Number.isInteger(m) || m < 1 || m > 12)
				return fail(400, { scope: 'custom', error: 'Month must be 1–12 for annual.' });
			if (!Number.isInteger(d) || d < 1 || d > 31)
				return fail(400, { scope: 'custom', error: 'Day must be 1–31 for annual.' });
			month = m;
			day = d;
		} else {
			if (!dateRaw) return fail(400, { scope: 'custom', error: 'Date is required for one-time.' });
			date = dateRaw;
		}

		const occasion = createOccasion({
			title,
			kind: 'custom',
			recurrence,
			month,
			day,
			date,
			reminder_days
		});

		assignOccasionToPerson(id, occasion.id, locals.user.id, {
			notes: nullable(fd, 'notes')
		});

		logAudit({
			actorUserId: locals.user.id,
			entityType: 'occasion',
			entityId: occasion.id,
			action: 'create',
			summary: `Created custom occasion "${title}" for ${person.display_name}`
		});

		return { scope: 'custom', ok: true };
	}
};
