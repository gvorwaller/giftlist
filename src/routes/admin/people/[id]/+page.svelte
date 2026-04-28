<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	let confirmingArchive = $state(false);
	let confirmingRemoveOccasionId = $state<number | null>(null);

	function monthName(m: number | null): string {
		if (!m) return '';
		return new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' });
	}

	function describeOccasion(
		o: (typeof data.personOccasions)[number]
	): string {
		if (o.recurrence === 'annual' && o.month && o.day) {
			const dateStr = `${monthName(o.month)} ${o.day}`;
			if (o.year) {
				const now = new Date();
				const thisYearOccurrence = new Date(now.getFullYear(), o.month - 1, o.day);
				const nextOccurrence =
					thisYearOccurrence.getTime() >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
						? thisYearOccurrence
						: new Date(now.getFullYear() + 1, o.month - 1, o.day);
				const turns = nextOccurrence.getFullYear() - o.year;
				return `${dateStr}, ${o.year} — turns ${turns}`;
			}
			return dateStr;
		}
		if (o.recurrence === 'one_time' && o.date) return o.date;
		return '—';
	}
</script>

<svelte:head>
	<title>{data.person.display_name} — Admin — Gift Tracker</title>
</svelte:head>

<main class="person-edit">
	<header class="page-header">
		<p class="crumbs"><a href="/admin/people">People</a> / {data.person.display_name}</p>
		<h1>{data.person.display_name}</h1>
		{#if data.person.is_archived}
			<p class="archived-note">Archived. This person is hidden from the manager view.</p>
		{/if}
	</header>

	<!-- Edit core fields -->
	<section class="card">
		<h2>Details</h2>
		<form method="POST" action="?/update">
			<label>
				<span>Display name</span>
				<input name="display_name" type="text" required value={data.person.display_name} />
			</label>
			<label>
				<span>Full name</span>
				<input name="full_name" type="text" value={data.person.full_name ?? ''} />
			</label>
			<label>
				<span>Relationship</span>
				<input name="relationship" type="text" value={data.person.relationship ?? ''} />
			</label>
			<label>
				<span>Default shipping address</span>
				<textarea name="default_shipping_address" rows="3"
					>{data.person.default_shipping_address ?? ''}</textarea
				>
			</label>
			<label>
				<span>Notes</span>
				<textarea name="notes" rows="3">{data.person.notes ?? ''}</textarea>
			</label>

			{#if form?.scope === 'update' && form.error}
				<p class="error" role="alert">{form.error}</p>
			{/if}
			{#if form?.scope === 'update' && form.ok}
				<p class="ok" role="status">Saved.</p>
			{/if}

			<div class="actions">
				<button type="submit" class="primary">Save changes</button>
			</div>
		</form>
	</section>

	<!-- Occasions -->
	<section class="card">
		<h2>Occasions</h2>
		{#if data.personOccasions.length === 0}
			<p class="empty">No occasions assigned yet.</p>
		{:else}
			<ul class="occ-list">
				{#each data.personOccasions as o (o.personOccasionId)}
					<li>
						<div class="occ-main">
							<p class="title">{o.title}</p>
							<p class="meta">
								{o.kind}
								{#if o.recurrence === 'annual'}
									· annual · {describeOccasion(o)}
								{:else}
									· {describeOccasion(o)}
								{/if}
								{#if o.link_notes}<span class="notes"> · {o.link_notes}</span>{/if}
							</p>
						</div>
						{#if confirmingRemoveOccasionId === o.personOccasionId}
							<div class="occ-confirm">
								<button
									type="button"
									class="ghost"
									onclick={() => {
										confirmingRemoveOccasionId = null;
									}}
								>
									Cancel
								</button>
								<form method="POST" action="?/removeOccasion">
									<input type="hidden" name="person_occasion_id" value={o.personOccasionId} />
									<button type="submit" class="ghost danger">Yes, remove</button>
								</form>
							</div>
						{:else}
							<button
								type="button"
								class="ghost danger"
								aria-label="Remove {o.title}"
								onclick={() => {
									confirmingRemoveOccasionId = o.personOccasionId;
								}}
							>
								Remove
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<div class="occ-add">
			<details class="add-block">
				<summary>Add birthday</summary>
				<form method="POST" action="?/addBirthday" class="inline-form">
					<div class="row">
						<label>
							<span>Month</span>
							<input name="month" type="number" min="1" max="12" required />
						</label>
						<label>
							<span>Day</span>
							<input name="day" type="number" min="1" max="31" required />
						</label>
					</div>
					<label>
						<span>Note (optional)</span>
						<input name="notes" type="text" placeholder="Prefers experiences" />
					</label>
					{#if form?.scope === 'birthday' && form.error}
						<p class="error" role="alert">{form.error}</p>
					{/if}
					<button type="submit" class="primary">Save birthday</button>
				</form>
			</details>

			<details class="add-block">
				<summary>Assign shared occasion</summary>
				<form method="POST" action="?/assignShared" class="inline-form">
					<label>
						<span>Occasion</span>
						<select name="occasion_id" required>
							<option value="">Pick one…</option>
							{#each data.sharedOccasions as o (o.id)}
								<option value={o.id}>{o.title}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Note (optional)</span>
						<input name="notes" type="text" placeholder="Likes handwritten cards" />
					</label>
					{#if form?.scope === 'occasion' && form.error}
						<p class="error" role="alert">{form.error}</p>
					{/if}
					<button type="submit" class="primary">Assign</button>
				</form>
			</details>

			<details class="add-block">
				<summary>Add custom occasion (anniversary, name day, …)</summary>
				<form method="POST" action="?/addCustom" class="inline-form">
					<label>
						<span>Title</span>
						<input
							name="title"
							type="text"
							placeholder="Wedding anniversary, name day, special date"
							required
						/>
					</label>
					<label class="recur-label">
						<span>Recurrence</span>
						<select name="recurrence">
							<option value="annual">Annual (same date each year)</option>
							<option value="one_time">One-time</option>
						</select>
					</label>
					<div class="row">
						<label>
							<span>Month (annual only)</span>
							<input name="month" type="number" min="1" max="12" />
						</label>
						<label>
							<span>Day (annual only)</span>
							<input name="day" type="number" min="1" max="31" />
						</label>
					</div>
					<label>
						<span>Date (one-time only)</span>
						<input name="date" type="date" />
					</label>
					<label>
						<span>Reminder lead (days)</span>
						<input name="reminder_days" type="number" min="1" max="365" value="21" />
					</label>
					<label>
						<span>Note (optional)</span>
						<input name="notes" type="text" placeholder="Anniversary of marriage" />
					</label>
					{#if form?.scope === 'custom' && form.error}
						<p class="error" role="alert">{form.error}</p>
					{/if}
					<button type="submit" class="primary">Save occasion</button>
				</form>
			</details>
		</div>
	</section>

	<!-- Archive zone -->
	<section class="card danger-zone">
		<h2>{data.person.is_archived ? 'Restore' : 'Archive'}</h2>
		{#if data.person.is_archived}
			<p>Bring this person back into the manager view.</p>
			<form method="POST" action="?/unarchive">
				<button type="submit" class="primary">Restore {data.person.display_name}</button>
			</form>
		{:else if confirmingArchive}
			<p>Archive hides this person from the manager view. You can restore them later.</p>
			<form method="POST" action="?/archive" class="confirm-row">
				<button
					type="button"
					class="ghost"
					onclick={() => {
						confirmingArchive = false;
					}}
				>
					Cancel
				</button>
				<button type="submit" class="danger-btn">Yes, archive</button>
			</form>
		{:else}
			<p>Archive hides this person from the manager view. They can be restored later.</p>
			<button
				type="button"
				class="ghost danger"
				onclick={() => {
					confirmingArchive = true;
				}}
			>
				Archive {data.person.display_name}
			</button>
		{/if}
	</section>
</main>

<style>
	.person-edit {
		max-width: 560px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 22px;
	}

	.crumbs {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.crumbs a {
		color: var(--muted);
	}

	h1 {
		margin-top: 6px;
		font-size: 31px;
	}

	.archived-note {
		margin-top: 8px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--amber);
		background: var(--amber-soft);
		padding: 8px 12px;
		border-radius: var(--radius-control);
		display: inline-block;
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 24px;
		margin-bottom: 16px;
	}

	h2 {
		font-size: 22px;
		margin-bottom: 16px;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label span {
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	input,
	textarea,
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

	textarea {
		min-height: 84px;
		resize: vertical;
	}

	.error {
		color: var(--rose);
		font-size: 15px;
	}

	.ok {
		color: var(--green);
		font-size: 15px;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}

	.primary {
		min-height: var(--tap-target);
		padding: 10px 20px;
		background: var(--green);
		color: var(--paper);
		border: 1px solid var(--green);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		cursor: pointer;
	}

	.ghost {
		min-height: var(--tap-target);
		padding: 10px 16px;
		background: transparent;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
	}

	.ghost.danger {
		color: var(--rose);
		border-color: var(--rose);
	}

	.danger-btn {
		min-height: var(--tap-target);
		padding: 10px 20px;
		background: var(--rose);
		color: var(--paper);
		border: 1px solid var(--rose);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		cursor: pointer;
	}

	.occ-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 18px;
	}

	.occ-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 16px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
	}

	.occ-main .title {
		font-family: var(--font-serif);
		font-size: 19px;
	}

	.occ-main .meta {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
		text-transform: capitalize;
	}

	.occ-main .notes {
		text-transform: none;
	}

	.occ-confirm {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.empty {
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--muted);
		padding-bottom: 16px;
	}

	.occ-add {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.add-block {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: 12px 16px;
	}

	.add-block[open] {
		padding-bottom: 18px;
	}

	.add-block summary {
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		color: var(--green);
		cursor: pointer;
		min-height: 28px;
		display: flex;
		align-items: center;
	}

	.inline-form {
		margin-top: 14px;
		gap: 14px;
	}

	.inline-form .row {
		display: flex;
		gap: 12px;
	}

	.inline-form .row label {
		flex: 1;
	}

	.inline-form button {
		align-self: flex-start;
	}

	.danger-zone {
		border-color: var(--line);
	}

	.confirm-row {
		flex-direction: row;
		gap: 10px;
		justify-content: flex-end;
	}
</style>
