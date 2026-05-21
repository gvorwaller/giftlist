<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	const active = $derived(data.keywords.filter((k) => k.is_archived === 0));
	const archived = $derived(data.keywords.filter((k) => k.is_archived === 1));

	let editingId = $state<number | null>(null);

	type Feedback = { scope?: string; error?: string; id?: number; ok?: boolean };

	function updateError(id: number): string | null {
		const f = form as Feedback | null | undefined;
		if (f?.scope === 'update' && typeof f.error === 'string' && f.id === id) return f.error;
		return null;
	}
</script>

<svelte:head>
	<title>Exclusions — Admin — Gift Tracker</title>
</svelte:head>

<main class="exclusions">
	<header class="page-header">
		<p class="crumbs"><a href="/admin">Admin</a> / Exclusions</p>
		<h1>Amazon exclusions</h1>
		<p class="subtitle">
			Keywords that filter recurring non-gift items out of the Amazon importer. Any line item
			whose title matches an active keyword is dropped at scan time and hidden on the review
			page — so household supplies and subscriptions stop cluttering the queue.
		</p>
	</header>

	<section class="card">
		<p class="eyebrow">Add keyword</p>
		<form method="POST" action="?/create" class="add-form">
			<label class="add-label keyword">
				<span class="lbl">Keyword</span>
				<input type="text" name="keyword" required autocomplete="off" placeholder="Tide PODS, paper towels, …" />
			</label>
			<label class="add-label match">
				<span class="lbl">Match</span>
				<select name="match_type">
					<option value="contains" selected>contains</option>
					<option value="exact">exact</option>
				</select>
			</label>
			<label class="add-label notes">
				<span class="lbl">Notes (optional)</span>
				<input type="text" name="notes" autocomplete="off" placeholder="why excluded" />
			</label>
			<button type="submit" class="primary">Add</button>
		</form>
		<p class="help">
			<strong>contains</strong> matches if the keyword appears anywhere in the item title
			(case-insensitive) — best for long Amazon titles. <strong>exact</strong> matches the whole
			title only.
		</p>
		{#if form?.scope === 'create' && form.error}
			<p class="err" role="alert">{form.error}</p>
		{:else if form?.scope === 'create' && form.ok}
			<p class="ok" role="status">Keyword added.</p>
		{/if}
	</section>

	<section class="card">
		<p class="eyebrow">Active ({active.length})</p>
		{#if active.length === 0}
			<p class="muted">No active keywords yet.</p>
		{:else}
			<ul class="list">
				{#each active as k (k.id)}
					{@const isEditing = editingId === k.id}
					{@const updErr = updateError(k.id)}
					<li class="row">
						{#if isEditing}
							<form method="POST" action="?/update" class="edit-form">
								<input type="hidden" name="id" value={k.id} />
								<input type="text" name="keyword" value={k.keyword} required autocomplete="off" />
								<select name="match_type">
									<option value="contains" selected={k.match_type === 'contains'}>contains</option>
									<option value="exact" selected={k.match_type === 'exact'}>exact</option>
								</select>
								<input type="text" name="notes" value={k.notes ?? ''} autocomplete="off" placeholder="notes" />
								<div class="row-actions">
									<button type="submit" class="primary">Save</button>
									<button type="button" class="ghost" onclick={() => (editingId = null)}>Cancel</button>
								</div>
							</form>
							{#if updErr}
								<p class="err" role="alert">{updErr}</p>
							{/if}
						{:else}
							<div class="row-main">
								<p class="name">{k.keyword}</p>
								<p class="meta">
									<span class="tag">{k.match_type}</span>
									{#if k.notes}· {k.notes}{/if}
								</p>
							</div>
							<div class="row-actions">
								<button type="button" class="ghost" onclick={() => (editingId = k.id)}>Edit</button>
								<form method="POST" action="?/archive">
									<input type="hidden" name="id" value={k.id} />
									<button type="submit" class="ghost danger">Archive</button>
								</form>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if archived.length > 0}
		<section class="card archived-card">
			<p class="eyebrow">Archived ({archived.length})</p>
			<p class="muted small">
				Archived keywords stop filtering. Restore one if you excluded something by mistake.
			</p>
			<ul class="list">
				{#each archived as k (k.id)}
					<li class="row">
						<div class="row-main">
							<p class="name dim">{k.keyword}</p>
							<p class="meta">
								<span class="tag">{k.match_type}</span>
								{#if k.notes}· {k.notes}{/if}
							</p>
						</div>
						<div class="row-actions">
							<form method="POST" action="?/unarchive">
								<input type="hidden" name="id" value={k.id} />
								<button type="submit" class="ghost">Restore</button>
							</form>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</main>

<style>
	.exclusions {
		max-width: 720px;
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
	}

	.subtitle {
		margin-top: 8px;
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--muted);
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 22px;
		margin-bottom: 14px;
	}

	.archived-card {
		background: var(--bg);
	}

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
		margin-bottom: 12px;
	}

	.add-form {
		display: flex;
		gap: 10px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.add-label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.add-label.keyword {
		flex: 2;
		min-width: 180px;
	}

	.add-label.notes {
		flex: 2;
		min-width: 160px;
	}

	.add-label.match {
		flex: 0 0 auto;
	}

	.lbl {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	input[type='text'],
	select {
		min-height: var(--tap-target);
		padding: 12px 14px;
		font-family: var(--font-sans);
		font-size: 17px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.help {
		margin-top: 10px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.row {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
	}

	.row-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}

	.row-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.row form {
		display: inline;
		margin: 0;
	}

	.name {
		font-family: var(--font-serif);
		font-size: 18px;
		color: var(--ink);
	}

	.name.dim {
		color: var(--muted);
	}

	.meta {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.tag {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--green-soft);
		color: var(--green);
		font-weight: 600;
	}

	.muted {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.muted.small {
		font-size: 13px;
		margin-bottom: 10px;
	}

	.edit-form {
		display: flex;
		gap: 8px;
		align-items: center;
		flex: 1;
		flex-wrap: wrap;
	}

	.edit-form input[type='text'] {
		flex: 1;
		min-width: 140px;
	}

	.primary,
	.ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 10px 16px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 14px;
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

	.ghost.danger {
		color: var(--rose);
		border-color: var(--rose);
	}

	.err {
		margin-top: 8px;
		color: var(--rose);
		font-size: 14px;
	}

	.ok {
		margin-top: 8px;
		color: var(--green);
		font-size: 14px;
	}
</style>
