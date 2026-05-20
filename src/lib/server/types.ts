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
	is_self: 0 | 1;
	owner_user_id: number | null;
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
	vendor_id: number | null;
	shipper_id: number | null;
	tracking_status: string | null;
	tracking_status_at: string | null;
	tracking_estimated_delivery: string | null;
	tracking_provider_id: string | null;
	amazon_tracking_url: string | null;
	/** td-3e9ae2: FK to parent orders row when this gift was created from an
	 * Amazon import. Null for manually-entered gifts. */
	order_pk: number | null;
	/** td-3e9ae2: 0..N-1 position within a multi-item Amazon order. */
	line_item_index: number | null;
	/** td-d08902: FK to order_shipments row when this gift has shipped under
	 * a known shipment. Multi-shipment orders attach distinct gifts to
	 * distinct shipments. Null = not yet shipped or pre-migration legacy. */
	shipment_id: number | null;
	/** td-dc1846: when this gift was archived (set by archiveGift), so the
	 * admin browser can sort by archive time. Null when not archived; older
	 * archived rows backfilled with updated_at as best-effort. */
	archived_at: string | null;
	created_at: string;
	updated_at: string;
}

/** td-3e9ae2: one row per real-world Amazon order. Owns the order-level
 * tracking + lifecycle facts that used to be denormalized onto each gift.
 * Gifts FK back via `gifts.order_pk`.
 *
 * td-d08902: the tracking_* / shipped_at / delivered_at columns here are
 * a denormalized summary of the "primary/most recent" shipment for legacy
 * read compatibility. Authoritative per-shipment data now lives in
 * `order_shipments` (one row per real shipment). */
export interface Order {
	id: number;
	order_id: string;
	vendor_id: number | null;
	shipper_id: number | null;
	order_total_cents: number | null;
	tracking_number: string | null;
	carrier: string | null;
	tracking_provider_id: string | null;
	tracking_status: string | null;
	tracking_status_at: string | null;
	tracking_estimated_delivery: string | null;
	amazon_tracking_url: string | null;
	ordered_at: string | null;
	shipped_at: string | null;
	delivered_at: string | null;
	source_message_id: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

/** td-d08902: one row per real shipment. Multi-recipient Amazon orders
 * that ship in batches get one of these per box. Gifts attach via
 * `gifts.shipment_id` so per-recipient status reflects actual delivery. */
export interface OrderShipment {
	id: number;
	order_pk: number;
	tracking_number: string | null;
	carrier: string | null;
	tracking_provider_id: string | null;
	tracking_status: string | null;
	tracking_status_at: string | null;
	tracking_estimated_delivery: string | null;
	amazon_tracking_url: string | null;
	shipped_at: string | null;
	delivered_at: string | null;
	source_message_id: string | null;
	items_json: string | null;
	created_at: string;
	updated_at: string;
}

export interface ShipmentEvent {
	id: number;
	gift_id: number;
	event_at: string;
	status: string | null;
	message: string | null;
	location: string | null;
	raw_json: string | null;
	created_at: string;
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

export interface PersonAlias {
	id: number;
	person_id: number;
	alias_name: string;
	source: 'manual' | 'import_assigned';
	created_at: string;
}

export type ImportRunSource = 'amazon_email' | 'tracking_email';
export type ImportRunStatus = 'running' | 'ready_for_review' | 'committed' | 'error';

export interface ImportRun {
	id: number;
	source: ImportRunSource;
	actor_user_id: number;
	started_at: string;
	finished_at: string | null;
	status: ImportRunStatus;
	fetched_count: number;
	parsed_count: number;
	skipped_count: number;
	created_count: number;
	error_message: string | null;
}

export type EmailType =
	| 'order_placed'
	| 'shipped'
	| 'delivered'
	| 'marketing'
	| 'review_request'
	| 'unknown'
	| 'tracking_only'
	| 'order_confirmation';

// 'review' (td-3d1ee6): the importer detected an order# match but vendor/
// sender evidence disagreed. Routed here for manual resolution instead of
// silently fabricating a duplicate self-package. See migrations/019.
export type ImportRowDisposition = 'pending' | 'accepted' | 'skipped' | 'failed' | 'review';
export type MatchConfidence = 'exact' | 'alias' | 'fuzzy' | 'none';

export interface ImportRow {
	id: number;
	import_run_id: number;
	source_message_id: string;
	source_thread_id: string | null;
	subject: string | null;
	received_at: string | null;
	from_address: string | null;
	email_type: EmailType;
	parsed_title: string | null;
	parsed_order_id: string | null;
	parsed_price_cents: number | null;
	parsed_tracking_number: string | null;
	parsed_carrier: string | null;
	parsed_recipient_name: string | null;
	parsed_shipping_address: string | null;
	parsed_gift_message: string | null;
	parsed_sender_domain: string | null;
	parsed_amazon_tracking_url: string | null;
	/** td-3e9ae2: JSON array of per-line-item breakdowns
	 * `[{title, priceCents, quantity}, ...]`. Null on legacy single-item rows
	 * and on non-gift emails — caller falls back to parsed_title. */
	parsed_items_json: string | null;
	/** Wave 1 (migration 026): up to 4000 chars of the raw body text,
	 * captured only when the items[] extractor came up empty. Fed to the
	 * LLM matcher as fallback context. NULL when items[] is populated
	 * (which is the common case). */
	parsed_body_excerpt: string | null;
	match_person_id: number | null;
	match_confidence: MatchConfidence | null;
	match_candidates_json: string | null;
	/** Wave 1 (migration 023): persisted LLM matcher verdict — full
	 * `LlmMatchVerdict` JSON shape from src/lib/server/llm-matcher.ts. NULL
	 * until the matcher has run on this row; cleared when admin force-refreshes. */
	llm_verdict_json: string | null;
	disposition: ImportRowDisposition;
	gift_id: number | null;
	error_message: string | null;
	created_at: string;
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
