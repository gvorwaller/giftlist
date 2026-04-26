import { getDb } from '../db';
import { runJob, type JobResult } from './runner';
import { deliverNotification, type ChannelResult } from '../notify';
import { nextOccurrenceDate } from '../occasions';
import type { Gift, Occasion, Person, PersonOccasion } from '../types';

export const JOB_NAME = 'reminders.daily';

export interface UpcomingItem {
	personId: number;
	personDisplayName: string;
	occasionTitle: string;
	occasionKind: Occasion['kind'];
	occurrenceDate: Date;
	daysUntil: number;
	turnsAge: number | null;
	hasHandledGift: boolean;
}

export interface PackageItem {
	giftId: number;
	giftTitle: string;
	personDisplayName: string;
	carrier: string | null;
	trackingNumber: string | null;
	expectedEta: string | null;
}

export interface PendingImports {
	count: number;
	latestRunId: number | null;
	latestRunStartedAt: string | null;
	reviewUrl: string;
}

export interface ReminderSummary {
	leadDays: number;
	needsAttention: UpcomingItem[];
	comingUp: UpcomingItem[];
	packagesInTransit: PackageItem[];
	pendingImports: PendingImports | null;
	channelResults: ChannelResult[];
	notifiedSubject: string;
}

const HANDLED_STATUSES: ReadonlySet<string> = new Set([
	'planned',
	'ordered',
	'shipped',
	'delivered',
	'wrapped',
	'given'
]);

function getConfiguredLeadDays(): number {
	const fromEnv = Number(process.env.REMINDER_LEAD_DAYS);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
	return 21;
}

function getBaseUrl(): string {
	const raw = (process.env.BASE_URL ?? '').trim();
	if (!raw) return 'http://localhost:5175';
	return raw.replace(/\/+$/, '');
}

function collectPendingImports(): PendingImports | null {
	const db = getDb();
	const row = db
		.prepare<[], { cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM import_rows WHERE disposition = 'pending'`
		)
		.get();
	const count = row?.cnt ?? 0;
	if (count === 0) return null;

	const run = db
		.prepare<[], { id: number; started_at: string }>(
			`SELECT id, started_at FROM import_runs
			  WHERE source = 'amazon_email'
			  ORDER BY started_at DESC LIMIT 1`
		)
		.get();

	const reviewUrl = run
		? `${getBaseUrl()}/admin/imports/amazon/review?run=${run.id}`
		: `${getBaseUrl()}/admin/imports/amazon`;

	return {
		count,
		latestRunId: run?.id ?? null,
		latestRunStartedAt: run?.started_at ?? null,
		reviewUrl
	};
}

type Row = PersonOccasion &
	Occasion & {
		po_id: number;
		o_id: number;
		display_name: string;
		person_id: number;
	};

function collectUpcoming(leadDays: number): UpcomingItem[] {
	const db = getDb();
	const rows = db
		.prepare<[], Row>(
			`SELECT po.id AS po_id, po.person_id AS person_id,
			        p.display_name AS display_name,
			        o.id AS o_id, o.title, o.kind, o.recurrence,
			        o.month, o.day, o.date, o.reminder_days, o.year,
			        o.created_at, o.updated_at
			   FROM person_occasions po
			   JOIN people p ON p.id = po.person_id AND p.is_archived = 0
			   JOIN occasions o ON o.id = po.occasion_id
			  WHERE po.is_active = 1`
		)
		.all();

	const today = new Date();
	const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	const cutoff = todayStart.getTime() + leadDays * 86_400_000;

	const results: UpcomingItem[] = [];
	const handledCountStmt = db.prepare<
		[number, number, ...string[]],
		{ cnt: number }
	>(
		`SELECT COUNT(*) AS cnt FROM gifts
		  WHERE is_archived = 0
		    AND person_id = ?
		    AND occasion_id = ?
		    AND status IN (${Array.from(HANDLED_STATUSES).map(() => '?').join(',')})`
	);
	const handledStatuses = Array.from(HANDLED_STATUSES);

	for (const r of rows) {
		const occasion: Occasion = {
			id: r.o_id,
			title: r.title,
			kind: r.kind,
			recurrence: r.recurrence,
			month: r.month,
			day: r.day,
			date: r.date,
			reminder_days: r.reminder_days,
			year: r.year ?? null,
			created_at: r.created_at,
			updated_at: r.updated_at
		};
		const next = nextOccurrenceDate(occasion, todayStart);
		if (!next || next.getTime() > cutoff) continue;
		const daysUntil = Math.round((next.getTime() - todayStart.getTime()) / 86_400_000);
		const turnsAge =
			(occasion.kind === 'birthday' || occasion.kind === 'anniversary') && occasion.year != null
				? next.getFullYear() - occasion.year
				: null;
		const handled =
			(handledCountStmt.get(r.person_id, r.o_id, ...handledStatuses)?.cnt ?? 0) > 0;
		results.push({
			personId: r.person_id,
			personDisplayName: r.display_name,
			occasionTitle: r.title,
			occasionKind: r.kind,
			occurrenceDate: next,
			daysUntil,
			turnsAge,
			hasHandledGift: handled
		});
	}

	results.sort((a, b) => a.daysUntil - b.daysUntil);
	return results;
}

function collectPackages(): PackageItem[] {
	const db = getDb();
	const rows = db
		.prepare<[], Gift & { person_name: string }>(
			`SELECT g.*, p.display_name AS person_name
			   FROM gifts g
			   JOIN people p ON p.id = g.person_id
			  WHERE g.is_archived = 0
			    AND g.status IN ('ordered', 'shipped')
			  ORDER BY COALESCE(g.shipped_at, g.ordered_at, g.created_at) ASC`
		)
		.all();

	return rows.map((r) => ({
		giftId: r.id,
		giftTitle: r.title,
		personDisplayName: r.person_name,
		carrier: r.carrier,
		trackingNumber: r.tracking_number,
		expectedEta: null
	}));
}

function formatDaysUntil(days: number): string {
	if (days === 0) return 'today';
	if (days === 1) return 'tomorrow';
	return `in ${days} days`;
}

function formatUpcomingLine(item: UpcomingItem): string {
	const when = formatDaysUntil(item.daysUntil);
	const whoseWhat =
		item.occasionKind === 'birthday'
			? `${item.personDisplayName}'s birthday`
			: `${item.personDisplayName}'s ${item.occasionTitle}`;
	const age =
		item.occasionKind === 'birthday' && item.turnsAge !== null
			? ` (turns ${item.turnsAge})`
			: '';
	return `· ${whoseWhat} is ${when}${age}.`;
}

function composeDigest(input: {
	needsAttention: UpcomingItem[];
	comingUp: UpcomingItem[];
	packages: PackageItem[];
	pendingImports: PendingImports | null;
	leadDays: number;
}): { subject: string; text: string } {
	const { needsAttention, comingUp, packages, pendingImports, leadDays } = input;
	const parts: string[] = [];

	if (needsAttention.length > 0) {
		parts.push(
			`Needs attention:\n` +
				needsAttention
					.map(
						(i) =>
							`${formatUpcomingLine(i)} No gift is marked bought yet.`
					)
					.join('\n')
		);
	} else {
		parts.push(`Nothing urgent in the next ${leadDays} days.`);
	}

	if (comingUp.length > 0) {
		parts.push(`Coming up:\n` + comingUp.map(formatUpcomingLine).join('\n'));
	}

	if (packages.length > 0) {
		parts.push(
			`Packages on the way:\n` +
				packages
					.map(
						(p) =>
							`· ${p.giftTitle} for ${p.personDisplayName}${
								p.carrier || p.trackingNumber
									? ` (${[p.carrier, p.trackingNumber].filter(Boolean).join(' ')})`
									: ''
							}`
					)
					.join('\n')
		);
	}

	if (pendingImports && pendingImports.count > 0) {
		const noun = pendingImports.count === 1 ? 'email' : 'emails';
		parts.push(
			`Imports waiting for review:\n` +
				`· ${pendingImports.count} Amazon ${noun} staged from the latest scan.\n` +
				`  Review at ${pendingImports.reviewUrl}`
		);
	}

	const text = parts.join('\n\n');

	const subjectBits: string[] = [];
	if (needsAttention.length > 0) {
		subjectBits.push(
			`${needsAttention.length} occasion${needsAttention.length === 1 ? '' : 's'} need attention`
		);
	}
	if (pendingImports && pendingImports.count > 0) {
		subjectBits.push(
			`${pendingImports.count} import${pendingImports.count === 1 ? '' : 's'} to review`
		);
	}
	const subject =
		subjectBits.length > 0
			? `Gift tracker — ${subjectBits.join(' · ')}`
			: `Gift tracker — daily digest`;

	return { subject, text };
}

export async function runReminderJob(opts?: {
	deliver?: boolean;
}): Promise<JobResult<ReminderSummary>> {
	const deliver = opts?.deliver !== false; // default true

	return runJob<ReminderSummary>(
		JOB_NAME,
		async () => {
			const leadDays = getConfiguredLeadDays();
			const all = collectUpcoming(leadDays);
			const needsAttention = all.filter((i) => !i.hasHandledGift);
			const comingUp = all.filter((i) => i.hasHandledGift);
			const packages = collectPackages();
			const pendingImports = collectPendingImports();

			const { subject, text } = composeDigest({
				needsAttention,
				comingUp,
				packages,
				pendingImports,
				leadDays
			});

			let channelResults: ChannelResult[] = [];
			if (deliver) {
				channelResults = await deliverNotification({ subject, text });
			}

			return {
				leadDays,
				needsAttention,
				comingUp,
				packagesInTransit: packages,
				pendingImports,
				channelResults,
				notifiedSubject: subject
			};
		},
		{
			summarize: (r) =>
				`${r.needsAttention.length} need attention, ${r.comingUp.length} handled, ${r.packagesInTransit.length} packages, ${
					r.pendingImports?.count ?? 0
				} pending imports · delivered: ${
					r.channelResults
						.filter((c) => c.delivered)
						.map((c) => c.channel)
						.join(',') || 'none'
				}`
		}
	);
}

/** For Today-screen-style dry runs from admin UI (no delivery, no job_runs write). */
export function previewReminderDigest(): Omit<ReminderSummary, 'channelResults'> {
	const leadDays = getConfiguredLeadDays();
	const all = collectUpcoming(leadDays);
	const needsAttention = all.filter((i) => !i.hasHandledGift);
	const comingUp = all.filter((i) => i.hasHandledGift);
	const packages = collectPackages();
	const pendingImports = collectPendingImports();
	const { subject } = composeDigest({
		needsAttention,
		comingUp,
		packages,
		pendingImports,
		leadDays
	});
	return {
		leadDays,
		needsAttention,
		comingUp,
		packagesInTransit: packages,
		pendingImports,
		notifiedSubject: subject
	};
}
