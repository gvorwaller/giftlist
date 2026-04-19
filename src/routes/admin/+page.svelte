<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<svelte:head>
	<title>Admin — Gift Tracker</title>
</svelte:head>

<main class="admin-home">
	<header class="page-header">
		<p class="eyebrow">Admin</p>
		<h1>Home</h1>
		<p class="subtitle">Control center. Phase 5 fills in Priority Action, System Snapshot, etc.</p>
	</header>

	<div class="card">
		<p>
			Signed in as <strong>{data.user.display_name}</strong> ({data.user.role}).
		</p>
		<form method="POST" action="/api/logout">
			<button type="submit" class="secondary">Sign out</button>
		</form>
	</div>
</main>

<style>
	.admin-home {
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
	}

	.card p {
		font-size: 17px;
		color: var(--ink);
	}

	strong {
		color: var(--green);
	}

	form {
		margin-top: 18px;
	}

	button.secondary {
		min-height: var(--tap-target);
		padding: 10px 18px;
		background: transparent;
		color: var(--green);
		border: 1px solid var(--green);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		cursor: pointer;
	}
</style>
