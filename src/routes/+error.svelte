<script lang="ts">
	import { page } from '$app/stores';

	const status = $derived($page.status);
	const message = $derived($page.error?.message ?? '');

	const title = $derived.by(() => {
		if (status === 404) return 'Not found';
		if (status === 403) return 'Not allowed';
		if (status === 401) return 'Sign in';
		if (status >= 500) return 'Something went wrong';
		return 'Trouble here';
	});

	const explanation = $derived.by(() => {
		if (status === 404) return "That page doesn't exist — maybe a stale link or a typo.";
		if (status === 403) return "You're signed in, but this page isn't available for your role.";
		if (status === 401) return 'Sign in to continue.';
		if (status >= 500) return 'The server hit an unexpected error. Try again in a moment.';
		return 'Try the action again, or head back home.';
	});
</script>

<svelte:head>
	<title>{title} — Gift Tracker</title>
</svelte:head>

<main class="error-page">
	<div class="card">
		<p class="status">{status}</p>
		<h1>{title}</h1>
		<p class="explanation">{explanation}</p>

		{#if message && message !== title}
			<p class="detail">{message}</p>
		{/if}

		<div class="actions">
			{#if status === 401}
				<a href="/login" class="primary">Sign in</a>
			{:else}
				<a href="/" class="primary">Back to home</a>
			{/if}
		</div>
	</div>
</main>

<style>
	.error-page {
		min-height: 70vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px 18px;
	}

	.card {
		max-width: 460px;
		width: 100%;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 32px 28px;
		text-align: center;
	}

	.status {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin-bottom: 8px;
	}

	h1 {
		font-family: var(--font-serif);
		font-size: 28px;
		color: var(--ink);
	}

	.explanation {
		margin-top: 12px;
		font-family: var(--font-sans);
		font-size: 16px;
		color: var(--muted);
	}

	.detail {
		margin-top: 12px;
		padding: 12px 14px;
		background: var(--bg);
		border-radius: var(--radius-control);
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
		color: var(--ink);
		text-align: left;
	}

	.actions {
		margin-top: 20px;
	}

	.primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 10px 24px;
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
