<script lang="ts">
	import type { PageData } from './$types';
	import { managerLabel } from '$lib/gift-status';
	import type { GiftStatus } from '$server/types';

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

	function badgeTone(s: GiftStatus): 'neutral' | 'attention' | 'good' | 'danger' {
		switch (s) {
			case 'idea':
			case 'planned':
				return 'neutral';
			case 'ordered':
			case 'shipped':
			case 'delivered':
				return 'attention';
			case 'wrapped':
			case 'given':
				return 'good';
			case 'returned':
				return 'danger';
		}
	}

	const ACTIVE_STATUSES: GiftStatus[] = [
		'idea',
		'planned',
		'ordered',
		'shipped',
		'delivered',
		'wrapped'
	];
	const STATUS_ORDER: Record<GiftStatus, number> = {
		idea: 0,
		planned: 1,
		ordered: 2,
		shipped: 3,
		delivered: 4,
		wrapped: 5,
		given: 6,
		returned: 7
	};

	const activeGifts = $derived(
		[...data.person.gifts]
			.filter((g) => ACTIVE_STATUSES.includes(g.status))
			.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
	);

	// Past = given/returned (still in the active gift list) + everything
	// archived. Grouped by occasion_year DESC so multi-year history clusters
	// (e.g., scanning Christmas 2024/2023/2022 to avoid duplicating ideas).
	// Falls back to created_at year when occasion_year is null. td-efe0ef.
	function yearOf(g: { occasion_year: number | null; created_at: string }): number {
		if (g.occasion_year) return g.occasion_year;
		const d = new Date(g.created_at.replace(' ', 'T'));
		return isNaN(d.getTime()) ? 0 : d.getFullYear();
	}

	const pastGroups = $derived(() => {
		const completedActive = data.person.gifts.filter(
			(g) => g.status === 'given' || g.status === 'returned'
		);
		const all = [...completedActive, ...data.person.archivedGifts];
		const byYear = new Map<number, typeof all>();
		for (const g of all) {
			const y = yearOf(g);
			if (!byYear.has(y)) byYear.set(y, []);
			byYear.get(y)!.push(g);
		}
		const years = [...byYear.keys()].sort((a, b) => b - a);
		return years.map((year) => ({
			year,
			gifts: byYear.get(year)!.sort((a, b) =>
				(b.updated_at ?? '').localeCompare(a.updated_at ?? '')
			)
		}));
	});
	const pastTotal = $derived(pastGroups().reduce((n, g) => n + g.gifts.length, 0));
	let pastExpanded = $state(false);
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

	{#if activeGifts.length > 0}
		<section class="card">
			<p class="eyebrow">Active gifts</p>
			<ul class="gift-list">
				{#each activeGifts as g (g.id)}
					<li class="gift-row">
						<a href="/app/gifts/{g.id}" class="gift-main">
							<div class="gift-text">
								<p class="gift-title">{g.title}</p>
								<p class="gift-meta">
									{#if g.occasion_title}
										{g.occasion_title}{#if g.occasion_year}{` ${g.occasion_year}`}{/if}
									{/if}
									{#if g.occasion_title && g.price_cents}
										·
									{/if}
									{#if g.price_cents}{priceDollars(g.price_cents)}{/if}
								</p>
							</div>
							<span class="pill pill-{badgeTone(g.status)}">{managerLabel(g.status)}</span>
						</a>
						<a
							href="/app/gifts/{g.id}/edit"
							class="gift-edit"
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

	{#if pastTotal > 0}
		<section class="card">
			<button
				type="button"
				class="past-toggle"
				aria-expanded={pastExpanded}
				onclick={() => {
					pastExpanded = !pastExpanded;
				}}
			>
				<span class="eyebrow">
					Past gifts ({pastTotal})
					<span class="caret" aria-hidden="true">{pastExpanded ? '▾' : '▸'}</span>
				</span>
				<span class="past-hint">
					{pastExpanded ? 'Tap to collapse' : 'Given, returned, archived — by year'}
				</span>
			</button>
			{#if pastExpanded}
				{#each pastGroups() as group (group.year)}
					<div class="year-group">
						<p class="year-label">{group.year || '—'}</p>
						<ul class="gift-list">
							{#each group.gifts as g (g.id)}
								<li class="gift-row" class:dim={g.is_archived === 1}>
									<a href="/app/gifts/{g.id}" class="gift-main">
										<div class="gift-text">
											<p class="gift-title">{g.title}</p>
											<p class="gift-meta">
												{#if g.occasion_title}
													{g.occasion_title}
												{/if}
												{#if g.occasion_title && g.price_cents}
													·
												{/if}
												{#if g.price_cents}{priceDollars(g.price_cents)}{/if}
												{#if g.is_archived === 1}
													<span class="archived-tag">· archived</span>
												{/if}
											</p>
										</div>
										<span class="pill pill-{badgeTone(g.status)}">
											{managerLabel(g.status)}
										</span>
									</a>
									<a
										href="/app/gifts/{g.id}/edit"
										class="gift-edit"
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
					</div>
				{/each}
			{/if}
		</section>
	{/if}

	{#if data.person.gifts.length === 0}
		<section class="card">
			<p class="eyebrow">Gifts</p>
			<p class="body muted">No gifts yet for {data.person.display_name}.</p>
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

	.body.muted {
		color: var(--muted);
		font-size: 16px;
	}

	.gift-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.gift-row {
		display: flex;
		align-items: stretch;
		gap: 6px;
	}

	.gift-main {
		flex: 1;
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
		min-height: 56px;
	}

	.gift-main:hover {
		border-color: var(--green);
	}

	.gift-text {
		min-width: 0;
		flex: 1;
	}

	.gift-title {
		font-family: var(--font-serif);
		font-size: 18px;
		line-height: 1.2;
	}

	.gift-meta {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.gift-edit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		min-height: 56px;
		flex-shrink: 0;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--muted);
	}

	.gift-edit:hover {
		color: var(--green);
		border-color: var(--green);
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

	.pill-neutral {
		background: var(--bg);
		color: var(--muted);
		border: 1px solid var(--line);
	}

	.pill-attention {
		background: var(--amber-soft);
		color: var(--amber);
	}

	.pill-good {
		background: var(--green-soft);
		color: var(--green);
	}

	.pill-danger {
		background: #fde9e6;
		color: var(--rose);
	}

	.past-toggle {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
		min-height: var(--tap-target);
	}

	.past-toggle .caret {
		font-size: 12px;
		color: var(--muted);
		margin-left: 4px;
	}

	.past-hint {
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
		font-style: italic;
	}

	.year-group {
		margin-top: 14px;
	}

	.year-group:first-of-type {
		margin-top: 12px;
	}

	.year-label {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.05em;
		color: var(--ink);
		margin-bottom: 6px;
		padding-bottom: 4px;
		border-bottom: 1px dashed var(--line);
	}

	.gift-row.dim {
		opacity: 0.7;
	}

	.archived-tag {
		font-style: italic;
		color: var(--muted);
	}
</style>
