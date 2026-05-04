<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	const active = $derived(data.vendors.filter((v) => v.is_archived === 0));
	const archived = $derived(data.vendors.filter((v) => v.is_archived === 1));

	let editingId = $state<number | null>(null);

	type RenameFeedback = { scope?: string; error?: string; id?: number; ok?: boolean };

	function isRenameError(id: number): string | null {
		const f = form as RenameFeedback | null | undefined;
		if (f?.scope === 'rename' && typeof f.error === 'string' && f.id === id) {
			return f.error;
		}
		return null;
	}
</script>

<svelte:head>
	<title>Vendors — Admin — Gift Tracker</title>
</svelte:head>

<main class="vendors">
	<header class="page-header">
		<p class="crumbs"><a href="/admin">Admin</a> / Vendors</p>
		<h1>Vendors</h1>
		<p class="subtitle">
			Where gifts come from. Add a vendor here before it appears in the gift form's
			"Where from?" dropdown.
		</p>
	</header>

	<section class="card">
		<p class="eyebrow">Add vendor</p>
		<form method="POST" action="?/create" class="add-form">
			<label class="add-label">
				<span class="lbl">Name</span>
				<input type="text" name="name" required autocomplete="off" placeholder="Etsy, World Market, …" />
			</label>
			<button type="submit" class="primary">Add</button>
		</form>
		{#if form?.scope === 'create' && form.error}
			<p class="err" role="alert">{form.error}</p>
		{:else if form?.scope === 'create' && form.ok}
			<p class="ok" role="status">Vendor added.</p>
		{/if}
	</section>

	<section class="card">
		<p class="eyebrow">Active ({active.length})</p>
		{#if active.length === 0}
			<p class="muted">No active vendors yet.</p>
		{:else}
			<ul class="list">
				{#each active as v (v.id)}
					{@const used = data.usageCounts[v.id] ?? 0}
					{@const isEditing = editingId === v.id}
					{@const renameErr = isRenameError(v.id)}
					<li class="row">
						{#if isEditing}
							<form method="POST" action="?/rename" class="rename-form">
								<input type="hidden" name="id" value={v.id} />
								<input type="text" name="name" value={v.name} required autocomplete="off" />
								<div class="row-actions">
									<button type="submit" class="primary">Save</button>
									<button type="button" class="ghost" onclick={() => (editingId = null)}>
										Cancel
									</button>
								</div>
							</form>
							{#if renameErr}
								<p class="err" role="alert">{renameErr}</p>
							{/if}
						{:else}
							<div class="row-main">
								<p class="name">{v.name}</p>
								<p class="meta">
									{used} {used === 1 ? 'gift' : 'gifts'}
								</p>
							</div>
							<div class="row-actions">
								<button type="button" class="ghost" onclick={() => (editingId = v.id)}>
									Rename
								</button>
								<form method="POST" action="?/archive">
									<input type="hidden" name="id" value={v.id} />
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
				Archived vendors stop appearing in the gift dropdown but remain on past gifts.
			</p>
			<ul class="list">
				{#each archived as v (v.id)}
					{@const used = data.usageCounts[v.id] ?? 0}
					<li class="row">
						<div class="row-main">
							<p class="name dim">{v.name}</p>
							<p class="meta">
								{used} {used === 1 ? 'gift' : 'gifts'}
							</p>
						</div>
						<div class="row-actions">
							<form method="POST" action="?/unarchive">
								<input type="hidden" name="id" value={v.id} />
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
	.vendors {
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
		flex: 1;
		min-width: 180px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.lbl {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	input[type='text'] {
		min-height: var(--tap-target);
		padding: 12px 14px;
		font-family: var(--font-sans);
		font-size: 17px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
	}

	.row-main {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
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

	.row {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}

	.row-main {
		flex: 1;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
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

	.muted {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.muted.small {
		font-size: 13px;
		margin-bottom: 10px;
	}

	.rename-form {
		display: flex;
		gap: 8px;
		align-items: center;
		flex: 1;
		flex-wrap: wrap;
	}

	.rename-form input[type='text'] {
		flex: 1;
		min-width: 160px;
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
