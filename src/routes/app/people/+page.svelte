<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function daysUntilLabel(days: number): string {
		if (days === 0) return 'today';
		if (days === 1) return 'tomorrow';
		if (days < 7) return `in ${days} days`;
		if (days < 14) return `next week`;
		if (days < 60) return `in ${days} days`;
		return `in ${Math.round(days / 30)} months`;
	}
</script>

<svelte:head>
	<title>People — Gift Tracker</title>
</svelte:head>

<main class="people">
	<header class="page-header">
		<p class="eyebrow">People</p>
		<h1>Who are we thinking about?</h1>
	</header>

	<form method="GET" class="search">
		<label>
			<span class="sr">Search</span>
			<input
				type="search"
				name="q"
				value={data.search}
				placeholder="Search by name…"
				autocomplete="off"
			/>
		</label>
		<button type="submit" class="search-btn">Search</button>
	</form>

	{#if data.people.length === 0}
		<div class="empty">
			<p>No people yet. Ask the admin to add some.</p>
		</div>
	{:else}
		<ul class="list">
			{#each data.people as person (person.id)}
				<li>
					<a class="row" href="/app/people/{person.id}">
						<div class="row-main">
							<p class="name">{person.display_name}</p>
							{#if person.relationship}
								<p class="relationship">{person.relationship}</p>
							{/if}
						</div>
						{#if person.nextOccasion}
							<div class="occ">
								{#if person.nextOccasion.kind === 'birthday' && person.nextOccasion.turnsAge !== null}
									<p class="occ-title">Turns {person.nextOccasion.turnsAge}</p>
								{:else}
									<p class="occ-title">{person.nextOccasion.title}</p>
								{/if}
								<p class="occ-when">{daysUntilLabel(person.nextOccasion.daysUntil)}</p>
							</div>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	.people {
		max-width: 430px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 22px;
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
		line-height: 1.08;
	}

	.search {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}

	.search label {
		flex: 1;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}

	.search input {
		width: 100%;
		min-height: var(--tap-target);
		padding: 12px 14px;
		font-size: 17px;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.search-btn {
		min-height: var(--tap-target);
		padding: 10px 18px;
		background: transparent;
		color: var(--green);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
	}

	.empty {
		background: var(--paper);
		border: 1px dashed var(--line);
		border-radius: var(--radius-card);
		padding: 32px 24px;
		text-align: center;
	}

	.empty p {
		font-size: 17px;
		color: var(--muted);
	}

	.list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 18px 20px;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		color: var(--ink);
		text-decoration: none;
	}

	.row:hover {
		border-color: var(--green);
	}

	.name {
		font-family: var(--font-serif);
		font-size: 22px;
		line-height: 1.1;
	}

	.relationship {
		margin-top: 4px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.occ {
		text-align: right;
		flex-shrink: 0;
	}

	.occ-title {
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		color: var(--green);
	}

	.occ-when {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}
</style>
