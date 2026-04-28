<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	let confirmingDisconnect = $state(false);

	function scopeLabel(scope: string): string {
		const names = scope
			.split(/\s+/)
			.filter(Boolean)
			.map((s) => {
				if (s.endsWith('/contacts.readonly')) return 'Contacts (read)';
				if (s.endsWith('/gmail.readonly')) return 'Gmail (read)';
				if (s.endsWith('/userinfo.email')) return 'Account email';
				if (s === 'openid') return 'Identity';
				return s;
			});
		return names.join(' · ');
	}
</script>

<svelte:head>
	<title>Settings — Admin — Gift Tracker</title>
</svelte:head>

<main class="settings">
	<header class="page-header">
		<p class="eyebrow">Admin</p>
		<h1>Settings</h1>
		<p class="subtitle">Integrations and notification config.</p>
	</header>

	{#if data.flash.connected}
		<div class="flash flash-ok" role="status">Google account connected.</div>
	{:else if data.flash.disconnected}
		<div class="flash flash-ok" role="status">Google account disconnected.</div>
	{:else if data.flash.error}
		<div class="flash flash-err" role="alert">Google connect failed: {data.flash.error}</div>
	{/if}

	<section class="card">
		<div class="row">
			<div>
				<h2>Google account</h2>
				<p class="muted">Needed for Contacts import (Phase 2c) and Amazon email parsing (Phase 4).</p>
			</div>
		</div>

		{#if data.googleConnection.connected}
			<dl class="kv">
				<div>
					<dt>Connected as</dt>
					<dd>{data.googleConnection.account_email ?? '(email unavailable)'}</dd>
				</div>
				<div>
					<dt>Scopes</dt>
					<dd>{scopeLabel(data.googleConnection.scope)}</dd>
				</div>
				<div>
					<dt>Refresh token</dt>
					<dd>
						{data.googleConnection.has_refresh_token
							? 'Stored (encrypted at rest)'
							: 'Missing — reconnect to re-grant offline access'}
					</dd>
				</div>
			</dl>
			{#if confirmingDisconnect}
				<p class="confirm-prompt">
					Disconnect Google? Contacts import and Amazon scans will stop working until you re-connect.
				</p>
				<div class="actions confirm-row">
					<button
						type="button"
						class="ghost"
						onclick={() => {
							confirmingDisconnect = false;
						}}
					>
						Cancel
					</button>
					<form method="POST" action="/admin/settings/google/disconnect">
						<button type="submit" class="ghost danger">Yes, disconnect</button>
					</form>
				</div>
			{:else}
				<div class="actions">
					<a href="/admin/settings/google/connect" class="ghost">Re-connect</a>
					<button
						type="button"
						class="ghost danger"
						onclick={() => {
							confirmingDisconnect = true;
						}}
					>
						Disconnect
					</button>
				</div>
			{/if}
		{:else}
			<p class="body">Not connected yet.</p>
			<div class="actions">
				<a class="primary" href="/admin/settings/google/connect">Connect Google account</a>
			</div>
		{/if}
	</section>

	<section class="card">
		<div class="row">
			<div>
				<h2>Notifications</h2>
				<p class="muted">Daily reminder digest. Configure via <code>.env</code> for now.</p>
			</div>
			<a href="/admin/system" class="ghost">Run now or view history</a>
		</div>

		<dl class="kv">
			<div>
				<dt>Reminder lead time</dt>
				<dd>{data.notificationConfig.leadDays} days</dd>
			</div>
			<div>
				<dt>Email channel</dt>
				<dd>
					{#if data.notificationConfig.channels.email}
						Configured → <span class="mono">{data.notificationConfig.emailTo}</span>
					{:else}
						Not configured. Set <code>SMTP_HOST</code>, <code>SMTP_FROM</code>, <code>SMTP_TO</code> (and optional <code>SMTP_PORT</code>/<code>SMTP_USER</code>/<code>SMTP_PASS</code>/<code>SMTP_SECURE</code>).
					{/if}
				</dd>
			</div>
			<div>
				<dt>Telegram channel</dt>
				<dd>
					{#if data.notificationConfig.channels.telegram}
						Configured → chat <span class="mono">{data.notificationConfig.telegramChatMasked}</span>
					{:else}
						Not configured. Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code>.
					{/if}
				</dd>
			</div>
		</dl>
	</section>
</main>

<style>
	.settings {
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
		margin-bottom: 8px;
	}

	.muted {
		color: var(--muted);
		font-size: 15px;
		margin-bottom: 14px;
	}

	.row {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
	}

	.body {
		font-size: 17px;
		color: var(--ink);
		margin-bottom: 14px;
	}

	.flash {
		padding: 14px 18px;
		border-radius: var(--radius-control);
		margin-bottom: 14px;
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 500;
	}

	.flash-ok {
		background: var(--green-soft);
		color: var(--green);
		border: 1px solid var(--green);
	}

	.flash-err {
		background: #fde9e6;
		color: var(--rose);
		border: 1px solid var(--rose);
	}

	.kv {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 20px;
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
		font-family: var(--font-sans);
		font-size: 16px;
		color: var(--ink);
	}

	code {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
		background: var(--bg);
		padding: 2px 6px;
		border-radius: 4px;
	}

	.mono {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
		color: var(--green);
	}

	.actions {
		display: flex;
		gap: 10px;
		align-items: center;
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

	.ghost.danger {
		color: var(--rose);
		border-color: var(--rose);
	}

	form {
		display: inline;
	}

	.confirm-prompt {
		font-size: 16px;
		color: var(--ink);
		background: var(--amber-soft);
		border: 1px solid var(--amber);
		border-radius: var(--radius-control);
		padding: 14px 16px;
		margin-bottom: 14px;
	}

	.confirm-row {
		gap: 10px;
	}
</style>
