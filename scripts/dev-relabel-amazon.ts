/**
 * Wave 1 dev helper: re-stage Amazon emails by moving them from the
 * Giftlist/Amazon/Processed label back to Giftlist/Amazon/Inbox in
 * Gmail. The next `npm run dev` + admin "Scan now" cycle will see them
 * as fresh.
 *
 * Use this between local test iterations so a fixed set of test emails
 * can be committed repeatedly without exhausting the actual inbox.
 *
 * Dev-only. Refuses to run unless NODE_ENV !== 'production' AND the
 * `GIFTLIST_DEV_RELABEL_OK=1` env override is set, so it can't be
 * triggered accidentally from a deploy script.
 *
 * Usage:
 *   GIFTLIST_DEV_RELABEL_OK=1 npm run dev:relabel-amazon
 *
 * Or directly:
 *   GIFTLIST_DEV_RELABEL_OK=1 npx tsx scripts/dev-relabel-amazon.ts <userId>
 */

import 'dotenv/config';
import { listLabelMessages, batchMoveToLabel } from '../src/lib/server/gmail-reader';
import { getDb } from '../src/lib/server/db';

const INBOX_LABEL = 'Giftlist/Amazon/Inbox';
const PROCESSED_LABEL = 'Giftlist/Amazon/Processed';

async function main() {
	if (process.env.NODE_ENV === 'production') {
		console.error('Refusing to run in NODE_ENV=production.');
		process.exit(1);
	}
	if (process.env.GIFTLIST_DEV_RELABEL_OK !== '1') {
		console.error(
			'Refusing to run without GIFTLIST_DEV_RELABEL_OK=1 in env. This script mutates Gmail label state.'
		);
		process.exit(1);
	}

	const userIdArg = process.argv[2];
	let userId: number;
	if (userIdArg) {
		userId = Number(userIdArg);
	} else {
		// Default: the admin row, since OAuth tokens are scoped to that
		// account in this single-admin app.
		const db = getDb();
		const row = db
			.prepare<[], { id: number }>(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)
			.get();
		if (!row) {
			console.error('No admin user found. Pass userId explicitly.');
			process.exit(1);
		}
		userId = row.id;
	}

	console.log(
		`[dev-relabel-amazon] Moving everything in ${PROCESSED_LABEL} → ${INBOX_LABEL} for user ${userId}…`
	);

	let totalMoved = 0;
	for (let page = 0; page < 20; page++) {
		const summaries = await listLabelMessages(userId, PROCESSED_LABEL, { maxResults: 50 });
		if (summaries.length === 0) break;
		await batchMoveToLabel(
			userId,
			summaries.map((s) => s.id),
			PROCESSED_LABEL,
			INBOX_LABEL
		);
		totalMoved += summaries.length;
		console.log(`  page ${page}: moved ${summaries.length} (total ${totalMoved})`);
		if (summaries.length < 50) break;
	}

	console.log(`[dev-relabel-amazon] done. ${totalMoved} message(s) restaged.`);
	console.log(
		'Next: bounce the dev DB (cp data/backup/gifttracker.db data/gifttracker.db), run the dev server, and Scan now.'
	);
}

main().catch((err) => {
	console.error('[dev-relabel-amazon] failed:', err);
	process.exit(1);
});
