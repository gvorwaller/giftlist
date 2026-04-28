<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	let creating = $state(false);
	let editingId = $state<number | null>(null);
	let confirmingDeleteId = $state<number | null>(null);

	let createRecurrence = $state<'annual' | 'one_time'>('annual');

	function monthName(m: number | null): string {
		if (!m) return '';
		return new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' });
	}

	function describe(o: typeof data.occasions[number]): string {
		if (o.recurrence === 'annual' && o.month && o.day) return `${monthName(o.month)} ${o.day} (annual)`;
		if (o.recurrence === 'one_time' && o.date) return `${o.date} (one-time)`;
		return o.recurrence;
	}
</script>

<svelte:head>
	<title>Occasions — Admin — Gift Tracker</title>
</svelte:head>

<main class="occasions">
	<header class="page-header">
		<p class="crumbs"><a href="/admin">Home</a> / Occasions</p>
		<h1>Shared occasions</h1>
		<p class="subtitle">
			Recurring or one-off events you can bulk-assign to people. Per-person events
			(birthdays, custom anniversaries) live on each person's detail page.
		</p>
	</header>

	{#if form?.ok && form.scope === 'create'}
		<div class="flash ok" role="status">Occasion created.</div>
	{:else if form?.ok && form.scope === 'update'}
		<div class="flash ok" role="status">Occasion updated.</div>
	{:else if form?.ok && form.scope === 'delete'}
		<div class="flash ok" role="status">Deleted "{form.deletedTitle}".</div>
	{:else if form?.error}
		<div class="flash err" role="alert">{form.error}</div>
	{/if}

	<section class="card">
		<div class="card-header">
			<h2>Existing ({data.occasions.length})</h2>
			{#if !creating}
				<button
					type="button"
					class="primary"
					onclick={() => {
						creating = true;
						editingId = null;
					}}
				>
					Add occasion
				</button>
			{/if}
		</div>

		{#if data.occasions.length === 0}
			<p class="empty">
				No shared occasions yet. Add one above to start bulk-assigning to family.
			</p>
		{:else}
			<ul class="occ-list">
				{#each data.occasions as o (o.id)}
					{@const assigned = data.assignmentCounts[o.id] ?? 0}
					<li class="occ-row">
						{#if editingId === o.id}
							<form method="POST" action="?/update" class="edit-form">
								<input type="hidden" name="id" value={o.id} />
								<div class="grid">
									<label>
										<span>Title</span>
										<input name="title" type="text" value={o.title} required />
									</label>
									<label>
										<span>Reminder lead (days)</span>
										<input
											name="reminder_days"
											type="number"
											min="1"
											max="365"
											value={o.reminder_days}
											required
										/>
									</label>
									{#if o.recurrence === 'annual'}
										<label>
											<span>Month</span>
											<input name="month" type="number" min="1" max="12" value={o.month ?? ''} required />
										</label>
										<label>
											<span>Day</span>
											<input name="day" type="number" min="1" max="31" value={o.day ?? ''} required />
										</label>
									{:else}
										<label class="span-2">
											<span>Date</span>
											<input name="date" type="date" value={o.date ?? ''} required />
										</label>
									{/if}
								</div>
								<div class="form-actions">
									<button type="button" class="ghost" onclick={() => (editingId = null)}>
										Cancel
									</button>
									<button type="submit" class="primary">Save</button>
								</div>
							</form>
						{:else}
							<div class="occ-main">
								<p class="title">{o.title}</p>
								<p class="meta">
									<span class="kind">{o.kind}</span>
									· {describe(o)}
									· lead {o.reminder_days}d
									{#if assigned > 0}
										· <strong>{assigned}</strong> assigned
									{/if}
								</p>
							</div>
							<div class="occ-actions">
								{#if confirmingDeleteId === o.id}
									<button
										type="button"
										class="ghost"
										onclick={() => (confirmingDeleteId = null)}
									>
										Cancel
									</button>
									<form method="POST" action="?/delete">
										<input type="hidden" name="id" value={o.id} />
										<button type="submit" class="ghost danger">
											{#if assigned > 0}
												Yes, delete &amp; unassign {assigned}
											{:else}
												Yes, delete
											{/if}
										</button>
									</form>
								{:else}
									<button
										type="button"
										class="ghost"
										onclick={() => {
											editingId = o.id;
											confirmingDeleteId = null;
										}}
									>
										Edit
									</button>
									<button
										type="button"
										class="ghost danger"
										onclick={() => (confirmingDeleteId = o.id)}
									>
										Delete
									</button>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if creating}
		<section class="card">
			<h2>New occasion</h2>
			<form method="POST" action="?/create" class="create-form">
				<div class="grid">
					<label class="span-2">
						<span>Title</span>
						<input
							name="title"
							type="text"
							placeholder="Hanukkah, Mother's Day, …"
							required
						/>
					</label>

					<label>
						<span>Kind</span>
						<select name="kind">
							<option value="holiday">Holiday</option>
							<option value="custom">Custom</option>
						</select>
					</label>

					<label>
						<span>Recurrence</span>
						<select name="recurrence" bind:value={createRecurrence}>
							<option value="annual">Annual</option>
							<option value="one_time">One-time</option>
						</select>
					</label>

					{#if createRecurrence === 'annual'}
						<label>
							<span>Month (1–12)</span>
							<input name="month" type="number" min="1" max="12" required />
						</label>
						<label>
							<span>Day (1–31)</span>
							<input name="day" type="number" min="1" max="31" required />
						</label>
					{:else}
						<label class="span-2">
							<span>Date</span>
							<input name="date" type="date" required />
						</label>
					{/if}

					<label>
						<span>Reminder lead (days)</span>
						<input name="reminder_days" type="number" min="1" max="365" value="21" required />
					</label>
				</div>
				<div class="form-actions">
					<button type="button" class="ghost" onclick={() => (creating = false)}>Cancel</button>
					<button type="submit" class="primary">Create occasion</button>
				</div>
			</form>
		</section>
	{/if}
</main>

<style>
	.occasions {
		max-width: 760px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header { padding: 6px 0 18px; }
	.crumbs { font-family: var(--font-sans); font-size: 14px; color: var(--muted); }
	.crumbs a { color: var(--muted); }

	h1 { margin-top: 6px; font-size: 30px; }
	h2 { font-size: 20px; }
	.subtitle { margin-top: 8px; font-size: 16px; color: var(--muted); }

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 20px;
		margin-bottom: 12px;
	}

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-bottom: 14px;
	}

	.empty {
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--muted);
		padding: 12px 0;
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

	.occ-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.occ-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 16px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		flex-wrap: wrap;
	}

	.occ-main {
		flex: 1 1 240px;
	}

	.occ-main .title {
		font-family: var(--font-serif);
		font-size: 20px;
		color: var(--ink);
	}

	.occ-main .meta {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
		margin-top: 4px;
	}

	.kind {
		text-transform: uppercase;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.occ-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.create-form,
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.edit-form {
		width: 100%;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.grid .span-2 {
		grid-column: 1 / span 2;
	}

	.grid label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.grid span {
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.grid input,
	.grid select {
		min-height: var(--tap-target);
		padding: 8px 12px;
		font-family: var(--font-sans);
		font-size: 15px;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.form-actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
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
		color: var(--green);
		border-color: var(--line);
	}

	.ghost.danger {
		color: var(--rose);
		border-color: var(--rose);
	}

	form {
		display: contents;
	}
</style>
