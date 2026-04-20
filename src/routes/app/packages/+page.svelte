<script lang="ts">
	import type { PageData } from './$types';
	import { managerLabel } from '$lib/gift-status';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function trackingLabel(g: (typeof data.onTheWay)[number]): string | null {
		if (!g.tracking_number && !g.carrier) return null;
		const bits: string[] = [];
		if (g.carrier) bits.push(g.carrier);
		if (g.tracking_number) bits.push(g.tracking_number);
		return bits.join(' · ');
	}
</script>

<svelte:head>
	<title>Packages — Gift Tracker</title>
</svelte:head>

<main class="packages">
	<header class="page-header">
		<p class="eyebrow">Packages</p>
		<h1>What's on its way?</h1>
	</header>

	{#if data.onTheWay.length === 0 && data.arrived.length === 0}
		<section class="card empty">
			<p>Nothing shipping right now.</p>
		</section>
	{/if}

	{#if data.onTheWay.length > 0}
		<section class="card">
			<p class="section-eyebrow">On the way</p>
			<ul class="list">
				{#each data.onTheWay as g (g.id)}
					<li>
						<a href="/app/gifts/{g.id}" class="row">
							<div>
								<p class="title">{g.title}</p>
								<p class="meta">For {g.person_display_name}</p>
								{#if trackingLabel(g)}
									<p class="tracking">{trackingLabel(g)}</p>
								{/if}
							</div>
							<span class="pill attention">{managerLabel(g.status)}</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.arrived.length > 0}
		<section class="card">
			<p class="section-eyebrow">Arrived — waiting to wrap</p>
			<ul class="list">
				{#each data.arrived as g (g.id)}
					<li>
						<a href="/app/gifts/{g.id}" class="row">
							<div>
								<p class="title">{g.title}</p>
								<p class="meta">For {g.person_display_name}</p>
							</div>
							<span class="pill good">{managerLabel(g.status)}</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
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

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 20px;
		margin-bottom: 12px;
	}

	.section-eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
		margin-bottom: 12px;
	}

	.empty p {
		font-size: 17px;
		color: var(--muted);
		text-align: center;
		padding: 20px 0;
	}

	.list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
		text-decoration: none;
	}

	.row:hover {
		border-color: var(--green);
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

	.pill.good {
		background: var(--green-soft);
		color: var(--green);
	}
</style>
