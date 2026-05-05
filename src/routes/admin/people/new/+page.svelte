<script lang="ts">
	import { untrack } from 'svelte';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	interface Values {
		display_name?: string;
		full_name?: string;
		relationship?: string;
		default_shipping_address?: string;
		notes?: string;
		is_self?: boolean;
		owner_user_id?: string | number;
	}

	const values = $derived<Values>(form?.values ?? {});
	// Show the owner picker only when is_self is on (else it's meaningless).
	// Initial values come from the form-rejected payload if present, else
	// defaults. untrack so this runs once at mount, not on every prop tick.
	let isSelf = $state<boolean>(untrack(() => form?.values?.is_self ?? false));
	let ownerUserId = $state<string>(
		untrack(() => {
			const me = data.users.find((u) => u.isMe);
			return String(form?.values?.owner_user_id ?? me?.id ?? '');
		})
	);
</script>

<svelte:head>
	<title>Add Person — Admin — Gift Tracker</title>
</svelte:head>

<main class="new-person">
	<header class="page-header">
		<p class="crumbs"><a href="/admin/people">People</a> / Add</p>
		<h1>Add person</h1>
		<p class="subtitle">Manual entry. Contacts import is coming in Phase 2c.</p>
	</header>

	<form method="POST" class="card">
		<label>
			<span>Display name <em>required</em></span>
			<input
				name="display_name"
				type="text"
				required
				autocomplete="off"
				value={values.display_name ?? ''}
			/>
			<small>How you'll refer to them — "Mom", "Marcus", etc.</small>
		</label>

		<label>
			<span>Full name</span>
			<input name="full_name" type="text" autocomplete="off" value={values.full_name ?? ''} />
			<small>Optional. Used on shipping labels.</small>
		</label>

		<label>
			<span>Relationship</span>
			<input
				name="relationship"
				type="text"
				autocomplete="off"
				placeholder="Sister, coworker, etc."
				value={values.relationship ?? ''}
			/>
		</label>

		<label>
			<span>Default shipping address</span>
			<textarea name="default_shipping_address" rows="3">{values.default_shipping_address ?? ''}</textarea>
		</label>

		<label>
			<span>Notes</span>
			<textarea
				name="notes"
				rows="3"
				placeholder="Preferences, sizes, avoidances…">{values.notes ?? ''}</textarea>
		</label>

		<label class="checkbox">
			<input type="checkbox" name="is_self" bind:checked={isSelf} />
			<span class="checkbox-label">
				This is a personal-package tracker for a user
				<small>Self-people are hidden from /app/today, /app/people, and reminder digests. Their orders only appear on the owner's /app/packages.</small>
			</span>
		</label>

		{#if isSelf}
			<label>
				<span>Owner <em>required for self</em></span>
				<select name="owner_user_id" bind:value={ownerUserId} required>
					{#each data.users as u (u.id)}
						<option value={String(u.id)}>
							{u.display_name} ({u.role}){u.isMe ? ' — me' : ''}
						</option>
					{/each}
				</select>
				<small>Only this user will see these packages on their /app/packages.</small>
			</label>
		{/if}

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<div class="actions">
			<a href="/admin/people" class="ghost">Cancel</a>
			<button type="submit" class="primary">Create person</button>
		</div>
	</form>
</main>

<style>
	.new-person {
		max-width: 560px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 22px;
	}

	.crumbs {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.crumbs a {
		color: var(--muted);
	}

	h1 {
		margin-top: 6px;
		font-size: 31px;
	}

	.subtitle {
		margin-top: 8px;
		font-size: 16px;
		color: var(--muted);
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label span {
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	label em {
		font-style: normal;
		color: var(--muted);
		font-weight: 500;
		margin-left: 4px;
	}

	input,
	textarea {
		min-height: var(--tap-target);
		padding: 12px 14px;
		font-family: var(--font-sans);
		font-size: 17px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
		resize: vertical;
	}

	textarea {
		min-height: 96px;
	}

	input:focus,
	textarea:focus {
		background: var(--paper);
	}

	small {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.checkbox {
		flex-direction: row;
		align-items: flex-start;
		gap: 12px;
	}

	.checkbox input[type='checkbox'] {
		width: 22px;
		height: 22px;
		min-height: 22px;
		margin-top: 2px;
		accent-color: var(--green);
	}

	.checkbox-label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.checkbox-label small {
		font-weight: 400;
	}

	.error {
		color: var(--rose);
		font-size: 15px;
	}

	.actions {
		display: flex;
		gap: 12px;
		justify-content: flex-end;
	}

	.primary,
	.ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 10px 20px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
	}

	.primary {
		background: var(--green);
		color: var(--paper);
		border: 1px solid var(--green);
	}

	.ghost {
		background: transparent;
		color: var(--muted);
		border: 1px solid var(--line);
	}
</style>
