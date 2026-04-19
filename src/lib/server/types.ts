// Row types mirroring migrations/001-initial-schema.sql.
// SQLite returns booleans as 0/1 — we type these as 0 | 1 and convert at call sites.

export type Role = 'manager' | 'admin';

export interface User {
	id: number;
	username: string;
	password_hash: string;
	role: Role;
	display_name: string;
	last_login_at: string | null;
	last_seen_path: string | null;
	last_seen_at: string | null;
	created_at: string;
}

export interface Person {
	id: number;
	display_name: string;
	full_name: string | null;
	relationship: string | null;
	default_shipping_address: string | null;
	notes: string | null;
	is_archived: 0 | 1;
	google_resource_name: string | null;
	created_at: string;
	updated_at: string;
}

export type OccasionKind = 'birthday' | 'holiday' | 'anniversary' | 'custom';
export type OccasionRecurrence = 'annual' | 'one_time';

export interface Occasion {
	id: number;
	title: string;
	kind: OccasionKind;
	recurrence: OccasionRecurrence;
	month: number | null;
	day: number | null;
	date: string | null;
	reminder_days: number;
	year: number | null;
	created_at: string;
	updated_at: string;
}

export interface PersonOccasion {
	id: number;
	person_id: number;
	occasion_id: number;
	is_active: 0 | 1;
	notes: string | null;
}

export type GiftStatus =
	| 'idea'
	| 'planned'
	| 'ordered'
	| 'shipped'
	| 'delivered'
	| 'wrapped'
	| 'given'
	| 'returned';

export interface Gift {
	id: number;
	person_id: number;
	occasion_id: number | null;
	occasion_year: number | null;
	title: string;
	source: string | null;
	source_url: string | null;
	order_id: string | null;
	tracking_number: string | null;
	carrier: string | null;
	price_cents: number | null;
	status: GiftStatus;
	ordered_at: string | null;
	shipped_at: string | null;
	delivered_at: string | null;
	notes: string | null;
	is_idea: 0 | 1;
	is_archived: 0 | 1;
	created_at: string;
	updated_at: string;
}

export type DraftType = 'gift';

export interface Draft {
	id: number;
	user_id: number;
	draft_type: DraftType;
	payload_json: string;
	created_at: string;
	updated_at: string;
}

export type RecentlyViewedEntity = 'person' | 'gift';

export interface RecentlyViewed {
	id: number;
	user_id: number;
	entity_type: RecentlyViewedEntity;
	entity_id: number;
	label: string;
	viewed_at: string;
}

export interface AuditEntry {
	id: number;
	actor_user_id: number;
	entity_type: string;
	entity_id: number;
	action: string;
	summary: string;
	created_at: string;
}

export type JobStatus = 'running' | 'ok' | 'error';

export interface JobRun {
	id: number;
	job_name: string;
	started_at: string;
	finished_at: string | null;
	status: JobStatus;
	summary: string | null;
	error_message: string | null;
}

export interface AppStateRow {
	key: string;
	value: string;
	updated_at: string;
}

export type ExternalProvider = 'google';

export interface ExternalToken {
	id: number;
	user_id: number;
	provider: ExternalProvider;
	scope: string;
	access_token_encrypted: string | null;
	access_token_expires_at: string | null;
	refresh_token_encrypted: string | null;
	token_type: string | null;
	account_email: string | null;
	created_at: string;
	updated_at: string;
}
