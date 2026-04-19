<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function monthName(m: number | null): string {
		if (!m) return '';
		return new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' });
	}

	function daysUntilLabel(days: number): string {
		if (days === 0) return 'is today';
		if (days === 1) return 'is tomorrow';
		if (days < 7) return `is in ${days} days`;
		if (days < 14) return `is next week`;
		return `is in ${days} days`;
	}

	function priceDollars(cents: number | null): string {
		if (cents == null) return '';
		return `$${(cents / 100).toFixed(2)}`;
	}
</script>

<svelte:head>
	<title>{data.person.display_name} — Gift Tracker</title>
</svelte:head>

<main class="person">
	<header class="page-header">
		<p class="crumbs"><a href="/app/people">People</a></p>
		<h1>{data.person.display_name}</h1>
		{#if data.person.relationship}
			<p class="relationship">{data.person.relationship}</p>
		{/if}
	</header>

	{#if data.person.nextOccasion}
		<section class="card hero">
			<p class="eyebrow">Next up</p>
			{#if data.person.nextOccasion.kind === 'birthday' && data.person.nextOccasion.turnsAge !== null}
				<h2>
					Turns {data.person.nextOccasion.turnsAge}
					{daysUntilLabel(data.person.nextOccasion.daysUntil)}
				</h2>
			{:else}
				<h2>
					{data.person.nextOccasion.title}
					{daysUntilLabel(data.person.nextOccasion.daysUntil)}
				</h2>
			{/if}
			<p class="hero-sub">
				{data.person.nextOccasion.date.toLocaleDateString('en-US', {
					weekday: 'long',
					month: 'long',
					day: 'numeric'
				})}
			</p>
		</section>
	{/if}

	<a class="add-gift" href="/app/gifts/new?person={data.person.id}">Add a gift</a>

	{#if data.person.lastGift}
		<section class="card">
			<p class="eyebrow">Last gift</p>
			<p class="body">
				<strong>{data.person.lastGift.title}</strong>
				{#if data.person.lastGift.price_cents}
					· {priceDollars(data.person.lastGift.price_cents)}
				{/if}
			</p>
			<p class="subbody">Status: {data.person.lastGift.status}</p>
		</section>
	{/if}

	{#if data.personOccasions.length > 0}
		<section class="card">
			<p class="eyebrow">Occasions</p>
			<ul class="occ-list">
				{#each data.personOccasions as o (o.personOccasionId)}
					<li>
						<p class="title">{o.title}</p>
						<p class="meta">
							{#if o.recurrence === 'annual' && o.month && o.day}
								{monthName(o.month)}
								{o.day}{#if o.year}, {o.year}{/if}
							{:else if o.recurrence === 'one_time' && o.date}
								{o.date}
							{:else}
								—
							{/if}
							{#if o.link_notes}
								· {o.link_notes}
							{/if}
						</p>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.person.notes}
		<section class="card">
			<p class="eyebrow">Notes</p>
			<p class="body">{data.person.notes}</p>
		</section>
	{/if}
</main>

<style>
	.person {
		max-width: 430px;
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
		font-size: 32px;
		line-height: 1.05;
	}

	.relationship {
		margin-top: 6px;
		font-family: var(--font-sans);
		font-size: 16px;
		color: var(--muted);
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 22px 22px;
		margin-bottom: 14px;
	}

	.hero {
		background: linear-gradient(135deg, #fdf7ea 0%, #fffdf8 60%);
		border: 1px solid #e7d8bc;
	}

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
		margin-bottom: 10px;
	}

	h2 {
		font-size: 26px;
		line-height: 1.15;
	}

	.hero-sub {
		margin-top: 8px;
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--muted);
	}

	.body {
		font-size: 17px;
		color: var(--ink);
	}

	.subbody {
		margin-top: 6px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.add-gift {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 56px;
		margin: 6px 0 14px;
		background: var(--green);
		color: var(--paper);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 17px;
		font-weight: 600;
		text-decoration: none;
		box-shadow: var(--shadow);
	}

	.occ-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.occ-list li {
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
	}

	.occ-list .title {
		font-family: var(--font-serif);
		font-size: 18px;
	}

	.occ-list .meta {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}
</style>
