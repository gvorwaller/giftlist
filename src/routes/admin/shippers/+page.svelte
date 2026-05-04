<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	const active = $derived(data.shippers.filter((s) => s.is_archived === 0));
	const archived = $derived(data.shippers.filter((s) => s.is_archived === 1));

	let editingId = $state<number | null>(null);

	type FormFeedback = { scope?: string; error?: string; id?: number; ok?: boolean };

	function isUpdateError(id: number): string | null {
		const f = form as FormFeedback | null | undefined;
		if (f?.scope === 'update' && typeof f.error === 'string' && f.id === id) {
			return f.error;
		}
		return null;
	}
</script>

<svelte:head>
	<title>Shippers — Admin — Gift Tracker</title>
</svelte:head>

<main class="shippers">
	<header class="page-header">
		<p class="crumbs"><a href="/admin">Admin</a> / Shippers</p>
		<h1>Shippers</h1>
		<p class="subtitle">
			The carriers your packages travel on. The "AfterShip slug" tells the tracking
			service which carrier to query — leave blank to let AfterShip auto-detect from
			the tracking-number format. Common slugs:
			<code>usps</code>, <code>ups</code>, <code>fedex</code>, <code>dhl</code>,
			<code>ontrac</code>, <code>lasership</code>.
		</p>
	</header>

	<section class="card">
		<p class="eyebrow">Add shipper</p>
		<form method="POST" action="?/create" class="add-form">
			<label class="add-label">
				<span class="lbl">Display name</span>
				<input
					type="text"
					name="name"
					required
					autocomplete="off"
					placeholder="DHL, OnTrac, …"
				/>
			</label>
			<label class="add-label slug-label">
				<span class="lbl">AfterShip slug</span>
				<input
					type="text"
					name="aftership_slug"
					autocomplete="off"
					placeholder="dhl"
					pattern="[a-z0-9-]*"
				/>
			</label>
			<button type="submit" class="primary">Add</button>
		</form>
		{#if form?.scope === 'create' && form.error}
			<p class="err" role="alert">{form.error}</p>
		{:else if form?.scope === 'create' && form.ok}
			<p class="ok" role="status">Shipper added.</p>
		{/if}
	</section>

	<section class="card">
		<p class="eyebrow">Active ({active.length})</p>
		{#if active.length === 0}
			<p class="muted">No active shippers.</p>
		{:else}
			<ul class="list">
				{#each active as s (s.id)}
					{@const used = data.usageCounts[s.id] ?? 0}
					{@const isEditing = editingId === s.id}
					{@const updateErr = isUpdateError(s.id)}
					<li class="row">
						{#if isEditing}
							<form method="POST" action="?/update" class="edit-form">
								<input type="hidden" name="id" value={s.id} />
								<label class="edit-field">
									<span class="lbl">Name</span>
									<input
										type="text"
										name="name"
										value={s.name}
										required
										autocomplete="off"
									/>
								</label>
								<label class="edit-field">
									<span class="lbl">AfterShip slug</span>
									<input
										type="text"
										name="aftership_slug"
										value={s.aftership_slug ?? ''}
										autocomplete="off"
										pattern="[a-z0-9-]*"
									/>
								</label>
								<div class="row-actions">
									<button type="submit" class="primary">Save</button>
									<button type="button" class="ghost" onclick={() => (editingId = null)}>
										Cancel
									</button>
								</div>
							</form>
							{#if updateErr}
								<p class="err" role="alert">{updateErr}</p>
							{/if}
						{:else}
							<div class="row-main">
								<div>
									<p class="name">{s.name}</p>
									<p class="meta">
										{s.aftership_slug ? `slug: ${s.aftership_slug}` : 'auto-detect'}
										· {used} {used === 1 ? 'gift' : 'gifts'}
									</p>
								</div>
							</div>
							<div class="row-actions">
								<button type="button" class="ghost" onclick={() => (editingId = s.id)}>
									Edit
								</button>
								<form method="POST" action="?/archive">
									<input type="hidden" name="id" value={s.id} />
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
				Archived shippers stop appearing in the gift dropdown but remain on past gifts.
			</p>
			<ul class="list">
				{#each archived as s (s.id)}
					{@const used = data.usageCounts[s.id] ?? 0}
					<li class="row">
						<div class="row-main">
							<div>
								<p class="name dim">{s.name}</p>
								<p class="meta">
									{s.aftership_slug ? `slug: ${s.aftership_slug}` : 'auto-detect'}
									· {used} {used === 1 ? 'gift' : 'gifts'}
								</p>
							</div>
						</div>
						<div class="row-actions">
							<form method="POST" action="?/unarchive">
								<input type="hidden" name="id" value={s.id} />
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
	.shippers {
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

	.subtitle code {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
		background: var(--bg);
		padding: 1px 6px;
		border-radius: 4px;
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
		min-width: 160px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.slug-label {
		max-width: 200px;
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
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		flex-wrap: wrap;
	}

	.row-main {
		flex: 1;
		min-width: 160px;
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
		margin-top: 2px;
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

	.edit-form {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.edit-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
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
