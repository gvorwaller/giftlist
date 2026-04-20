<script lang="ts">
	import type { PageData } from './$types';
	import { managerLabel } from '$lib/gift-status';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function daysUntilLabel(days: number): string {
		if (days === 0) return 'today';
		if (days === 1) return 'tomorrow';
		if (days < 7) return `in ${days} days`;
		if (days < 14) return `next week`;
		return `in ${days} days`;
	}

	function occasionLine(o: (typeof data.comingUp)[number]): string {
		if (o.occasionKind === 'birthday' && o.turnsAge !== null) {
			return `${o.personDisplayName}'s birthday — turns ${o.turnsAge} ${daysUntilLabel(o.daysUntil)}`;
		}
		return `${o.personDisplayName}'s ${o.occasionTitle.toLowerCase()} ${daysUntilLabel(o.daysUntil)}`;
	}

	function comingUpShort(o: (typeof data.comingUp)[number]): string {
		const when = daysUntilLabel(o.daysUntil);
		if (o.occasionKind === 'birthday' && o.turnsAge !== null) {
			return `Turns ${o.turnsAge} ${when}`;
		}
		return `${o.occasionTitle} ${when}`;
	}

	function dateStr(d: Date | string): string {
		const date = d instanceof Date ? d : new Date(d);
		return date.toLocaleDateString('en-US', {
			weekday: 'long',
			month: 'long',
			day: 'numeric'
		});
	}

	const hasAnything = $derived(
		Boolean(
			data.nextBestAction ||
				data.comingUp.length ||
				data.packagesOnTheWay.length ||
				data.resumeDraft
		)
	);
</script>

<svelte:head>
	<title>Today — Gift Tracker</title>
</svelte:head>

<main class="today">
	<header class="page-header">
		<p class="date">Today</p>
		<h1>Hi, {data.user.display_name}</h1>
	</header>

	{#if !hasAnything}
		<section class="card hero calm">
			<p class="eyebrow">All set</p>
			<p class="hero-body">Everything that matters right now is handled.</p>
			<p class="sub">Check back tomorrow, or add a gift idea.</p>
			<a href="/app/gifts/new" class="primary">Add a gift</a>
		</section>
	{/if}

	{#if data.nextBestAction}
		{@const a = data.nextBestAction}
		<section class="card hero">
			<p class="eyebrow">Next best thing</p>
			<h2>{occasionLine(a)}.</h2>
			<p class="sub">{dateStr(a.occurrence)} — no gift marked bought yet.</p>
			<div class="row">
				<a href="/app/gifts/new?person={a.personId}" class="primary">Add a gift for {a.personDisplayName}</a>
				<a href="/app/people/{a.personId}" class="ghost">See {a.personDisplayName}</a>
			</div>
		</section>
	{/if}

	{#if data.resumeDraft}
		<section class="card nudge">
			<p class="eyebrow">Pick up where you left off</p>
			<p class="body">You started a gift entry earlier.</p>
			<a href="/app/gifts/new" class="primary">Continue draft</a>
		</section>
	{/if}

	{#if data.comingUp.length > 0}
		<section class="card">
			<p class="eyebrow">Coming up soon</p>
			<ul class="occ-list">
				{#each data.comingUp as o (o.personOccasionId)}
					<li>
						<a href="/app/people/{o.personId}" class="occ-row">
							<div class="occ-main">
								<p class="name">{o.personDisplayName}</p>
								<p class="meta">{comingUpShort(o)}</p>
							</div>
							{#if o.hasHandledGift}
								<span class="pill done">Gift handled</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.packagesOnTheWay.length > 0}
		<section class="card">
			<p class="eyebrow">Packages on the way</p>
			<ul class="pkg-list">
				{#each data.packagesOnTheWay as g (g.id)}
					<li>
						<a href="/app/gifts/{g.id}" class="pkg-row">
							<div>
								<p class="name">{g.title}</p>
								<p class="meta">
									For {g.person_display_name}
									{#if g.carrier || g.tracking_number}
										·
										{#if g.carrier}{g.carrier}{/if}{#if g.tracking_number} {g.tracking_number}{/if}
									{/if}
								</p>
							</div>
							<span class="pill attention">{managerLabel(g.status)}</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.recentlyViewed.length > 0}
		<section class="card">
			<p class="eyebrow">Recently viewed</p>
			<ul class="recent-list">
				{#each data.recentlyViewed as r (r.id)}
					<li>
						<a href={r.entity_type === 'person' ? `/app/people/${r.entity_id}` : `/app/gifts/${r.entity_id}`}>
							{r.label}
						</a>
						<span class="meta">· {r.entity_type}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</main>

<style>
	.today {
		max-width: 430px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 16px;
	}

	.date {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}

	h1 {
		margin-top: 6px;
		font-size: 30px;
		line-height: 1.1;
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 22px;
		margin-bottom: 12px;
	}

	.hero {
		background: linear-gradient(135deg, #fdf7ea 0%, #fffdf8 60%);
		border-color: #e7d8bc;
	}

	.hero.calm {
		background: linear-gradient(135deg, #eef3ec 0%, #fffdf8 60%);
		border-color: var(--green-soft);
	}

	.nudge {
		background: var(--amber-soft);
		border-color: var(--amber);
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
		font-size: 25px;
		line-height: 1.2;
	}

	.hero-body {
		font-family: var(--font-serif);
		font-size: 22px;
		line-height: 1.2;
		color: var(--ink);
	}

	.sub {
		margin-top: 8px;
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--muted);
	}

	.body {
		font-size: 15px;
		color: var(--ink);
		margin-bottom: 10px;
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 14px;
	}

	.primary,
	.ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 12px 20px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		text-decoration: none;
		border: 1px solid transparent;
	}

	.primary {
		background: var(--green);
		color: var(--paper);
		border-color: var(--green);
	}

	.ghost {
		background: transparent;
		color: var(--muted);
		border-color: var(--line);
	}

	.occ-list,
	.pkg-list,
	.recent-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.occ-row,
	.pkg-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
		text-decoration: none;
	}

	.occ-row:hover,
	.pkg-row:hover {
		border-color: var(--green);
	}

	.name {
		font-family: var(--font-serif);
		font-size: 18px;
	}

	.meta {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 13px;
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
	}

	.pill.done {
		background: var(--green-soft);
		color: var(--green);
	}

	.pill.attention {
		background: var(--amber-soft);
		color: var(--amber);
	}

	.recent-list li {
		padding: 6px 0;
		font-family: var(--font-sans);
		font-size: 15px;
	}

	.recent-list a {
		color: var(--ink);
	}

	.recent-list .meta {
		text-transform: capitalize;
		display: inline;
	}
</style>
