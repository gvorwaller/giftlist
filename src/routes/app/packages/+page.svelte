<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { managerLabel } from '$lib/gift-status';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	type PackageRow = (typeof data.onTheWay)[number];

	let totalCount = $derived(data.onTheWay.length + data.waitingToGive.length);

	function trackingLabel(g: PackageRow): string | null {
		if (!g.tracking_number && !g.carrier) return null;
		const bits: string[] = [];
		if (g.carrier) bits.push(g.carrier);
		if (g.tracking_number) bits.push(g.tracking_number);
		return bits.join(' · ');
	}

	function carrierStatus(g: PackageRow): string | null {
		if (!g.tracking_status) return null;
		return g.tracking_status;
	}
</script>

<svelte:head>
	<title>Packages — Gift Tracker</title>
</svelte:head>

<main class="packages">
	<header class="page-header">
		<p class="eyebrow">In flight</p>
		<h1>Packages on the way</h1>
		<p class="subtitle">
			Bought, not yet given. Tap a row for status, or the pencil to edit.
		</p>
		<div class="actions-row">
			<a href="/app/gifts/new" class="primary small">Add a package</a>
			{#if data.trackingProviderConfigured && data.onTheWay.length > 0}
				<form method="POST" action="?/refreshAll" class="refresh-row">
					<button type="submit" class="ghost small">Refresh all tracking</button>
				</form>
			{/if}
		</div>
		{#if form?.ok}
			<p class="refresh-result" role="status">
				Checked {form.checked}, updated {form.updated}{#if form.failed > 0}, {form.failed}
					failed{/if}.
			</p>
		{:else if form?.trackingError}
			<p class="refresh-err" role="alert">{form.trackingError}</p>
		{/if}
	</header>

	{#if totalCount === 0}
		<section class="card empty">
			<p>Nothing on its way right now.</p>
			<p class="empty-hint">
				Tap <strong>Add a package</strong> above to track a personal order or gift.
			</p>
		</section>
	{:else}
		{#if data.onTheWay.length > 0}
			<section class="section">
				<h2 class="section-heading">On the way</h2>
				<ul class="list">
					{#each data.onTheWay as g (g.id)}
						<li class="row-card">
							<a href="/app/gifts/{g.id}" class="row-main">
								<div class="row-text">
									<p class="title">{g.title}</p>
									<p class="meta">For {g.person_display_name}</p>
									{#if trackingLabel(g)}
										<p class="tracking">{trackingLabel(g)}</p>
									{/if}
									{#if carrierStatus(g)}
										<p class="carrier-status">Carrier: {carrierStatus(g)}</p>
									{/if}
								</div>
								<span class="pill attention">{managerLabel(g.status)}</span>
							</a>
							<a
								href="/app/gifts/{g.id}/edit"
								class="row-edit"
								aria-label="Edit {g.title}"
							>
								<svg
									width="20"
									height="20"
									viewBox="0 0 20 20"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
									aria-hidden="true"
								>
									<path
										d="M14 2.5l3.5 3.5-9.5 9.5H4.5v-3.5l9.5-9.5z"
										stroke-linejoin="round"
										stroke-linecap="round"
									/>
								</svg>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if data.waitingToGive.length > 0}
			<section class="section">
				<h2 class="section-heading">Waiting to wrap &amp; give</h2>
				<ul class="list">
					{#each data.waitingToGive as g (g.id)}
						<li class="row-card">
							<a href="/app/gifts/{g.id}" class="row-main">
								<div class="row-text">
									<p class="title">{g.title}</p>
									<p class="meta">For {g.person_display_name}</p>
									{#if trackingLabel(g)}
										<p class="tracking">{trackingLabel(g)}</p>
									{/if}
									{#if carrierStatus(g)}
										<p class="carrier-status">Carrier: {carrierStatus(g)}</p>
									{/if}
								</div>
								<span class="pill green">{managerLabel(g.status)}</span>
							</a>
							<a
								href="/app/gifts/{g.id}/edit"
								class="row-edit"
								aria-label="Edit {g.title}"
							>
								<svg
									width="20"
									height="20"
									viewBox="0 0 20 20"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
									aria-hidden="true"
								>
									<path
										d="M14 2.5l3.5 3.5-9.5 9.5H4.5v-3.5l9.5-9.5z"
										stroke-linejoin="round"
										stroke-linecap="round"
									/>
								</svg>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>

<style>
	.packages {
		max-width: 430px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 18px;
	}

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}

	h1 {
		margin-top: 6px;
		font-size: 28px;
		line-height: 1.1;
	}

	.subtitle {
		margin-top: 8px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 20px;
		margin-bottom: 12px;
	}

	.empty p {
		font-size: 17px;
		color: var(--muted);
		text-align: center;
		padding: 12px 0 4px;
	}

	.empty-hint {
		padding: 0 0 16px !important;
		font-size: 14px !important;
	}

	.section {
		margin-top: 18px;
	}

	.section:first-of-type {
		margin-top: 8px;
	}

	.section-heading {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
		margin-bottom: 10px;
	}

	.list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.row-card {
		display: flex;
		align-items: stretch;
		gap: 6px;
	}

	.row-main {
		flex: 1;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
		text-decoration: none;
		min-height: 56px;
		box-shadow: var(--shadow);
	}

	.row-main:hover {
		border-color: var(--green);
	}

	.row-text {
		min-width: 0;
		flex: 1;
	}

	.title {
		font-family: var(--font-serif);
		font-size: 19px;
	}

	.meta {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.tracking {
		margin-top: 4px;
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 12px;
		color: var(--muted);
	}

	.carrier-status {
		margin-top: 4px;
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 600;
		color: var(--green);
	}

	.actions-row {
		margin-top: 14px;
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}

	.refresh-row {
		display: contents;
	}

	.primary.small {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		padding: 6px 14px;
		font-size: 13px;
		background: var(--green);
		color: var(--paper);
		border: 1px solid var(--green);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
	}

	.ghost.small {
		min-height: 36px;
		padding: 6px 14px;
		font-size: 13px;
		background: transparent;
		color: var(--green);
		border: 1px solid var(--green);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-weight: 600;
		cursor: pointer;
	}

	.ghost.small:hover {
		background: var(--green-soft);
	}

	.refresh-result {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.refresh-err {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--rose);
	}

	.pill {
		padding: 4px 10px;
		border-radius: var(--radius-pill);
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.pill.attention {
		background: var(--amber-soft);
		color: var(--amber);
	}

	.pill.green {
		background: var(--green-soft);
		color: var(--green);
	}

	.row-edit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		flex-shrink: 0;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--muted);
		box-shadow: var(--shadow);
	}

	.row-edit:hover {
		color: var(--green);
		border-color: var(--green);
	}
</style>
