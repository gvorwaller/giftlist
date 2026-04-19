<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	interface Props {
		form: ActionData;
		data: PageData;
	}

	let { form }: Props = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in — Gift Tracker</title>
</svelte:head>

<main class="login">
	<div class="card">
		<h1>Gift Tracker</h1>
		<p class="subtitle">Sign in to continue.</p>

		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			novalidate
		>
			<label>
				<span>Username</span>
				<input
					type="text"
					name="username"
					autocomplete="username"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					required
					value={form?.username ?? ''}
				/>
			</label>

			<label>
				<span>Password</span>
				<input type="password" name="password" autocomplete="current-password" required />
			</label>

			{#if form?.error}
				<p class="error" role="alert">{form.error}</p>
			{/if}

			<button type="submit" class="primary" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	</div>
</main>

<style>
	.login {
		max-width: 430px;
		margin: 0 auto;
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 24px 18px;
	}

	.card {
		width: 100%;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 32px 24px;
	}

	h1 {
		font-size: 31px;
		margin-bottom: 6px;
	}

	.subtitle {
		font-size: 16px;
		color: var(--muted);
		margin-bottom: 28px;
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
		color: var(--muted);
		letter-spacing: 0.03em;
	}

	input {
		min-height: var(--tap-target);
		padding: 12px 14px;
		font-size: 18px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	input:focus {
		background: var(--paper);
	}

	.error {
		color: var(--rose);
		font-size: 15px;
		margin: -6px 0 0;
	}

	button.primary {
		margin-top: 10px;
		min-height: var(--tap-target);
		background: var(--green);
		color: var(--paper);
		border: none;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 17px;
		font-weight: 600;
		cursor: pointer;
	}

	button.primary:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
