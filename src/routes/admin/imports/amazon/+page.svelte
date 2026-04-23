<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	function formatTimestamp(iso: string | null | undefined): string {
		if (!iso) return '—';
		const n = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
		const d = new Date(n);
		if (isNaN(d.getTime())) return iso;
		const mins = (Date.now() - d.getTime()) / 60_000;
		if (mins < 60) return `${Math.round(mins)}m ago`;
		if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}
</script>

<svelte:head>
	<title>Amazon imports — Admin — Gift Tracker</title>
</svelte:head>

<main class="amazon-imports">
	<header class="page-header">
		<p class="crumbs"><a href="/admin/imports">Imports</a> / Amazon</p>
		<h1>Amazon email scan</h1>
		<p class="subtitle">
			Pulls messages from <code>Giftlist/Amazon/Inbox</code>, parses order confirmations /
			shipment / delivery emails, stages them for your review, then moves processed
			messages to <code>Giftlist/Amazon/Processed</code>.
		</p>
	</header>

	{#if form?.error}
		<div class="flash err" role="alert">{form.error}</div>
	{/if}

	{#if !data.connected}
		<section class="card">
			<h2>Connect Google first</h2>
			<p class="body">
				The Amazon import reads from the Google account connected in
				<a href="/admin/settings">Settings</a>. Connect one there, then come back.
			</p>
		</section>
	{:else if !data.scopeOk}
		<section class="card warn">
			<h2>Reconnect needed — new Gmail permission</h2>
			<p class="body">
				The OAuth scope expanded from read-only Gmail to <code>gmail.modify</code> so the
				app can move processed messages between labels and trash old ones. Your current
				connection only grants read access.
			</p>
			<p class="body">
				Go to <a href="/admin/settings">Settings</a> and click <strong>Re-connect</strong> on the
				Google account card. Google will show the updated permissions on its consent screen.
			</p>
		</section>
	{:else}
		<section class="card">
			<div class="row">
				<div>
					<p class="eyebrow">Connected</p>
					<p class="body">
						Using <strong>{data.accountEmail ?? '(unknown)'}</strong>.
					</p>
				</div>
				<form method="POST" action="?/scan">
					<button type="submit" class="primary">Scan now</button>
				</form>
			</div>
			<p class="muted">
				Scans up to 200 messages per run. Scan is idempotent — re-running only parses new
				messages. Gifts aren't created until you review the staged rows.
			</p>
		</section>

		{#if data.latestRun}
			<section class="card">
				<p class="eyebrow">Latest run</p>
				<dl class="kv">
					<div><dt>Status</dt><dd class={data.latestRun.status}>{data.latestRun.status}</dd></div>
					<div><dt>Started</dt><dd>{formatTimestamp(data.latestRun.started_at)}</dd></div>
					<div><dt>Finished</dt><dd>{formatTimestamp(data.latestRun.finished_at)}</dd></div>
					<div><dt>Fetched</dt><dd>{data.latestRun.fetched_count}</dd></div>
					<div><dt>Parsed</dt><dd>{data.latestRun.parsed_count}</dd></div>
					<div><dt>Pending review</dt><dd class:alert={data.pendingCount > 0}>{data.pendingCount}</dd></div>
				</dl>
				{#if data.latestRun.error_message}
					<p class="err-line">{data.latestRun.error_message}</p>
				{/if}
				<div class="actions">
					<a href="/admin/imports/amazon/review?run={data.latestRun.id}" class="secondary">
						{data.pendingCount > 0 ? `Review ${data.pendingCount} pending` : 'Open review'}
					</a>
				</div>
			</section>
		{/if}
	{/if}
</main>

<style>
	.amazon-imports {
		max-width: 720px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header { padding: 6px 0 18px; }
	.crumbs { font-family: var(--font-sans); font-size: 14px; color: var(--muted); }
	.crumbs a { color: var(--muted); }

	h1 { margin-top: 6px; font-size: 30px; }
	h2 { font-size: 22px; margin-bottom: 8px; }
	.subtitle, .body { font-size: 16px; color: var(--ink); margin-top: 8px; }
	.muted { font-family: var(--font-sans); font-size: 13px; color: var(--muted); margin-top: 10px; }

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 22px;
		margin-bottom: 12px;
	}
	.card.warn { background: var(--amber-soft); border-color: var(--amber); }

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		flex-wrap: wrap;
	}

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
		margin-bottom: 6px;
	}

	.flash {
		padding: 14px 18px;
		border-radius: var(--radius-control);
		margin-bottom: 14px;
		font-family: var(--font-sans);
		font-size: 15px;
	}
	.flash.err { background: #fde9e6; color: var(--rose); border: 1px solid var(--rose); }

	code {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
		background: var(--bg);
		padding: 2px 6px;
		border-radius: 4px;
	}

	.primary, .secondary {
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
	.primary { background: var(--green); color: var(--paper); border-color: var(--green); }
	.secondary { background: transparent; color: var(--green); border-color: var(--green); }

	.kv { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
	.kv > div { display: flex; flex-direction: column; gap: 2px; }
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
		font-size: 20px;
		color: var(--ink);
	}
	dd.alert { color: var(--amber); }
	dd.ready_for_review { color: var(--amber); }
	dd.committed { color: var(--green); }
	dd.error { color: var(--rose); }

	.err-line { color: var(--rose); font-size: 14px; margin-top: 8px; }
	.actions { margin-top: 14px; }
</style>
