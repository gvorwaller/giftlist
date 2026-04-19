<script lang="ts">
	import type { PageData } from './$types';
	import BottomNav from '$components/BottomNav.svelte';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<svelte:head>
	<title>Today — Gift Tracker</title>
</svelte:head>

<main class="today">
	<header class="page-header">
		<p class="date">Today</p>
		<h1>Hi, {data.user.display_name}</h1>
		<p class="subtitle">Everything that matters right now is handled.</p>
	</header>

	<div class="card">
		<p class="eyebrow">Phase 1 scaffold</p>
		<p>
			You're signed in as <strong>{data.user.role}</strong>. The Today screen fills in during Phase 3.
		</p>
		<form method="POST" action="/api/logout">
			<button type="submit" class="secondary">Sign out</button>
		</form>
	</div>
</main>

<BottomNav role={data.user.role} />

<style>
	.today {
		max-width: 430px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 22px;
	}

	.date {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}

	h1 {
		margin-top: 6px;
		font-size: 31px;
		line-height: 1.05;
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
		margin-top: 8px;
	}

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
		margin-bottom: 10px;
	}

	.card p {
		font-size: 17px;
		color: var(--ink);
	}

	strong {
		color: var(--green);
		text-transform: capitalize;
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
