<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	let selectMode = $state(false);
	let selected = $state(new Set<number>());

	function toggleSelected(id: number) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function clearSelection() {
		selected = new Set();
	}

	function exitSelectMode() {
		selectMode = false;
		clearSelection();
	}
</script>

<svelte:head>
	<title>People — Admin — Gift Tracker</title>
</svelte:head>

<main class="admin-people">
	<header class="page-header">
		<p class="eyebrow">Admin</p>
		<h1>People</h1>
		<p class="subtitle">Manage recipients, occasions, and shipping defaults.</p>
	</header>

	<div class="toolbar">
		<form method="GET" class="search">
			<label>
				<span class="sr">Search people</span>
				<input
					type="search"
					name="q"
					value={data.search}
					placeholder="Search by name…"
					autocomplete="off"
				/>
			</label>
			{#if data.includeArchived}
				<input type="hidden" name="archived" value="1" />
			{/if}
			<button type="submit" class="ghost">Search</button>
		</form>

		<div class="controls">
			<a
				class="toggle"
				href={data.sort === 'alphabetical'
					? (data.includeArchived ? '?archived=1' : '?')
					: (data.includeArchived ? '?sort=alphabetical&archived=1' : '?sort=alphabetical')}
			>
				Sort: {data.sort === 'alphabetical' ? 'by last name' : 'by upcoming'}
			</a>
			<a class="toggle" href={data.includeArchived ? '?' : '?archived=1'}>
				{data.includeArchived ? 'Hide archived' : 'Show archived'}
			</a>
			<button
				type="button"
				class="toggle"
				onclick={() => {
					if (selectMode) exitSelectMode();
					else selectMode = true;
				}}
			>
				{selectMode ? 'Exit select' : 'Select multiple'}
			</button>
			<a class="primary" href="/admin/people/new">Add person</a>
		</div>
	</div>

	{#if form?.scope === 'bulk' && form.ok}
		<div class="flash ok" role="status">
			Assigned occasion to {form.count} {form.count === 1 ? 'person' : 'people'}.
		</div>
	{:else if form?.scope === 'bulk' && form.error}
		<div class="flash err" role="alert">{form.error}</div>
	{/if}

	{#if data.people.length === 0}
		<div class="empty">
			<p>No people yet.</p>
			<p class="hint">
				Add one manually, or run the Google Contacts import from
				<a href="/admin/imports">Imports</a>.
			</p>
		</div>
	{:else}
		<ul class="list" class:select-mode={selectMode}>
			{#each data.people as person (person.id)}
				<li class="row-li">
					{#if selectMode}
						<label class="select-cell">
							<input
								type="checkbox"
								checked={selected.has(person.id)}
								onchange={() => toggleSelected(person.id)}
								aria-label="Select {person.display_name}"
							/>
						</label>
					{/if}
					<a class="row" class:archived={person.is_archived === 1} href="/admin/people/{person.id}">
						<div class="row-main">
							<p class="name">{person.display_name}</p>
							<p class="meta">
								{#if person.relationship}
									{person.relationship}
								{/if}
								{#if person.relationship && person.nextOccasion}
									<span class="dot"> · </span>
								{/if}
								{#if person.nextOccasion}
									{#if person.nextOccasion.kind === 'birthday' && person.nextOccasion.turnsAge !== null}
										<span class="occ"
											>Turns {person.nextOccasion.turnsAge} in {person.nextOccasion
												.daysUntil} day{person.nextOccasion.daysUntil === 1 ? '' : 's'}</span
										>
									{:else}
										<span class="occ"
											>{person.nextOccasion.title} in {person.nextOccasion.daysUntil} day{person
												.nextOccasion.daysUntil === 1
												? ''
												: 's'}</span
										>
									{/if}
								{/if}
							</p>
						</div>
						{#if person.is_archived}
							<span class="badge archived-badge">Archived</span>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	{#if selectMode && selected.size > 0}
		<form method="POST" action="?/bulkAssignOccasion" class="bulk-bar">
			{#each [...selected] as id (id)}
				<input type="hidden" name="person_ids" value={id} />
			{/each}
			<span class="bulk-count">{selected.size} selected</span>
			<label class="bulk-occ">
				<span class="sr">Occasion</span>
				<select name="occasion_id" required>
					<option value="">Choose occasion…</option>
					{#each data.sharedOccasions as o (o.id)}
						<option value={o.id}>{o.title}</option>
					{/each}
				</select>
			</label>
			<button type="submit" class="primary">Assign</button>
			<button type="button" class="ghost" onclick={clearSelection}>Clear</button>
		</form>
	{/if}
</main>

<style>
	.admin-people {
		max-width: 720px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 22px;
	}

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
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

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.search {
		display: flex;
		gap: 8px;
		flex: 1 1 260px;
	}

	.search label {
		flex: 1;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.search input {
		width: 100%;
		min-height: var(--tap-target);
		padding: 10px 14px;
		font-size: 17px;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.controls {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.primary,
	.ghost,
	.toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 10px 16px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
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
		color: var(--green);
		border: 1px solid var(--line);
	}

	.toggle {
		background: transparent;
		color: var(--muted);
		border: 1px solid transparent;
		font-size: 14px;
	}

	.toggle:hover {
		color: var(--ink);
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

	.hint {
		margin-top: 8px;
		font-size: 14px;
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
		gap: 12px;
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

	.row.archived {
		opacity: 0.65;
	}

	.name {
		font-family: var(--font-serif);
		font-size: 21px;
		line-height: 1.15;
	}

	.meta {
		margin-top: 4px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.badge {
		padding: 4px 10px;
		border-radius: var(--radius-pill);
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.archived-badge {
		background: var(--line);
		color: var(--muted);
	}

	.row-li {
		display: flex;
		align-items: stretch;
		gap: 10px;
	}

	.list.select-mode .row-li > .row {
		flex: 1 1 auto;
	}

	.select-cell {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: var(--tap-target);
		min-height: var(--tap-target);
		padding: 0 6px;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		cursor: pointer;
	}

	.select-cell input[type='checkbox'] {
		width: 22px;
		height: 22px;
	}

	.flash {
		padding: 12px 16px;
		border-radius: var(--radius-control);
		margin-bottom: 12px;
		font-family: var(--font-sans);
		font-size: 15px;
	}

	.flash.ok { background: var(--green-soft); color: var(--green); border: 1px solid var(--green); }
	.flash.err { background: #fde9e6; color: var(--rose); border: 1px solid var(--rose); }

	.bulk-bar {
		position: fixed;
		left: 0;
		right: 0;
		/* Above SignedInBar (which sits above BottomNav). */
		bottom: calc(var(--tap-target) + 16px + env(safe-area-inset-bottom) + 56px);
		background: var(--paper);
		border-top: 1px solid var(--line);
		box-shadow: 0 -4px 14px rgba(47, 35, 18, 0.08);
		padding: 12px 18px;
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		z-index: 18;
	}

	.bulk-count {
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		color: var(--green);
	}

	.bulk-occ {
		flex: 1 1 200px;
	}

	.bulk-occ select {
		width: 100%;
		min-height: var(--tap-target);
		padding: 8px 12px;
		font-family: var(--font-sans);
		font-size: 15px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}
</style>
