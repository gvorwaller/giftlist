<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<svelte:head>
	<title>Imports — Admin — Gift Tracker</title>
</svelte:head>

<main class="imports">
	<header class="page-header">
		<p class="eyebrow">Admin</p>
		<h1>Imports</h1>
		<p class="subtitle">Pull people and gifts from external sources.</p>
	</header>

	<section class="card">
		<div class="row">
			<div>
				<h2>Google Contacts</h2>
				<p class="body">
					{#if data.googleConnected}
						Using <strong>{data.googleEmail ?? 'your Google account'}</strong>. Pulls contacts
						with a birthday date.
					{:else}
						Connect a Google account in <a href="/admin/settings">Settings</a> first.
					{/if}
				</p>
			</div>
		</div>
		{#if data.googleConnected}
			<a class="primary" href="/admin/imports/contacts">Review contacts</a>
		{/if}
	</section>

	<section class="card">
		<h2>Amazon email parsing</h2>
		<p class="body">
			Scan a Gmail label for Amazon order confirmations, shipping notifications, and delivery
			receipts; match recipients against people on file. Phase 4.
		</p>
	</section>
</main>

<style>
	.imports {
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

	strong {
		color: var(--green);
	}

	.row {
		margin-bottom: 14px;
	}

	.primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 10px 20px;
		background: var(--green);
		color: var(--paper);
		border: 1px solid var(--green);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		text-decoration: none;
	}
</style>
