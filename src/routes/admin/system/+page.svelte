<script lang="ts">
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '—';
		const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
		const d = new Date(normalized);
		if (isNaN(d.getTime())) return iso;
		return d.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	function formatDuration(startIso: string, endIso: string | null): string {
		if (!endIso) return '(running)';
		const start = Date.parse(startIso.replace(' ', 'T') + 'Z');
		const end = Date.parse(endIso.replace(' ', 'T') + 'Z');
		const ms = end - start;
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.round(ms / 1000)}s`;
	}

	function statusClass(s: string): string {
		return s === 'ok' ? 'ok' : s === 'error' ? 'err' : 'warn';
	}
</script>

<svelte:head>
	<title>System — Admin — Gift Tracker</title>
</svelte:head>

<main class="system">
	<header class="page-header">
		<p class="crumbs"><a href="/admin">Home</a> / System</p>
		<h1>System &amp; jobs</h1>
		<p class="subtitle">Backup status, reminder job history, and manual triggers.</p>
	</header>

	{#if form?.error}
		<div class="flash err" role="alert">{form.error}</div>
	{:else if form?.ok}
		<div class="flash ok" role="status">{form.summary}</div>
	{/if}

	<section class="card">
		<p class="eyebrow">Database backup</p>
		<div class="row">
			<div>
				<p class="body">
					{#if data.backup.lastAt}
						Last snapshot at <strong>{formatTimestamp(data.backup.lastAt)}</strong>.
					{:else}
						No snapshot at <code>{data.backup.path}</code> yet.
					{/if}
				</p>
				<p class="muted">
					A nightly cron runs SQLite's online backup API to produce a consistent
					snapshot without pausing writes.
				</p>
				{#if data.backup.lastRun?.error_message}
					<p class="err-line">{data.backup.lastRun.error_message}</p>
				{/if}
			</div>
			<form method="POST" action="?/runBackupNow">
				<button type="submit" class="primary">Run backup now</button>
			</form>
		</div>
	</section>

	<section class="card">
		<p class="eyebrow">Reminder digest</p>
		<div class="row">
			<div>
				<p class="body">
					{#if data.reminderJob.lastRun}
						Last run: {formatTimestamp(data.reminderJob.lastRun.started_at)}
						· <strong class={statusClass(data.reminderJob.lastRun.status)}>
							{data.reminderJob.lastRun.status}
						</strong>
					{:else}
						Never run yet.
					{/if}
				</p>
				<p class="muted">
					Channels:
					{#if data.reminderJob.channels.email}
						Email configured
					{:else}
						Email —
					{/if}
					·
					{#if data.reminderJob.channels.telegram}
						Telegram configured
					{:else}
						Telegram —
					{/if}
				</p>
				{#if data.reminderJob.lastRun?.summary}
					<p class="muted">{data.reminderJob.lastRun.summary}</p>
				{/if}
				{#if data.reminderJob.lastRun?.error_message}
					<p class="err-line">{data.reminderJob.lastRun.error_message}</p>
				{/if}
			</div>
			<form method="POST" action="?/runReminderNow">
				<button type="submit" class="primary">Run reminders now</button>
			</form>
		</div>
	</section>

	<section class="card">
		<p class="eyebrow">Christmas planning kickoff</p>
		<div class="row">
			<div>
				<p class="body">
					Fires Sept 1 each year. A focused heads-up — not folded into the daily digest —
					so gift planning starts before shopping does.
				</p>
				{#if data.christmasJob.lastRun}
					<p class="muted">
						Last run: {formatTimestamp(data.christmasJob.lastRun.started_at)}
						· <strong class={statusClass(data.christmasJob.lastRun.status)}>
							{data.christmasJob.lastRun.status}
						</strong>
					</p>
					{#if data.christmasJob.lastRun.summary}
						<p class="muted">{data.christmasJob.lastRun.summary}</p>
					{/if}
				{:else}
					<p class="muted">Never run yet.</p>
				{/if}
			</div>
			<form method="POST" action="?/runChristmasKickoffNow">
				<button type="submit" class="primary">Run kickoff now</button>
			</form>
		</div>
	</section>

	<section class="card">
		<p class="eyebrow">Recent job runs</p>
		{#if data.recentRuns.length === 0}
			<p class="muted">No jobs have run yet.</p>
		{:else}
			<table class="runs">
				<thead>
					<tr>
						<th>Started</th>
						<th>Job</th>
						<th>Status</th>
						<th>Duration</th>
						<th>Summary</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentRuns as r (r.id)}
						<tr>
							<td>{formatTimestamp(r.started_at)}</td>
							<td class="mono">{r.job_name}</td>
							<td class={statusClass(r.status)}>{r.status}</td>
							<td>{formatDuration(r.started_at, r.finished_at)}</td>
							<td class="summary">
								{r.summary ?? r.error_message ?? ''}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</main>

<style>
	.system {
		max-width: 800px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 18px;
	}

	.crumbs {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.crumbs a {
		color: var(--muted);
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

	h1 {
		margin-top: 6px;
		font-size: 30px;
	}

	.subtitle {
		margin-top: 8px;
		font-family: var(--font-sans);
		font-size: 16px;
		color: var(--muted);
	}

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 22px;
		margin-bottom: 12px;
	}

	.row {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 14px;
		flex-wrap: wrap;
	}

	.body {
		font-size: 16px;
		color: var(--ink);
	}

	.muted {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
		margin-top: 4px;
	}

	.err-line {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 12px;
		color: var(--rose);
		margin-top: 4px;
	}

	code {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
		background: var(--bg);
		padding: 2px 6px;
		border-radius: 4px;
	}

	.flash {
		padding: 14px 18px;
		border-radius: var(--radius-control);
		margin-bottom: 14px;
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 500;
	}

	.flash.ok {
		background: var(--green-soft);
		color: var(--green);
		border: 1px solid var(--green);
	}

	.flash.err {
		background: #fde9e6;
		color: var(--rose);
		border: 1px solid var(--rose);
	}

	.primary {
		min-height: var(--tap-target);
		padding: 10px 18px;
		background: var(--green);
		color: var(--paper);
		border: 1px solid var(--green);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
	}

	.runs {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--font-sans);
		font-size: 13px;
	}

	.runs th {
		text-align: left;
		padding: 8px 10px;
		border-bottom: 1px solid var(--line);
		color: var(--muted);
		text-transform: uppercase;
		font-size: 11px;
		letter-spacing: 0.05em;
	}

	.runs td {
		padding: 8px 10px;
		border-bottom: 1px solid var(--line);
		color: var(--ink);
	}

	.runs td.mono,
	.runs td.summary {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 12px;
	}

	.runs td.summary {
		color: var(--muted);
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ok {
		color: var(--green);
	}

	.warn {
		color: var(--amber);
	}

	.err {
		color: var(--rose);
	}

	strong.ok,
	strong.err,
	strong.warn {
		text-transform: uppercase;
		font-size: 12px;
		letter-spacing: 0.04em;
	}
</style>
