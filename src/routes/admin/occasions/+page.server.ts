import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	countAssignmentsForOccasion,
	createOccasion,
	deleteOccasion,
	getOccasionById,
	listSharedOccasions,
	updateOccasion
} from '$server/occasions';
import { logAudit } from '$server/audit';
import type { OccasionKind, OccasionRecurrence } from '$server/types';

function str(fd: FormData, key: string): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

function intOrNull(fd: FormData, key: string): number | null {
	const v = str(fd, key);
	if (v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? Math.floor(n) : null;
}

function intOr(fd: FormData, key: string, fallback: number): number {
	const v = intOrNull(fd, key);
	return v ?? fallback;
}

const VALID_KINDS: ReadonlySet<OccasionKind> = new Set([
	'birthday',
	'holiday',
	'anniversary',
	'custom'
]);
const VALID_RECURRENCES: ReadonlySet<OccasionRecurrence> = new Set(['annual', 'one_time']);

function isValidKind(s: string): s is OccasionKind {
	return VALID_KINDS.has(s as OccasionKind);
}

function isValidRecurrence(s: string): s is OccasionRecurrence {
	return VALID_RECURRENCES.has(s as OccasionRecurrence);
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const occasions = listSharedOccasions();
	const assignmentCounts = Object.fromEntries(
		occasions.map((o) => [o.id, countAssignmentsForOccasion(o.id)])
	);
	return { occasions, assignmentCounts };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();

		const title = str(fd, 'title');
		const kindRaw = str(fd, 'kind');
		const recurrenceRaw = str(fd, 'recurrence');
		const month = intOrNull(fd, 'month');
		const day = intOrNull(fd, 'day');
		const date = str(fd, 'date');
		const reminder_days = intOr(fd, 'reminder_days', 21);

		if (!title) return fail(400, { scope: 'create', error: 'Title is required.' });
		if (!isValidKind(kindRaw))
			return fail(400, { scope: 'create', error: 'Invalid kind.' });
		if (!isValidRecurrence(recurrenceRaw))
			return fail(400, { scope: 'create', error: 'Invalid recurrence.' });

		// Annual needs month + day; one-time needs a full date.
		if (recurrenceRaw === 'annual') {
			if (!month || month < 1 || month > 12)
				return fail(400, { scope: 'create', error: 'Month must be 1–12 for annual occasions.' });
			if (!day || day < 1 || day > 31)
				return fail(400, { scope: 'create', error: 'Day must be 1–31 for annual occasions.' });
		} else if (recurrenceRaw === 'one_time') {
			if (!date) return fail(400, { scope: 'create', error: 'Date is required for one-time occasions.' });
		}

		const occasion = createOccasion({
			title,
			kind: kindRaw,
			recurrence: recurrenceRaw,
			month: recurrenceRaw === 'annual' ? month : null,
			day: recurrenceRaw === 'annual' ? day : null,
			date: recurrenceRaw === 'one_time' ? date : null,
			reminder_days
		});

		logAudit({
			actorUserId: locals.user.id,
			entityType: 'occasion',
			entityId: occasion.id,
			action: 'create',
			summary: `Created occasion "${occasion.title}" (${occasion.kind}, ${occasion.recurrence})`
		});

		return { scope: 'create', ok: true, occasionId: occasion.id };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id)) return fail(400, { scope: 'update', error: 'Invalid id.' });

		const before = getOccasionById(id);
		if (!before) return fail(404, { scope: 'update', error: 'Occasion not found.' });

		const title = str(fd, 'title') || before.title;
		const reminder_days = intOr(fd, 'reminder_days', before.reminder_days);
		const month = before.recurrence === 'annual' ? intOr(fd, 'month', before.month ?? 1) : null;
		const day = before.recurrence === 'annual' ? intOr(fd, 'day', before.day ?? 1) : null;
		const date = before.recurrence === 'one_time' ? str(fd, 'date') || before.date : null;

		const updated = updateOccasion(id, { title, reminder_days, month, day, date });

		logAudit({
			actorUserId: locals.user.id,
			entityType: 'occasion',
			entityId: id,
			action: 'update',
			summary: `Updated occasion "${updated.title}"`
		});

		return { scope: 'update', ok: true, occasionId: id };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const fd = await request.formData();
		const id = Number(fd.get('id'));
		if (!Number.isInteger(id)) return fail(400, { scope: 'delete', error: 'Invalid id.' });

		const before = getOccasionById(id);
		if (!before) return fail(404, { scope: 'delete', error: 'Occasion not found.' });

		// Block accidental deletion of seeded occasions while they're widely used.
		// We don't *forbid* it absolutely — admins can still bulk-unassign first.
		const inUse = countAssignmentsForOccasion(id);

		deleteOccasion(id);

		logAudit({
			actorUserId: locals.user.id,
			entityType: 'occasion',
			entityId: id,
			action: 'delete',
			summary: `Deleted occasion "${before.title}" (was assigned to ${inUse} ${inUse === 1 ? 'person' : 'people'})`
		});

		return { scope: 'delete', ok: true, deletedTitle: before.title };
	}
};
