import { getDb } from '../db';
import { runJob, type JobResult } from './runner';
import { deliverNotification, type ChannelResult } from '../notify';

export const JOB_NAME = 'christmas.kickoff';

export interface ChristmasKickoffSummary {
	christmasOccasionId: number | null;
	assignedCount: number;
	unassignedActiveCount: number;
	channelResults: ChannelResult[];
	notifiedSubject: string;
}

interface ChristmasOccasion {
	id: number;
}

interface CountRow {
	cnt: number;
}

function getChristmasOccasionId(): number | null {
	const db = getDb();
	const row = db
		.prepare<[], ChristmasOccasion>(
			`SELECT id FROM occasions WHERE title = 'Christmas' AND kind = 'holiday' LIMIT 1`
		)
		.get();
	return row?.id ?? null;
}

function countAssignedToChristmas(occasionId: number): number {
	const db = getDb();
	const row = db
		.prepare<[number], CountRow>(
			`SELECT COUNT(*) AS cnt
			   FROM person_occasions po
			   JOIN people p ON p.id = po.person_id AND p.is_archived = 0
			  WHERE po.occasion_id = ? AND po.is_active = 1`
		)
		.get(occasionId);
	return row?.cnt ?? 0;
}

function countUnassignedActivePeople(occasionId: number): number {
	const db = getDb();
	const row = db
		.prepare<[number], CountRow>(
			`SELECT COUNT(*) AS cnt
			   FROM people p
			  WHERE p.is_archived = 0
			    AND NOT EXISTS (
			      SELECT 1 FROM person_occasions po
			       WHERE po.person_id = p.id
			         AND po.occasion_id = ?
			         AND po.is_active = 1
			    )`
		)
		.get(occasionId);
	return row?.cnt ?? 0;
}

function getBaseUrl(): string {
	const raw = (process.env.BASE_URL ?? '').trim();
	if (!raw) return 'http://localhost:5175';
	return raw.replace(/\/+$/, '');
}

function compose(input: {
	christmasOccasionId: number | null;
	assignedCount: number;
	unassignedActiveCount: number;
}): { subject: string; text: string } {
	const { christmasOccasionId, assignedCount, unassignedActiveCount } = input;
	const baseUrl = getBaseUrl();

	if (christmasOccasionId == null) {
		// Edge case: someone deleted the seeded Christmas occasion. The kickoff
		// still fires but tells the admin so it's not a silent failure.
		return {
			subject: 'Gift tracker — Christmas planning season',
			text: [
				`It's September 1st — Christmas planning season starts now.`,
				``,
				`Heads up: there's no "Christmas" holiday occasion in the database.`,
				`Add one at ${baseUrl}/admin/occasions and bulk-assign it to family.`
			].join('\n')
		};
	}

	const peopleNoun = (n: number) => (n === 1 ? 'person' : 'people');

	const lines: string[] = [
		`It's September 1st — Christmas planning season starts now.`,
		``,
		`${assignedCount} ${peopleNoun(assignedCount)} on the Christmas list.`
	];

	if (unassignedActiveCount > 0) {
		lines.push(
			`${unassignedActiveCount} active ${peopleNoun(unassignedActiveCount)} are NOT on the Christmas list yet.`,
			`Bulk-assign at ${baseUrl}/admin/people (Select multiple → Christmas → Assign).`
		);
	}

	lines.push(
		``,
		`Manager dashboard: ${baseUrl}/app/today`,
		`Add a gift: ${baseUrl}/app/gifts/new`
	);

	return {
		subject: `Gift tracker — Christmas planning season opens (${assignedCount} on the list)`,
		text: lines.join('\n')
	};
}

export async function runChristmasKickoffJob(opts?: {
	deliver?: boolean;
}): Promise<JobResult<ChristmasKickoffSummary>> {
	const deliver = opts?.deliver !== false;

	return runJob<ChristmasKickoffSummary>(
		JOB_NAME,
		async () => {
			const christmasOccasionId = getChristmasOccasionId();
			const assignedCount =
				christmasOccasionId != null ? countAssignedToChristmas(christmasOccasionId) : 0;
			const unassignedActiveCount =
				christmasOccasionId != null ? countUnassignedActivePeople(christmasOccasionId) : 0;

			const { subject, text } = compose({
				christmasOccasionId,
				assignedCount,
				unassignedActiveCount
			});

			let channelResults: ChannelResult[] = [];
			if (deliver) {
				channelResults = await deliverNotification({ subject, text });
			}

			return {
				christmasOccasionId,
				assignedCount,
				unassignedActiveCount,
				channelResults,
				notifiedSubject: subject
			};
		},
		{
			summarize: (r) =>
				`${r.assignedCount} on list, ${r.unassignedActiveCount} unassigned · delivered: ${
					r.channelResults
						.filter((c) => c.delivered)
						.map((c) => c.channel)
						.join(',') || 'none'
				}`
		}
	);
}
