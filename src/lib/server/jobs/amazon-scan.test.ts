import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb, seedUser } from '../test-harness';
import { getDb } from '../db';
import type { ImportRow } from '../types';
vi.mock('../gmail-reader', () => ({
	listLabelMessages: vi.fn(),
	getFullMessage: vi.fn(),
	batchMoveToLabel: vi.fn(),
	trashMessagesUnderLabel: vi.fn()
}));
vi.mock('../llm-matcher', async () => ({
	...(await vi.importActual('../llm-matcher')),
	llmMatchImportRow: vi.fn()
}));
import { listLabelMessages, getFullMessage } from '../gmail-reader';
import { llmMatchImportRow } from '../llm-matcher';
import { runAmazonScan } from './amazon-import';
beforeEach(() => {
	setupTestDb();
	vi.clearAllMocks();
});
afterEach(teardownTestDb);
it('scan persists both combined-shipment order references and never calls the purchase LLM', async () => {
	const user = seedUser();
	const summary = {
		id: 'combined',
		threadId: 'combined-thread',
		subject: 'Shipped: Birthday cards and gloves',
		from: 'ship-confirm@amazon.com',
		receivedAt: '2026-09-04T01:19:42Z',
		internalDate: '1788484782000',
		snippet: '',
		labelIds: []
	};
	vi.mocked(listLabelMessages).mockResolvedValue([summary]);
	vi.mocked(getFullMessage).mockResolvedValue({
		...summary,
		bodyText:
			'Order 113-1189617-2562657\nOrder 113-2783402-5371454\n* Birthday card for son in law\n  Quantity: 1',
		bodyHtml: ''
	});
	const result = await runAmazonScan(user.id);
	expect(result.error).toBeNull();
	expect(result.status).toBe('ok');
	expect(result.result?.newRows).toBe(1);
	const row = getDb().prepare<[], ImportRow>('SELECT * FROM import_rows').get()!;
	expect(JSON.parse(row.parsed_order_ids_json!)).toEqual([
		'113-1189617-2562657',
		'113-2783402-5371454'
	]);
	expect(JSON.parse(row.parsed_items_json!)).toEqual([
		{ title: 'Birthday card for son in law', quantity: 1, priceCents: null }
	]);
	expect(llmMatchImportRow).not.toHaveBeenCalled();
	const retry = await runAmazonScan(user.id);
	expect(retry.result?.existingRows).toBe(1);
	expect(getDb().prepare('SELECT COUNT(*) n FROM import_rows').get()).toEqual({ n: 1 });
});
