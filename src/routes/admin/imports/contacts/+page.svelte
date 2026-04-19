<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	function monthName(m: number): string {
		return new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' });
	}

	function birthdayLabel(b: { month: number; day: number; year: number | null }): string {
		return b.year ? `${monthName(b.month)} ${b.day}, ${b.year}` : `${monthName(b.month)} ${b.day}`;
	}
</script>

<svelte:head>
	<title>Contacts import — Admin — Gift Tracker</title>
</svelte:head>

<main class="contacts-import">
	<header class="page-header">
		<p class="crumbs"><a href="/admin/imports">Imports</a> / Contacts</p>
		<h1>Google Contacts</h1>
		<p class="subtitle">Import contacts with a birthday from your connected Google account.</p>
	</header>

	{#if !data.connected}
		<section class="card">
			<h2>Connect a Google account first</h2>
			<p class="body">
				This import reads from the Google account connected in
				<a href="/admin/settings">Settings</a>. Connect one there, then come back.
			</p>
		</section>
	{:else if data.fetchError}
		<section class="card">
			<h2>Couldn't fetch contacts</h2>
			<p class="body error">{data.fetchError}</p>
			<p class="body muted">
				The refresh token may have been revoked. Try disconnecting + re-connecting in
				<a href="/admin/settings">Settings</a>.
			</p>
		</section>
	{:else if data.preview}
		{#if data.flash.imported > 0}
			<div class="flash ok" role="status">
				Imported {data.flash.imported} {data.flash.imported === 1 ? 'person' : 'people'} ·
				{data.flash.birthdays} birthday{data.flash.birthdays === 1 ? '' : 's'} recorded.
			</div>
		{/if}
		{#if (data.flash?.yearsBackfilled ?? 0) > 0}
			<div class="flash ok" role="status">
				Filled in birth year for {data.flash?.yearsBackfilled}
				{data.flash?.yearsBackfilled === 1 ? 'person' : 'people'}.
			</div>
		{/if}
		{#if form?.error}
			<div class="flash err" role="alert">{form.error}</div>
		{/if}

		<section class="card stats">
			<dl class="kv">
				<div>
					<dt>Contacts fetched</dt>
					<dd>{data.preview.totalFetched}</dd>
				</div>
				<div>
					<dt>With a birthday</dt>
					<dd>{data.preview.newContacts.length + data.preview.alreadyImported.length}</dd>
				</div>
				<div>
					<dt>Skipped (no birthday)</dt>
					<dd>{data.preview.skippedNoBirthday}</dd>
				</div>
				<div>
					<dt>Already on file</dt>
					<dd>{data.preview.alreadyImported.length}</dd>
				</div>
			</dl>
		</section>

		{#if data.preview.newContacts.length === 0}
			<section class="card">
				<h2>No new contacts</h2>
				<p class="body muted">
					Every Google contact with a birthday is already on file. Add more contacts in Google
					Contacts and re-sync anytime.
				</p>
			</section>
		{:else}
			<section class="card">
				<div class="row">
					<h2>New contacts to import</h2>
					<p class="muted">Sorted by upcoming birthday.</p>
				</div>

				<form method="POST" action="?/import" class="import-form">
					<label class="select-all">
						<input
							type="checkbox"
							checked={true}
							onchange={(e) => {
								const checked = (e.currentTarget as HTMLInputElement).checked;
								document
									.querySelectorAll<HTMLInputElement>('input[name="resource_name"]')
									.forEach((cb) => (cb.checked = checked));
							}}
						/>
						<span>Select all / none</span>
					</label>

					<ul class="contact-list">
						{#each data.preview.newContacts as c (c.resource_name)}
							<li>
								<label class="contact-row">
									<input type="checkbox" name="resource_name" value={c.resource_name} checked />
									<div class="meta">
										<p class="name">{c.display_name}</p>
										<p class="bd">{birthdayLabel(c.birthday)}</p>
										{#if c.primary_email}
											<p class="email">{c.primary_email}</p>
										{/if}
									</div>
								</label>
							</li>
						{/each}
					</ul>

					<div class="actions">
						<a href="/admin/imports" class="ghost">Cancel</a>
						<button type="submit" class="primary">Import selected</button>
					</div>
				</form>
			</section>
		{/if}

		{#if data.preview.alreadyImported.length > 0}
			<section class="card">
				<div class="row">
					<h2>Already on file</h2>
					<form method="POST" action="?/refreshYears">
						<button type="submit" class="ghost">Refresh birth years</button>
					</form>
				</div>
				<p class="muted">
					Fills in the birth year on any existing birthday whose year we missed before.
				</p>
				<ul class="existing">
					{#each data.preview.alreadyImported as entry (entry.contact.resource_name)}
						<li>
							<a href="/admin/people/{entry.person.id}">
								{entry.person.display_name}
							</a>
							<span class="bd">· {birthdayLabel(entry.contact.birthday)}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>

<style>
	.contacts-import {
		max-width: 720px;
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
		padding: 24px;
		margin-bottom: 14px;
	}

	h2 {
		font-size: 22px;
		margin-bottom: 10px;
	}

	.body {
		font-size: 16px;
		color: var(--ink);
	}

	.body.error {
		color: var(--rose);
	}

	.body.muted {
		color: var(--muted);
	}

	.muted {
		color: var(--muted);
		font-size: 14px;
	}

	.flash {
		padding: 14px 18px;
		border-radius: var(--radius-control);
		margin-bottom: 14px;
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 500;
	}

	.flash.ok {
		background: var(--green-soft);
		color: var(--green);
		border: 1px solid var(--green);
	}

	.flash.err {
		background: #fde9e6;
		color: var(--rose);
		border: 1px solid var(--rose);
	}

	.stats .kv {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 14px;
	}

	.kv > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	dt {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted);
	}

	dd {
		font-family: var(--font-serif);
		font-size: 24px;
		color: var(--ink);
	}

	.row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 14px;
		margin-bottom: 14px;
	}

	.select-all {
		display: flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
		padding-bottom: 14px;
		border-bottom: 1px dashed var(--line);
		margin-bottom: 14px;
	}

	.contact-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 18px;
	}

	.contact-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 16px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		cursor: pointer;
	}

	.contact-row input[type='checkbox'] {
		width: 20px;
		height: 20px;
		accent-color: var(--green);
	}

	.contact-row .meta {
		flex: 1;
	}

	.name {
		font-family: var(--font-serif);
		font-size: 19px;
		color: var(--ink);
	}

	.bd {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.email {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.actions {
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
		padding: 10px 20px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
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

	.existing {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.existing li {
		font-family: var(--font-sans);
		font-size: 15px;
	}
</style>
