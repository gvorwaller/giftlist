<script lang="ts">
	import { page } from '$app/stores';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	function formatArchivedAt(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso.replace(' ', 'T'));
		if (isNaN(d.getTime())) return iso;
		return d.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	const restored = $derived($page.url.searchParams.get('restored') === '1');

	function pageHref(p: number): string {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', String(p));
		return `?${params.toString()}`;
	}
</script>

<svelte:head>
	<title>Archived packages — Admin — Gift Tracker</title>
</svelte:head>

<main class="archived">
	<header class="page-header">
		<p class="crumbs"><a href="/admin/system">System</a> / Archived packages</p>
		<h1>Archived packages</h1>
		<p class="subtitle">
			{data.total} archived gift{data.total === 1 ? '' : 's'} · sorted by most
			recently archived first
		</p>
	</header>

	{#if restored}
		<div class="flash ok" role="status">
			Restored. The gift is no longer archived.
		</div>
	{/if}

	<form method="GET" class="search">
		<input
			type="search"
			name="q"
			value={data.q}
			placeholder="Search title or person…"
			aria-label="Search archived gifts"
		/>
		<button type="submit" class="ghost">Search</button>
		{#if data.q}
			<a href="/admin/system/archived" class="ghost">Clear</a>
		{/if}
	</form>

	{#if data.rows.length === 0}
		<section class="card calm">
			<p class="body">
				{#if data.q}
					No archived gifts match "{data.q}".
				{:else}
					Nothing archived yet.
				{/if}
			</p>
		</section>
	{:else}
		<ul class="rows">
			{#each data.rows as r (r.id)}
				<li class="archived-card">
					<div class="row-head">
						<div class="row-title">
							<p class="title">{r.title}</p>
							<p class="meta">
								<a href="/app/people/{r.person_id}">{r.person_display_name}</a>
								{#if r.vendor_name}
									· {r.vendor_name}
								{/if}
								{#if r.order_id}
									· order <span class="mono">{r.order_id}</span>
								{/if}
							</p>
						</div>
						<div class="row-meta">
							<span class="tag status">{r.status}</span>
							<span class="archived-when">archived {formatArchivedAt(r.archived_at)}</span>
						</div>
					</div>
					<div class="row-actions">
						<a href="/app/gifts/{r.id}" class="ghost">Open</a>
						<form
							method="POST"
							action="?/restore&{$page.url.searchParams.toString()}"
							class="inline"
						>
							<input type="hidden" name="gift_id" value={r.id} />
							<button type="submit" class="primary">Restore</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>

		{#if data.totalPages > 1}
			<nav class="pager" aria-label="Pagination">
				{#if data.page > 1}
					<a href={pageHref(data.page - 1)} class="ghost">← Previous</a>
				{/if}
				<span class="page-info">Page {data.page} of {data.totalPages}</span>
				{#if data.page < data.totalPages}
					<a href={pageHref(data.page + 1)} class="ghost">Next →</a>
				{/if}
			</nav>
		{/if}
	{/if}
</main>

<style>
	.archived {
		max-width: 960px;
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

	.flash {
		padding: 14px 18px;
		border-radius: var(--radius-control);
		margin-bottom: 14px;
		font-family: var(--font-sans);
		font-size: 15px;
	}
	.flash.ok {
		background: var(--green-soft);
		color: var(--green);
		border: 1px solid var(--green);
	}

	.search {
		display: flex;
		gap: 10px;
		margin-bottom: 14px;
		align-items: center;
	}
	.search input[type='search'] {
		flex: 1 1 auto;
		min-height: 48px;
		padding: 10px 14px;
		font-family: var(--font-sans);
		font-size: 16px;
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		background: var(--paper);
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 20px;
	}
	.card.calm {
		background: var(--green-soft);
		border-color: var(--green);
	}

	.rows {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 0;
		margin: 0;
	}

	.archived-card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.row-head {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		flex-wrap: wrap;
	}

	.row-title {
		flex: 1 1 auto;
		min-width: 0;
	}

	.title {
		font-family: var(--font-serif);
		font-size: 18px;
		line-height: 1.3;
		color: var(--ink);
		margin: 0;
	}

	.meta {
		margin-top: 4px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}
	.meta a {
		color: var(--green);
	}

	.row-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		flex-shrink: 0;
	}

	.tag.status {
		display: inline-block;
		padding: 2px 10px;
		background: var(--bg);
		color: var(--muted);
		border-radius: var(--radius-pill);
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.archived-when {
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
		font-style: italic;
	}

	.row-actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
	}
	.row-actions .inline {
		margin: 0;
	}

	.mono {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
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

	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 16px;
		gap: 10px;
	}
	.page-info {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}
</style>
