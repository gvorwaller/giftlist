import { afterEach, beforeEach, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, seedPerson, seedGift } from './test-harness';
import { getDb } from './db';
import { runMigrations, shipmentSchemaState } from './migrate';
beforeEach(setupTestDb);
afterEach(teardownTestDb);
it('recovers a pre-existing version 29 marker without shipment objects while preserving gifts', () => {
	const db = getDb();
	const person = seedPerson();
	const gift = seedGift({ person_id: person.id, title: 'Existing gift', status: 'ordered' });
	db.exec(
		'DROP TABLE import_item_gifts; DROP TABLE import_item_resolutions; ALTER TABLE import_rows DROP COLUMN parsed_order_ids_json;'
	);
	expect(shipmentSchemaState(db)).toBe('missing');
	expect(runMigrations(db)).toEqual({ applied: [29], currentVersion: 29 });
	expect(shipmentSchemaState(db)).toBe('complete');
	expect(db.prepare('SELECT * FROM gifts WHERE id=?').get(gift.id)).toEqual(gift);
	expect(runMigrations(db)).toEqual({ applied: [], currentVersion: 29 });
});
it('refuses partial shipment schemas instead of advertising successful migration', () => {
	const db = getDb();
	db.exec('DROP TABLE import_item_gifts;');
	expect(shipmentSchemaState(db)).toBe('partial');
	expect(() => runMigrations(db)).toThrow(/partially present/);
});
it('does not lower a newer marker when repairing the missing objects', () => {
	const db = getDb();
	db.exec(
		"DROP TABLE import_item_gifts; DROP TABLE import_item_resolutions; ALTER TABLE import_rows DROP COLUMN parsed_order_ids_json; UPDATE app_state SET value='30' WHERE key='schema_version';"
	);
	expect(runMigrations(db)).toEqual({ applied: [29], currentVersion: 30 });
	expect(db.prepare("SELECT value FROM app_state WHERE key='schema_version'").get()).toEqual({
		value: '30'
	});
});
