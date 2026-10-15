import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDraft, draftOwnerId, getFreshDraft, upsertDraft } from './drafts';
import { setupTestDb, seedUser, teardownTestDb } from './test-harness';
import type { User } from './types';

function locals(userId: number, role: 'admin' | 'manager', previewAsManager = false): App.Locals {
	return { user: { id: userId, role } as User, previewAsManager };
}

describe('draftOwnerId (preview-as-manager draft scoping)', () => {
	beforeEach(() => setupTestDb());
	afterEach(() => teardownTestDb());

	it('uses the signed-in user outside preview', () => {
		const admin = seedUser({ role: 'admin' });
		const manager = seedUser({ role: 'manager' });
		expect(draftOwnerId(locals(admin.id, 'admin'))).toBe(admin.id);
		expect(draftOwnerId(locals(manager.id, 'manager'))).toBe(manager.id);
	});

	it("uses the manager's drafts while an admin previews as manager", () => {
		const admin = seedUser({ role: 'admin' });
		const manager = seedUser({ role: 'manager' });
		expect(draftOwnerId(locals(admin.id, 'admin', true))).toBe(manager.id);
	});

	it('falls back to the admin when no manager exists', () => {
		const admin = seedUser({ role: 'admin' });
		expect(draftOwnerId(locals(admin.id, 'admin', true))).toBe(admin.id);
	});

	it("lets a previewing admin find and delete the manager's draft without touching their own", () => {
		const admin = seedUser({ role: 'admin' });
		const manager = seedUser({ role: 'manager' });
		upsertDraft(manager.id, 'gift', { title: 'Scarf' });
		upsertDraft(admin.id, 'gift', { title: 'Admin idea' });

		const previewing = locals(admin.id, 'admin', true);
		expect(getFreshDraft(draftOwnerId(previewing), 'gift')?.user_id).toBe(manager.id);

		deleteDraft(draftOwnerId(previewing), 'gift');
		expect(getFreshDraft(manager.id, 'gift')).toBeUndefined();
		expect(getFreshDraft(admin.id, 'gift')).toBeDefined();
	});
});
