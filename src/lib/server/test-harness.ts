import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db';
import { runMigrations } from './migrate';
import type { Gift, ImportRow, Person } from './types';

/**
 * Vitest helper: tempfile-backed SQLite with all migrations applied,
 * factories for the entities Wave 1 commit + matcher paths exercise.
 *
 * Usage in a test file:
 *
 *   import { afterEach, beforeEach } from 'vitest';
 *   import { setupTestDb, teardownTestDb, seedUser, seedPerson, seedGift } from '...';
 *
 *   beforeEach(() => setupTestDb());
 *   afterEach(() => teardownTestDb());
 *
 * Each test gets a fresh DB. `closeDb()` flushes WAL between tests so
 * no state leaks. Tempfiles are cleaned up in teardown.
 */

let activeDir: string | null = null;

export function setupTestDb(): void {
	if (activeDir) teardownTestDb();
	activeDir = mkdtempSync(join(tmpdir(), 'giftlist-test-'));
	process.env.DATABASE_PATH = join(activeDir, 'test.db');
	closeDb();
	runMigrations(getDb());
}

export function teardownTestDb(): void {
	closeDb();
	if (activeDir) {
		rmSync(activeDir, { recursive: true, force: true });
		activeDir = null;
	}
}

// ---------------------------------------------------------------------
// Factories. Minimal-required-fields with sensible defaults; override
// any column by passing it in the input object.

let seq = 0;
function nextSeq(): number {
	return ++seq;
}

export function seedUser(opts: Partial<{ username: string; role: 'admin' | 'manager' }> = {}): {
	id: number;
} {
	const db = getDb();
	const username = opts.username ?? `admin-${nextSeq()}`;
	const role = opts.role ?? 'admin';
	const info = db
		.prepare(
			`INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)`
		)
		.run(username, 'x', role, username);
	return { id: Number(info.lastInsertRowid) };
}

export function seedPerson(opts: Partial<{ display_name: string; relationship: string }> = {}): Person {
	const db = getDb();
	const display_name = opts.display_name ?? `Person ${nextSeq()}`;
	const relationship = opts.relationship ?? null;
	const info = db
		.prepare(
			`INSERT INTO people (display_name, full_name, relationship)
			 VALUES (?, ?, ?)`
		)
		.run(display_name, display_name, relationship);
	return db
		.prepare<[number | bigint], Person>('SELECT * FROM people WHERE id = ?')
		.get(info.lastInsertRowid)!;
}

export interface SeedGiftInput {
	person_id: number;
	title?: string;
	status?: Gift['status'];
	is_idea?: 0 | 1;
	order_pk?: number | null;
	order_id?: string | null;
	line_item_index?: number | null;
	price_cents?: number | null;
	is_archived?: 0 | 1;
}

export function seedGift(opts: SeedGiftInput): Gift {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO gifts (person_id, title, status, is_idea, order_pk, order_id, line_item_index, price_cents, is_archived, occasion_year)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.person_id,
			opts.title ?? `Gift ${nextSeq()}`,
			opts.status ?? 'idea',
			opts.is_idea ?? 0,
			opts.order_pk ?? null,
			opts.order_id ?? null,
			opts.line_item_index ?? null,
			opts.price_cents ?? null,
			opts.is_archived ?? 0,
			2026
		);
	return db
		.prepare<[number | bigint], Gift>('SELECT * FROM gifts WHERE id = ?')
		.get(info.lastInsertRowid)!;
}

export interface SeedImportRunOptions {
	source?: 'amazon_email' | 'tracking_email';
	actor_user_id: number;
}

export function seedImportRun(opts: SeedImportRunOptions): number {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO import_runs (source, actor_user_id, status) VALUES (?, ?, 'ready_for_review')`
		)
		.run(opts.source ?? 'amazon_email', opts.actor_user_id);
	return Number(info.lastInsertRowid);
}

export interface SeedImportRowOptions {
	import_run_id: number;
	source_message_id?: string;
	subject?: string;
	email_type?: ImportRow['email_type'];
	parsed_title?: string | null;
	parsed_order_id?: string | null;
	parsed_tracking_number?: string | null;
	parsed_carrier?: string | null;
	parsed_items_json?: string | null;
	parsed_body_excerpt?: string | null;
	disposition?: ImportRow['disposition'];
	llm_verdict_json?: string | null;
}

export function seedImportRow(opts: SeedImportRowOptions): ImportRow {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO import_rows (
			   import_run_id, source_message_id, source_thread_id, subject, received_at,
			   from_address, email_type, parsed_title, parsed_order_id,
			   parsed_tracking_number, parsed_carrier,
			   parsed_items_json, parsed_body_excerpt, disposition, llm_verdict_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.import_run_id,
			opts.source_message_id ?? `msg-${nextSeq()}`,
			null,
			opts.subject ?? '(no subject)',
			'2026-05-19 12:00:00',
			'ship-confirm@amazon.com',
			opts.email_type ?? 'order_placed',
			opts.parsed_title ?? null,
			opts.parsed_order_id ?? null,
			opts.parsed_tracking_number ?? null,
			opts.parsed_carrier ?? null,
			opts.parsed_items_json ?? null,
			opts.parsed_body_excerpt ?? null,
			opts.disposition ?? 'pending',
			opts.llm_verdict_json ?? null
		);
	return db
		.prepare<[number | bigint], ImportRow>('SELECT * FROM import_rows WHERE id = ?')
		.get(info.lastInsertRowid)!;
}

/** Items helper — produce a parsed_items_json string for fixtures. */
export function itemsJson(
	items: Array<{ title: string; priceCents?: number | null; quantity?: number }>
): string {
	return JSON.stringify(
		items.map((it) => ({
			title: it.title,
			priceCents: it.priceCents ?? null,
			quantity: it.quantity ?? 1
		}))
	);
}
