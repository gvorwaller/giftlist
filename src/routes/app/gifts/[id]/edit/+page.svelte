<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	const initial: Record<string, string> = untrack(() => {
		if (form?.values) return form.values;
		return {
			person_id: String(data.gift.person_id),
			title: data.gift.title ?? '',
			source: data.gift.source ?? '',
			source_url: data.gift.source_url ?? '',
			occasion_id: String(data.gift.occasion_id ?? ''),
			occasion_year: String(data.gift.occasion_year ?? ''),
			order_id: data.gift.order_id ?? '',
			tracking_number: data.gift.tracking_number ?? '',
			carrier: data.gift.carrier ?? '',
			price: data.priceInitial,
			notes: data.gift.notes ?? ''
		};
	});

	const originalPersonId = untrack(() => String(data.gift.person_id));

	let personId = $state(initial.person_id);
	let title = $state(initial.title);
	let source = $state(initial.source);
	let sourceUrl = $state(initial.source_url);
	let occasionId = $state(initial.occasion_id);
	let occasionYear = $state(initial.occasion_year);
	let orderId = $state(initial.order_id);
	let tracking = $state(initial.tracking_number);
	let carrier = $state(initial.carrier);
	let price = $state(initial.price);
	let notes = $state(initial.notes);
	let submitting = $state(false);

	const personChanged = $derived(personId !== originalPersonId);

	// When user picks a different person, the loaded occasion options no
	// longer apply. Clear the selection and hide the dropdown until they
	// save and revisit (occasions are per-person via person_occasions).
	function handlePersonChange() {
		occasionId = '';
	}
</script>

<svelte:head>
	<title>Edit {data.gift.title} — Gift Tracker</title>
</svelte:head>

<main class="edit-gift">
	<header class="page-header">
		<p class="crumbs">
			<a href="/app/people/{data.gift.person.id}">{data.gift.person.display_name}</a> /
			<a href="/app/gifts/{data.gift.id}">{data.gift.title}</a> / Edit
		</p>
		<h1>Edit gift details</h1>
		<p class="subtitle">For {data.gift.person.display_name}.</p>
	</header>

	<form
		method="POST"
		action="?/save"
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
				{#each data.people as p (p.id)}
					<option value={String(p.id)}>{p.display_name}</option>
				{/each}
			</select>
		</label>

		{#if personChanged}
			<p class="reassign-note" role="status">
				Reassigning to a different person clears the occasion. Save, then reopen this gift to pick a new occasion.
			</p>
		{/if}

		<label class="big">
			<span>What is it?</span>
			<input
				name="title"
				type="text"
				required
				autocomplete="off"
				bind:value={title}
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
				placeholder="Amazon, Etsy, a local shop…"
			/>
		</label>

		<label>
			<span>Source URL</span>
			<input
				name="source_url"
				type="text"
				inputmode="url"
				autocomplete="off"
				bind:value={sourceUrl}
				placeholder="https://…"
			/>
		</label>

		{#if personChanged}
			<input type="hidden" name="occasion_id" value="" />
		{:else}
			<label>
				<span>Occasion</span>
				<select name="occasion_id" bind:value={occasionId}>
					<option value="">None</option>
					{#each data.personOccasions as o (o.personOccasionId)}
						<option value={String(o.id)}>{o.title}</option>
					{/each}
				</select>
			</label>
		{/if}

		<div class="row">
			<label>
				<span>Year</span>
				<input
					name="occasion_year"
					type="number"
					min="1900"
					max="2200"
					bind:value={occasionYear}
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
				/>
			</label>
		</div>

		<label>
			<span>Order #</span>
			<input name="order_id" type="text" bind:value={orderId} />
		</label>

		<div class="row">
			<label>
				<span>Tracking #</span>
				<input name="tracking_number" type="text" bind:value={tracking} />
			</label>
			<label>
				<span>Carrier</span>
				<input
					name="carrier"
					type="text"
					placeholder="USPS, UPS, FedEx…"
					bind:value={carrier}
				/>
			</label>
		</div>

		<label>
			<span>Notes</span>
			<textarea name="notes" rows="3" bind:value={notes}></textarea>
		</label>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<div class="actions">
			<a href="/app/gifts/{data.gift.id}" class="ghost">Cancel</a>
			<button type="submit" class="primary" disabled={submitting}>
				{submitting ? 'Saving…' : 'Save changes'}
			</button>
		</div>
	</form>
</main>

<style>
	.edit-gift {
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
		font-size: 28px;
	}

	.subtitle {
		margin-top: 6px;
		font-family: var(--font-sans);
		font-size: 14px;
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
		gap: 16px;
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

	label.big input {
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

	.error {
		color: var(--rose);
		font-size: 15px;
	}

	.reassign-note {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--amber);
		background: var(--amber-soft);
		border: 1px solid var(--amber);
		border-radius: var(--radius-control);
		padding: 10px 14px;
		margin-top: -8px;
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
