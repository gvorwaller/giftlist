<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import {
		canReturn,
		forwardActionLabel,
		managerLabel,
		nextForwardStatus
	} from '$lib/gift-status';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	const statusLabel = $derived(managerLabel(data.gift.status));
	const next = $derived(nextForwardStatus(data.gift.status));
	const nextLabel = $derived(forwardActionLabel(data.gift.status));
	const returnable = $derived(canReturn(data.gift.status));
	const isArchived = $derived(data.gift.is_archived === 1);

	let confirmingArchive = $state(false);

	function formAction(to: NonNullable<ReturnType<typeof nextForwardStatus>> | 'returned'): string {
		switch (to) {
			case 'planned':
				return '?/markPlanned';
			case 'ordered':
				return '?/markOrdered';
			case 'shipped':
				return '?/markShipped';
			case 'delivered':
				return '?/markDelivered';
			case 'wrapped':
				return '?/markWrapped';
			case 'given':
				return '?/markGiven';
			case 'returned':
				return '?/markReturned';
			default:
				return '';
		}
	}

	function priceDollars(cents: number | null): string {
		if (cents == null) return '';
		return `$${(cents / 100).toFixed(2)}`;
	}

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '';
		// SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC without zone.
		const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
		const d = new Date(normalized);
		if (isNaN(d.getTime())) return iso;
		return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
	}

	function badgeClass(s: typeof data.gift.status): string {
		switch (s) {
			case 'idea':
			case 'planned':
				return 'badge neutral';
			case 'ordered':
			case 'shipped':
			case 'delivered':
				return 'badge attention';
			case 'wrapped':
			case 'given':
				return 'badge good';
			case 'returned':
				return 'badge danger';
		}
	}
</script>

<svelte:head>
	<title>{data.gift.title} — Gift Tracker</title>
</svelte:head>

<main class="gift-detail">
	<header class="page-header">
		<p class="crumbs">
			<a href="/app/people/{data.gift.person.id}">{data.gift.person.display_name}</a> /
			<span>Gift</span>
		</p>
		<h1>{data.gift.title}</h1>
		<div class={badgeClass(data.gift.status)} aria-label="Status">
			<span aria-hidden="true" class="dot"></span>
			{statusLabel}
		</div>
	</header>

	<section class="card hero">
		<p class="eyebrow">For</p>
		<p class="hero-body">
			<a href="/app/people/{data.gift.person.id}">{data.gift.person.display_name}</a>
			{#if data.gift.occasion}
				· {data.gift.occasion.title}{#if data.gift.occasion_year} {data.gift.occasion_year}{/if}
			{/if}
		</p>
		{#if data.gift.source}
			<p class="sub">From {data.gift.source}{#if data.gift.price_cents} · {priceDollars(data.gift.price_cents)}{/if}</p>
		{:else if data.gift.price_cents}
			<p class="sub">{priceDollars(data.gift.price_cents)}</p>
		{/if}
	</section>

	{#if form?.error}
		<p class="error" role="alert">{form.error}</p>
	{/if}

	{#if isArchived}
		<section class="card archived-banner" role="status">
			<p class="eyebrow">Archived</p>
			<p class="body">This gift is archived and hidden from the main lists. Restore to bring it back.</p>
		</section>
	{:else}
		{#if next && nextLabel}
			<form method="POST" action={formAction(next)} class="primary-action">
				<button type="submit" class="primary-btn">{nextLabel}</button>
			</form>
		{:else}
			<p class="done">
				{#if data.gift.status === 'given'}
					All done — this one is given.
				{:else if data.gift.status === 'returned'}
					Returned.
				{/if}
			</p>
		{/if}

		{#if returnable}
			<form method="POST" action="?/markReturned" class="secondary-action">
				<button type="submit" class="ghost danger">Mark Returned</button>
			</form>
		{/if}

		<p class="edit-link">
			<a href="/app/gifts/{data.gift.id}/edit">Edit details</a>
		</p>
	{/if}

	{#if data.gift.tracking_number}
		<section class="card">
			<p class="eyebrow">Tracking</p>
			<p class="body">
				{data.gift.tracking_number}{#if data.gift.carrier} · {data.gift.carrier}{/if}
			</p>
		</section>
	{/if}

	{#if data.gift.notes}
		<section class="card">
			<p class="eyebrow">Notes</p>
			<p class="body">{data.gift.notes}</p>
		</section>
	{/if}

	<section class="card timeline">
		<p class="eyebrow">Timeline</p>
		<ul>
			<li>Added {formatTimestamp(data.gift.created_at)}</li>
			{#if data.gift.ordered_at}
				<li>Bought {formatTimestamp(data.gift.ordered_at)}</li>
			{/if}
			{#if data.gift.shipped_at}
				<li>Shipped {formatTimestamp(data.gift.shipped_at)}</li>
			{/if}
			{#if data.gift.delivered_at}
				<li>Arrived {formatTimestamp(data.gift.delivered_at)}</li>
			{/if}
		</ul>
	</section>

	<section class="card danger-zone">
		<h2>{isArchived ? 'Restore' : 'Archive'}</h2>
		{#if isArchived}
			<p>Bring this gift back into the main list.</p>
			<form method="POST" action="?/unarchive">
				<button type="submit" class="primary-btn">Restore this gift</button>
			</form>
		{:else if confirmingArchive}
			<p>Archive hides this gift from the main list. You can restore it later.</p>
			<form method="POST" action="?/archive" class="confirm-row">
				<button
					type="button"
					class="ghost"
					onclick={() => {
						confirmingArchive = false;
					}}
				>
					Cancel
				</button>
				<button type="submit" class="danger-btn">Yes, archive</button>
			</form>
		{:else}
			<p>Archive hides this gift from the main list. It can be restored later.</p>
			<button
				type="button"
				class="ghost danger"
				onclick={() => {
					confirmingArchive = true;
				}}
			>
				Archive this gift
			</button>
		{/if}
	</section>
</main>

<style>
	.gift-detail {
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
		line-height: 1.1;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.badge .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: currentColor;
	}

	.badge.neutral {
		background: var(--bg);
		color: var(--muted);
		border: 1px solid var(--line);
	}

	.badge.attention {
		background: var(--amber-soft);
		color: var(--amber);
		border: 1px solid var(--amber);
	}

	.badge.good {
		background: var(--green-soft);
		color: var(--green);
		border: 1px solid var(--green);
	}

	.badge.danger {
		background: #fde9e6;
		color: var(--rose);
		border: 1px solid var(--rose);
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 20px 22px;
		margin-bottom: 12px;
	}

	.hero {
		background: linear-gradient(135deg, #fdf7ea 0%, #fffdf8 60%);
		border-color: #e7d8bc;
	}

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
		margin-bottom: 8px;
	}

	.hero-body {
		font-family: var(--font-serif);
		font-size: 22px;
		color: var(--ink);
	}

	.hero-body a {
		color: var(--ink);
		text-decoration: none;
	}

	.sub {
		margin-top: 6px;
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--muted);
	}

	.body {
		font-size: 16px;
		color: var(--ink);
	}

	.primary-action {
		margin: 8px 0 10px;
	}

	.primary-btn {
		width: 100%;
		min-height: 56px;
		padding: 14px 20px;
		background: var(--green);
		color: var(--paper);
		border: none;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 18px;
		font-weight: 600;
		cursor: pointer;
		box-shadow: var(--shadow);
	}

	.secondary-action {
		margin-bottom: 14px;
	}

	.ghost {
		min-height: var(--tap-target);
		padding: 10px 18px;
		background: transparent;
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
		color: var(--muted);
	}

	.ghost.danger {
		color: var(--rose);
		border-color: var(--rose);
	}

	.done {
		font-family: var(--font-sans);
		font-size: 16px;
		color: var(--muted);
		padding: 14px 0;
		text-align: center;
	}

	.edit-link {
		text-align: center;
		margin: 6px 0 14px;
	}

	.edit-link a {
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		color: var(--green);
		text-decoration: underline;
		padding: 8px 12px;
		display: inline-block;
		min-height: var(--tap-target);
		line-height: 32px;
	}

	.error {
		color: var(--rose);
		font-size: 15px;
		margin-bottom: 10px;
	}

	.timeline ul {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.timeline li {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.archived-banner {
		background: var(--amber-soft);
		border-color: var(--amber);
	}

	.archived-banner .eyebrow {
		color: var(--amber);
	}

	.danger-zone {
		margin-top: 14px;
		border-color: #e7d8bc;
	}

	.danger-zone h2 {
		font-family: var(--font-serif);
		font-size: 20px;
		margin-bottom: 8px;
	}

	.danger-zone p {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
		margin-bottom: 12px;
	}

	.confirm-row {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
	}

	.danger-btn {
		min-height: var(--tap-target);
		padding: 10px 20px;
		background: var(--rose);
		color: var(--paper);
		border: 1px solid var(--rose);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
	}
</style>
