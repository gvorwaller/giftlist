<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<main class="placeholder">
	<div class="card">
		<p class="eyebrow">Phase 0 scaffold</p>
		<h1>Gift Tracker</h1>
		<p class="body">
			Schema at version <strong>{data.schemaVersion}</strong>. Auth and flows arrive in Phase 1.
		</p>
	</div>
</main>

<style>
	.placeholder {
		max-width: 430px;
		margin: 0 auto;
		padding: 32px 18px 96px;
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 24px;
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

	h1 {
		font-size: 31px;
		margin-bottom: 12px;
	}

	.body {
		font-size: 17px;
		color: var(--ink);
	}

	strong {
		color: var(--green);
	}
</style>
