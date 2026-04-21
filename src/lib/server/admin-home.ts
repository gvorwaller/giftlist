import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from './db';
import { countFailedRunsSince, getLastSuccess, getLastRun } from './jobs/runner';
import { JOB_NAME as REMINDER_JOB } from './jobs/reminders';
import { previewReminderDigest } from './jobs/reminders';
import { configuredChannels } from './notify';
import { DRAFT_STALE_DAYS } from './drafts';
import type { Draft, Person, User } from './types';

export type Health = 'healthy' | 'warning' | 'error' | 'unknown';

export interface PriorityAction {
	title: string;
	body: string;
	href: string;
}

export interface SystemSnapshot {
	upcomingNeedingGifts: number;
	incompletePeople: number;
	staleDrafts: number;
	failedJobs24h: number;
	lastBackupAt: string | null;
	lastReminderAt: string | null;
}

export interface NeedsReview {
	incompletePeople: Person[];
	staleDrafts: (Draft & { owner_username: string })[];
}

export interface ManagerContext {
	manager: User | null;
	anomalies: string[];
}

export interface Operations {
	backup: { health: Health; detail: string };
	reminder: { health: Health; detail: string; channelsConfigured: { email: boolean; telegram: boolean } };
}

export interface AdminHomeData {
	priorityAction: PriorityAction | null;
	snapshot: SystemSnapshot;
	needsReview: NeedsReview;
	managerContext: ManagerContext;
	operations: Operations;
}

const BACKUP_FILE = 'data/backup/gifttracker.db';
const BACKUP_STALE_HOURS = 36; // warning threshold beyond the expected 24h cycle

function statBackup(): { iso: string; ageHours: number } | null {
	try {
		const path = resolve(process.cwd(), BACKUP_FILE);
		const s = statSync(path);
		const age = (Date.now() - s.mtimeMs) / 3_600_000;
		return { iso: new Date(s.mtimeMs).toISOString(), ageHours: age };
	} catch {
		return null;
	}
}

function iso24hAgo(): string {
	return new Date(Date.now() - 24 * 3_600_000).toISOString();
}

function countUpcomingNeedingGifts(): number {
	// Reuse the reminder preview so the number matches what the digest would show.
	const digest = previewReminderDigest();
	return digest.needsAttention.length;
}

function countIncompletePeople(): number {
	const db = getDb();
	const row = db
		.prepare<[], { cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM people p
			  WHERE p.is_archived = 0
			    AND NOT EXISTS (
			      SELECT 1 FROM person_occasions po WHERE po.person_id = p.id AND po.is_active = 1
			    )`
		)
		.get();
	return row?.cnt ?? 0;
}

function listIncompletePeople(limit = 8): Person[] {
	const db = getDb();
	return db
		.prepare<[number], Person>(
			`SELECT p.* FROM people p
			  WHERE p.is_archived = 0
			    AND NOT EXISTS (
			      SELECT 1 FROM person_occasions po WHERE po.person_id = p.id AND po.is_active = 1
			    )
			  ORDER BY p.updated_at DESC
			  LIMIT ?`
		)
		.all(limit);
}

function listStaleDrafts(): (Draft & { owner_username: string })[] {
	const db = getDb();
	const threshold = new Date(Date.now() - DRAFT_STALE_DAYS * 24 * 3_600_000).toISOString();
	return db
		.prepare<[string], Draft & { owner_username: string }>(
			`SELECT d.*, u.username AS owner_username
			   FROM drafts d
			   JOIN users u ON u.id = d.user_id
			  WHERE d.created_at <= ?
			  ORDER BY d.created_at ASC`
		)
		.all(threshold);
}

function findManager(): User | null {
	const db = getDb();
	return (
		db
			.prepare<[], User>(
				`SELECT id, username, password_hash, role, display_name,
				        last_login_at, last_seen_path, last_seen_at, created_at
				   FROM users
				  WHERE role = 'manager'
				  ORDER BY id ASC
				  LIMIT 1`
			)
			.get() ?? null
	);
}

function detectManagerAnomalies(manager: User | null): string[] {
	if (!manager) return [];
	const anomalies: string[] = [];

	if (!manager.last_login_at) {
		anomalies.push('Manager has never signed in.');
	} else {
		const lastLogin = Date.parse(manager.last_login_at.replace(' ', 'T') + 'Z');
		const daysSince = (Date.now() - lastLogin) / 86_400_000;
		if (daysSince > 14) {
			anomalies.push(`Manager hasn't signed in for ${Math.round(daysSince)} days.`);
		}
	}

	// Detect rapid repeat edits: > 20 gift updates by manager in last hour.
	const db = getDb();
	const row = db
		.prepare<[number], { cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM audit_log
			  WHERE actor_user_id = ?
			    AND entity_type = 'gift'
			    AND action = 'update'
			    AND created_at >= datetime('now', '-1 hour')`
		)
		.get(manager.id);
	if (row && row.cnt > 20) {
		anomalies.push(`${row.cnt} gift edits in the last hour — unusual burst.`);
	}

	return anomalies;
}

function choosePriority(snapshot: SystemSnapshot, needs: NeedsReview): PriorityAction | null {
	// Order reflects urgency: data integrity > operational alerts > upcoming actions.
	if (needs.incompletePeople.length > 0) {
		const p = needs.incompletePeople[0];
		return {
			title: `${p.display_name} has no occasion assigned`,
			body: 'Manager won\'t see this person on Today until at least one occasion is set.',
			href: `/admin/people/${p.id}`
		};
	}
	if (snapshot.failedJobs24h > 0) {
		return {
			title: `${snapshot.failedJobs24h} background job${snapshot.failedJobs24h === 1 ? '' : 's'} failed in the last day`,
			body: 'Check the system page for details.',
			href: '/admin/system'
		};
	}
	if (snapshot.lastBackupAt == null) {
		return {
			title: 'No database backup on file yet',
			body: 'Run scripts/backup-sqlite.sh or wait for tonight\'s Carbon Copy Cloner pre-flight.',
			href: '/admin/system'
		};
	}
	if (snapshot.staleDrafts > 0) {
		return {
			title: `${snapshot.staleDrafts} stale draft${snapshot.staleDrafts === 1 ? '' : 's'} older than ${DRAFT_STALE_DAYS} days`,
			body: 'Stale drafts are hidden from the manager. Review or discard them.',
			href: '/admin/system'
		};
	}
	return null;
}

function backupHealth(): { health: Health; detail: string; iso: string | null } {
	const s = statBackup();
	if (!s) {
		return { health: 'unknown', detail: 'No snapshot at data/backup/gifttracker.db yet.', iso: null };
	}
	if (s.ageHours > BACKUP_STALE_HOURS) {
		return {
			health: 'warning',
			detail: `Last snapshot is ${Math.round(s.ageHours)} hours old.`,
			iso: s.iso
		};
	}
	return {
		health: 'healthy',
		detail: `Fresh — ${Math.round(s.ageHours)} hour${Math.round(s.ageHours) === 1 ? '' : 's'} old.`,
		iso: s.iso
	};
}

function reminderHealth(): { health: Health; detail: string; lastRunAt: string | null } {
	const lastSuccess = getLastSuccess(REMINDER_JOB);
	const lastRun = getLastRun(REMINDER_JOB);
	const channels = configuredChannels();

	if (!lastSuccess) {
		if (!channels.email && !channels.telegram) {
			return {
				health: 'unknown',
				detail: 'No notification channels configured yet. Set SMTP_* or TELEGRAM_* in .env.',
				lastRunAt: null
			};
		}
		return {
			health: 'warning',
			detail: 'Reminder job has never run successfully.',
			lastRunAt: lastRun?.started_at ?? null
		};
	}

	// Warn if the most recent attempt errored even if an older success exists.
	if (lastRun && lastRun.status === 'error') {
		return {
			health: 'error',
			detail: `Most recent run failed: ${lastRun.error_message ?? 'unknown error'}`,
			lastRunAt: lastRun.started_at
		};
	}

	return {
		health: 'healthy',
		detail: lastSuccess.summary ?? 'ran cleanly',
		lastRunAt: lastSuccess.started_at
	};
}

export function loadAdminHomeData(): AdminHomeData {
	const failedJobs24h = countFailedRunsSince(iso24hAgo());
	const backup = backupHealth();
	const reminder = reminderHealth();

	const incompletePeopleList = listIncompletePeople();
	const staleDraftsList = listStaleDrafts();

	const snapshot: SystemSnapshot = {
		upcomingNeedingGifts: countUpcomingNeedingGifts(),
		incompletePeople: countIncompletePeople(),
		staleDrafts: staleDraftsList.length,
		failedJobs24h,
		lastBackupAt: backup.iso,
		lastReminderAt: reminder.lastRunAt
	};

	const needsReview: NeedsReview = {
		incompletePeople: incompletePeopleList,
		staleDrafts: staleDraftsList
	};

	const manager = findManager();
	const managerContext: ManagerContext = {
		manager,
		anomalies: detectManagerAnomalies(manager)
	};

	const operations: Operations = {
		backup: { health: backup.health, detail: backup.detail },
		reminder: {
			health: reminder.health,
			detail: reminder.detail,
			channelsConfigured: configuredChannels()
		}
	};

	const priorityAction = choosePriority(snapshot, needsReview);

	return {
		priorityAction,
		snapshot,
		needsReview,
		managerContext,
		operations
	};
}

export function lastBackupIso(): string | null {
	return statBackup()?.iso ?? null;
}
