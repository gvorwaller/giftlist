import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteDraft, upsertDraft } from '$server/drafts';
import type { DraftType } from '$server/types';

const ALLOWED_TYPES: ReadonlySet<DraftType> = new Set(['gift']);

function requireType(raw: unknown): DraftType {
	if (typeof raw !== 'string' || !ALLOWED_TYPES.has(raw as DraftType)) {
		throw error(400, 'Invalid draft_type');
	}
	return raw as DraftType;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	if (!body || typeof body !== 'object') throw error(400, 'Body must be an object');
	const obj = body as { draft_type?: unknown; payload?: unknown };
	const draftType = requireType(obj.draft_type);
	if (obj.payload == null || typeof obj.payload !== 'object') {
		throw error(400, 'payload must be an object');
	}
	const draft = upsertDraft(locals.user.id, draftType, obj.payload);
	return json({ id: draft.id, updated_at: draft.updated_at });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const url = new URL(request.url);
	const draftType = requireType(url.searchParams.get('draft_type'));
	deleteDraft(locals.user.id, draftType);
	return new Response(null, { status: 204 });
};
