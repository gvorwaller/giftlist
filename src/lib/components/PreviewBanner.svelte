<script lang="ts">
	interface Props {
		adminDisplayName: string;
	}

	let { adminDisplayName }: Props = $props();
</script>

<div class="preview-banner" role="status">
	<span class="label">
		<span class="dot" aria-hidden="true"></span>
		Previewing manager view
		{#if adminDisplayName}
			<span class="who">· signed in as {adminDisplayName}</span>
		{/if}
	</span>
	<form method="POST" action="/api/preview/stop">
		<button type="submit" class="exit">Back to Admin</button>
	</form>
</div>

<style>
	.preview-banner {
		position: fixed;
		left: 0;
		right: 0;
		top: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 8px 14px;
		background: var(--amber-soft, #fff2df);
		border-bottom: 1px solid var(--amber, #bd7a2a);
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--ink);
		z-index: 30;
	}

	.label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--amber, #bd7a2a);
	}

	.who {
		color: var(--muted);
		font-weight: 500;
	}

	.exit {
		min-height: 36px;
		padding: 6px 14px;
		background: var(--paper, #fffdf8);
		color: var(--green, #2f5d50);
		border: 1px solid var(--green, #2f5d50);
		border-radius: var(--radius-control, 14px);
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
	}

	.exit:hover,
	.exit:focus-visible {
		background: var(--green-soft, #e6efe9);
		outline: none;
	}
</style>
