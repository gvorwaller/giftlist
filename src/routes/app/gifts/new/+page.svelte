<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import type { ActionData, PageData } from './$types';
	import type { GiftDraftPayload } from './+page.server';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	// Seed form state once from server-provided prefill (draft payload +
	// ?person= query). untrack prevents Svelte 5 from treating the initial
	// read as a reactive dep, so subsequent SSR re-renders (e.g. after a
	// failed form action) don't reset user-typed values.
	const initial: Record<string, string> = untrack(() => {
		if (form?.values) return form.values;
		return {
			person_id: String(data.prefill.person_id ?? ''),
			title: data.prefill.title ?? '',
			source: data.prefill.source ?? '',
			source_url: data.prefill.source_url ?? '',
			occasion_id: String(data.prefill.occasion_id ?? ''),
			occasion_year: String(data.prefill.occasion_year ?? data.currentYear),
			order_id: data.prefill.order_id ?? '',
			tracking_number: data.prefill.tracking_number ?? '',
			carrier: data.prefill.carrier ?? '',
			price: data.prefill.price ?? '',
			notes: data.prefill.notes ?? '',
			status: data.prefill.status ?? 'planned'
		};
	});

	const initialPrefillPersonId = untrack(() => String(data.prefill.person_id ?? ''));

	let personId = $state(initial.person_id);
	let title = $state(initial.title);
	let source = $state(initial.source);
	let occasionId = $state(initial.occasion_id);
	let occasionYear = $state(initial.occasion_year);
	let orderId = $state(initial.order_id);
	let tracking = $state(initial.tracking_number);
	let carrier = $state(initial.carrier);
	let price = $state(initial.price);
	let notes = $state(initial.notes);
	let isIdea = $state(initial.status === 'idea');
	let moreDetailsOpen = $state(
		Boolean(
			initial.occasion_id ||
				initial.order_id ||
				initial.tracking_number ||
				initial.price ||
				initial.notes
		)
	);

	// If the user switches person mid-form, the server-supplied occasion list
	// for the initial person no longer applies. Clear until next page load.
	const personOccasions = $derived.by(() => {
		if (!personId || personId !== initialPrefillPersonId) return [];
		return data.personOccasions;
	});

	let savingState: 'idle' | 'saving' | 'saved' | 'error' = $state('idle');
	let lastSavedAt: Date | null = $state(
		untrack(() => (data.draftUpdatedAt ? new Date(data.draftUpdatedAt + 'Z') : null))
	);
	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
	let submitting = $state(false);

	function snapshot(): GiftDraftPayload {
		return {
			person_id: personId ? Number(personId) : null,
			title,
			source,
			occasion_id: occasionId ? Number(occasionId) : null,
			occasion_year: occasionYear ? Number(occasionYear) : null,
			order_id: orderId,
			tracking_number: tracking,
			carrier,
			price,
			notes,
			status: isIdea ? 'idea' : 'planned'
		};
	}

	function hasAnyField(s: GiftDraftPayload): boolean {
		return Boolean(
			(s.person_id && s.person_id > 0) ||
				s.title?.trim() ||
				s.source?.trim() ||
				s.occasion_id ||
				s.order_id?.trim() ||
				s.tracking_number?.trim() ||
				s.price?.trim() ||
				s.notes?.trim()
		);
	}

	async function saveDraft() {
		const payload = snapshot();
		if (!hasAnyField(payload)) return;
		savingState = 'saving';
		try {
			const res = await fetch('/api/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ draft_type: 'gift', payload })
			});
			if (!res.ok) throw new Error(`${res.status}`);
			const body = await res.json();
			lastSavedAt = new Date(body.updated_at + 'Z');
			savingState = 'saved';
		} catch {
			savingState = 'error';
		}
	}

	function scheduleSave() {
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => {
			void saveDraft();
		}, 2000);
	}

	function onInput() {
		if (submitting) return;
		savingState = 'idle';
		scheduleSave();
	}

	function humanSaved(d: Date | null): string {
		if (!d) return '';
		const secs = Math.round((Date.now() - d.getTime()) / 1000);
		if (secs < 60) return 'just now';
		const mins = Math.round(secs / 60);
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return d.toLocaleDateString();
	}

	let tickInterval: ReturnType<typeof setInterval> | null = null;
	let nowTick = $state(Date.now());

	onMount(() => {
		tickInterval = setInterval(() => (nowTick = Date.now()), 15_000);
	});

	onDestroy(() => {
		if (autosaveTimer) clearTimeout(autosaveTimer);
		if (tickInterval) clearInterval(tickInterval);
	});

	$effect(() => {
		// Consume nowTick so the "saved 3m ago" label refreshes.
		void nowTick;
	});

	async function handlePersonChange() {
		await tick();
		occasionId = '';
		onInput();
	}
</script>

<svelte:head>
	<title>Add gift — Gift Tracker</title>
</svelte:head>

<main class="new-gift">
	<header class="page-header">
		<p class="crumbs"><a href="/app/today">Today</a> / Add gift</p>
		<h1>Add a gift</h1>
		<p class="subtitle" aria-live="polite">
			{#if savingState === 'saving'}
				Saving draft…
			{:else if savingState === 'saved' && lastSavedAt}
				Draft saved {humanSaved(lastSavedAt)}
			{:else if savingState === 'error'}
				Couldn't save draft — we'll try again on your next change.
			{:else if lastSavedAt}
				Draft from {humanSaved(lastSavedAt)}
			{:else}
				Auto-saves while you type.
			{/if}
		</p>
	</header>

	{#if data.draftUpdatedAt}
		<div class="draft-banner" role="status">
			<div>
				<p class="banner-title">Picking up where you left off.</p>
				<p class="banner-body">We restored the gift you started earlier.</p>
			</div>
			<form method="POST" action="?/discardDraft">
				<button type="submit" class="link-btn">Start fresh</button>
			</form>
		</div>
	{/if}

	<form
		method="POST"
		action="?/create"
		class="card"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
	>
		<label class="big">
			<span>Who is it for?</span>
			<select name="person_id" bind:value={personId} required oninput={handlePersonChange}>
				<option value="">Pick a person…</option>
				{#each data.people as p (p.id)}
					<option value={String(p.id)}>{p.display_name}</option>
				{/each}
			</select>
		</label>

		<label class="big">
			<span>What is it?</span>
			<input
				name="title"
				type="text"
				required
				autocomplete="off"
				bind:value={title}
				oninput={onInput}
				placeholder="AirPods Max, wool socks…"
			/>
		</label>

		<label class="big">
			<span>Where from?</span>
			<input
				name="source"
				type="text"
				autocomplete="off"
				bind:value={source}
				oninput={onInput}
				placeholder="Amazon, Etsy, a local shop…"
			/>
		</label>

		<label class="checkbox">
			<input
				type="checkbox"
				bind:checked={isIdea}
				oninput={onInput}
				name="__is_idea_ui_only"
			/>
			<span>Just an idea for now</span>
			<input type="hidden" name="status" value={isIdea ? 'idea' : 'planned'} />
		</label>

		<details bind:open={moreDetailsOpen} class="more">
			<summary>More details</summary>

			<label>
				<span>Occasion</span>
				<select name="occasion_id" bind:value={occasionId} oninput={onInput}>
					<option value="">None</option>
					{#each personOccasions as o (o.personOccasionId)}
						<option value={String(o.id)}>{o.title}</option>
					{/each}
				</select>
			</label>

			<div class="row">
				<label>
					<span>Year</span>
					<input
						name="occasion_year"
						type="number"
						min="1900"
						max="2200"
						bind:value={occasionYear}
						oninput={onInput}
					/>
				</label>
				<label>
					<span>Price</span>
					<input
						name="price"
						type="text"
						inputmode="decimal"
						placeholder="24.99"
						bind:value={price}
						oninput={onInput}
					/>
				</label>
			</div>

			<label>
				<span>Order #</span>
				<input name="order_id" type="text" bind:value={orderId} oninput={onInput} />
			</label>

			<div class="row">
				<label>
					<span>Tracking #</span>
					<input name="tracking_number" type="text" bind:value={tracking} oninput={onInput} />
				</label>
				<label>
					<span>Carrier</span>
					<input
						name="carrier"
						type="text"
						placeholder="USPS, UPS…"
						bind:value={carrier}
						oninput={onInput}
					/>
				</label>
			</div>

			<label>
				<span>Notes</span>
				<textarea name="notes" rows="3" bind:value={notes} oninput={onInput}></textarea>
			</label>

			<!-- Keep fields that might be hidden when collapsed submitting with the form by mirroring them here -->
			<input type="hidden" name="source_url" value="" />
		</details>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<div class="actions">
			<a href="/app/today" class="ghost">Cancel</a>
			<button type="submit" class="primary" disabled={submitting}>
				{submitting ? 'Saving…' : 'Save gift'}
			</button>
		</div>
	</form>
</main>

<style>
	.new-gift {
		max-width: 480px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 18px;
	}

	.crumbs {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.crumbs a {
		color: var(--muted);
	}

	h1 {
		margin-top: 6px;
		font-size: 30px;
	}

	.subtitle {
		margin-top: 6px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
		min-height: 20px;
	}

	.draft-banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 14px;
		background: var(--amber-soft);
		border: 1px solid var(--amber);
		border-radius: var(--radius-control);
		padding: 14px 16px;
		margin-bottom: 14px;
	}

	.banner-title {
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		color: var(--amber);
	}

	.banner-body {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.link-btn {
		background: transparent;
		border: none;
		padding: 4px 8px;
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		color: var(--amber);
		text-decoration: underline;
		cursor: pointer;
		min-height: 32px;
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 18px;
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

	label.big span {
		font-size: 15px;
	}

	input[type='text'],
	input[type='number'],
	textarea,
	select {
		min-height: var(--tap-target);
		padding: 12px 14px;
		font-family: var(--font-sans);
		font-size: 17px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	label.big input,
	label.big select {
		font-size: 19px;
		padding: 14px 16px;
	}

	textarea {
		min-height: 84px;
		resize: vertical;
	}

	.row {
		display: flex;
		gap: 12px;
	}

	.row label {
		flex: 1;
	}

	.checkbox {
		flex-direction: row;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
	}

	.checkbox input {
		width: 22px;
		height: 22px;
		accent-color: var(--green);
	}

	.more {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: 8px 16px;
	}

	.more[open] {
		padding: 8px 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.more summary {
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		color: var(--green);
		padding: 12px 0;
		cursor: pointer;
	}

	.error {
		color: var(--rose);
		font-size: 15px;
	}

	.actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
		margin-top: 4px;
	}

	.primary,
	.ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 12px 22px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
		border: 1px solid transparent;
	}

	.primary {
		background: var(--green);
		color: var(--paper);
		border-color: var(--green);
	}

	.primary:disabled {
		opacity: 0.65;
		cursor: default;
	}

	.ghost {
		background: transparent;
		color: var(--muted);
		border-color: var(--line);
	}
</style>
