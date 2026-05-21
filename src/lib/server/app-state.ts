import { getDb } from './db';

/**
 * Tiny K/V accessor over the `app_state` table (mig 001). Used for runtime
 * config flags that aren't worth a dedicated column — e.g. the Phase B
 * auto-accept toggle. The migration runner manages its own `schema_version`
 * key directly; everything else goes through here.
 */

export function getAppState(key: string): string | null {
	const row = getDb()
		.prepare<[string], { value: string }>('SELECT value FROM app_state WHERE key = ?')
		.get(key);
	return row?.value ?? null;
}

export function setAppState(key: string, value: string): void {
	getDb()
		.prepare(
			`INSERT INTO app_state (key, value, updated_at)
			 VALUES (?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.run(key, value);
}

export function getBoolFlag(key: string, dflt = false): boolean {
	const v = getAppState(key);
	if (v == null) return dflt;
	return v === 'true' || v === '1';
}

export function setBoolFlag(key: string, on: boolean): void {
	setAppState(key, on ? 'true' : 'false');
}
