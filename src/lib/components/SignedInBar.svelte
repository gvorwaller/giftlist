<script lang="ts">
	interface Props {
		displayName: string;
	}

	let { displayName }: Props = $props();
</script>

<div class="signed-in-bar">
	<span class="who">Signed in as <strong>{displayName}</strong></span>
	<form method="POST" action="/api/logout">
		<button type="submit" class="signout">Sign out</button>
	</form>
</div>

<style>
	.signed-in-bar {
		position: fixed;
		left: 0;
		right: 0;
		/* Sits directly above the BottomNav (which is bottom: 0). BottomNav height
		   is variable due to safe-area-inset; we use a calc that approximates it. */
		bottom: calc(var(--tap-target) + 16px + env(safe-area-inset-bottom));
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-4);
		background: rgba(255, 253, 248, 0.96);
		backdrop-filter: blur(10px);
		border-top: 1px solid var(--line);
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
		z-index: 19;
	}

	.who strong {
		color: var(--ink);
		font-weight: 600;
	}

	.signout {
		min-height: var(--tap-target);
		padding: 0 var(--space-3);
		background: transparent;
		border: none;
		color: var(--green);
		font-family: var(--font-sans);
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		border-radius: var(--radius-control);
	}

	.signout:hover,
	.signout:focus-visible {
		background: var(--green-soft);
		outline: none;
	}
</style>
