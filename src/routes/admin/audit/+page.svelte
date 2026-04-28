<script lang="ts">
	import { page } from '$app/stores';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function entityLink(type: string, id: number): string | null {
		switch (type) {
			case 'person':
				return `/admin/people/${id}`;
			case 'gift':
				return `/app/gifts/${id}`;
			case 'import':
				return `/admin/imports/amazon/review?run=${id}`;
			default:
				return null;
		}
	}

	function formatTimestamp(iso: string): string {
		const n = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
		const d = new Date(n);
		if (isNaN(d.getTime())) return iso;
		return d.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	// Build the URL for a different page, preserving current filters.
	function pageUrl(targetPage: number): string {
		const params = new URLSearchParams($page.url.searchParams);
		if (targetPage <= 1) params.delete('page');
		else params.set('page', String(targetPage));
		const qs = params.toString();
		return qs ? `?${qs}` : '/admin/audit';
	}
</script>

<svelte:head>
	<title>Audit log — Admin — Gift Tracker</title>
</svelte:head>

<main class="audit">
	<header class="page-header">
		<p class="eyebrow">Admin</p>
		<h1>Audit log</h1>
		<p class="subtitle">
			Every create, update, archive, status transition, and import decision.
			{data.total.toLocaleString()} entries.
		</p>
	</header>

	<form method="GET" class="filters card">
		<div class="filter-grid">
			<label>
				<span>Search summary</span>
				<input
					type="search"
					name="q"
					value={data.applied.q ?? ''}
					placeholder="e.g. Kate, returned, archived…"
				/>
			</label>

			<label>
				<span>Actor</span>
				<select name="actor">
					<option value="">All</option>
					{#each data.filters.actors as a (a.id)}
						<option value={a.id} selected={data.applied.actorUserId === a.id}>
							{a.display_name}
						</option>
					{/each}
				</select>
			</label>

			<label>
				<span>Entity</span>
				<select name="entity">
					<option value="">All</option>
					{#each data.filters.entityTypes as t (t)}
						<option value={t} selected={data.applied.entityType === t}>{t}</option>
					{/each}
				</select>
			</label>

			<label>
				<span>Action</span>
				<select name="action">
					<option value="">All</option>
					{#each data.filters.actions as a (a)}
						<option value={a} selected={data.applied.action === a}>{a}</option>
					{/each}
				</select>
			</label>

			<label>
				<span>Since</span>
				<input type="date" name="since" value={data.applied.since ?? ''} />
			</label>

			<label>
				<span>Until</span>
				<input type="date" name="until" value={data.applied.until ?? ''} />
			</label>
		</div>

		<div class="filter-actions">
			<button type="submit" class="primary">Apply filters</button>
			<a href="/admin/audit" class="ghost">Reset</a>
		</div>
	</form>

	{#if data.rows.length === 0}
		<section class="card">
			<p class="empty">
				{#if data.total === 0}
					No audit entries yet. Make a change anywhere in the app and they'll show up here.
				{:else}
					No entries match the current filters. <a href="/admin/audit">Reset</a> to see everything.
				{/if}
			</p>
		</section>
	{:else}
		<section class="card">
			<ul class="entries">
				{#each data.rows as r (r.id)}
					{@const link = entityLink(r.entity_type, r.entity_id)}
					<li class="entry">
						<div class="meta">
							<time datetime={r.created_at}>{formatTimestamp(r.created_at)}</time>
							<span class="actor">{r.actor_display_name}</span>
						</div>
						<div class="event">
							<span class="badge entity-{r.entity_type}">{r.entity_type}</span>
							<span class="badge action">{r.action}</span>
							<span class="summary">{r.summary}</span>
							{#if link}
								<a href={link} class="open" aria-label="Open {r.entity_type} #{r.entity_id}">
									Open →
								</a>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</section>

		{#if data.totalPages > 1}
			<nav class="pager" aria-label="Audit log pagination">
				{#if data.page > 1}
					<a href={pageUrl(data.page - 1)} class="ghost">← Prev</a>
				{:else}
					<span class="ghost disabled">← Prev</span>
				{/if}
				<span class="page-info">Page {data.page} of {data.totalPages}</span>
				{#if data.page < data.totalPages}
					<a href={pageUrl(data.page + 1)} class="ghost">Next →</a>
				{:else}
					<span class="ghost disabled">Next →</span>
				{/if}
			</nav>
		{/if}
	{/if}
</main>

<style>
	.audit {
		max-width: 960px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 18px;
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
		font-size: 30px;
	}

	.subtitle {
		margin-top: 8px;
		font-size: 16px;
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

	.filters {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.filter-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
	}

	.filter-grid label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.filter-grid span {
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.filter-grid input,
	.filter-grid select {
		min-height: var(--tap-target);
		padding: 8px 12px;
		font-family: var(--font-sans);
		font-size: 15px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.filter-actions {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.empty {
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--muted);
	}

	.entries {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}

	.entry {
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.entry:last-child {
		border-bottom: none;
	}

	.meta {
		display: flex;
		gap: 12px;
		align-items: baseline;
		flex-wrap: wrap;
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
	}

	.meta time {
		font-weight: 600;
		color: var(--ink);
	}

	.actor {
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 700;
		color: var(--green);
	}

	.event {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		font-family: var(--font-sans);
		font-size: 15px;
	}

	.badge {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 3px 8px;
		border-radius: var(--radius-pill);
		background: var(--bg);
		color: var(--muted);
	}

	.badge.action {
		background: var(--green-soft);
		color: var(--green);
	}

	.badge.entity-person { background: var(--amber-soft); color: var(--amber); }
	.badge.entity-gift { background: var(--green-soft); color: var(--green); }
	.badge.entity-import { background: var(--bg); color: var(--ink); border: 1px solid var(--line); }

	.summary {
		flex: 1 1 auto;
		min-width: 200px;
		color: var(--ink);
	}

	.open {
		font-size: 14px;
		color: var(--green);
		text-decoration: none;
		font-weight: 600;
	}

	.open:hover {
		text-decoration: underline;
	}

	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-top: 10px;
		padding: 10px 0;
	}

	.page-info {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.primary,
	.ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 10px 18px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
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

	.ghost {
		background: transparent;
		color: var(--muted);
		border-color: var(--line);
	}

	.ghost.disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
