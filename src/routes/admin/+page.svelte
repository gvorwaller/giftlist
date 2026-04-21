<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '—';
		const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
		const d = new Date(normalized);
		if (isNaN(d.getTime())) return iso;
		const diffMinutes = (Date.now() - d.getTime()) / 60_000;
		if (diffMinutes < 60) return `${Math.round(diffMinutes)}m ago`;
		if (diffMinutes < 60 * 24) return `${Math.round(diffMinutes / 60)}h ago`;
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}

	function healthColor(h: 'healthy' | 'warning' | 'error' | 'unknown'): string {
		return h === 'error' ? 'err' : h === 'warning' ? 'warn' : h === 'healthy' ? 'ok' : 'muted';
	}

	function ageDays(iso: string | null): number | null {
		if (!iso) return null;
		const n = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
		const d = new Date(n);
		if (isNaN(d.getTime())) return null;
		return (Date.now() - d.getTime()) / 86_400_000;
	}
</script>

<svelte:head>
	<title>Admin — Gift Tracker</title>
</svelte:head>

<main class="admin-home">
	<header class="page-header">
		<p class="eyebrow">Admin</p>
		<h1>Home</h1>
		<p class="subtitle">Control center for the household. Manager view is <a href="/app/today">over here</a>.</p>
	</header>

	{#if data.home.priorityAction}
		{@const p = data.home.priorityAction}
		<section class="card priority">
			<p class="eyebrow amber">Priority action</p>
			<h2>{p.title}</h2>
			<p class="body">{p.body}</p>
			<a href={p.href} class="primary">Fix now</a>
		</section>
	{:else}
		<section class="card calm">
			<p class="eyebrow ok">All clear</p>
			<p class="body">Nothing urgent today — the system and the household are both quiet.</p>
		</section>
	{/if}

	<section class="card">
		<p class="eyebrow">System snapshot</p>
		<div class="metric-grid">
			<div class="metric">
				<dt>Upcoming needing gifts</dt>
				<dd class:alert={data.home.snapshot.upcomingNeedingGifts > 0}>
					{data.home.snapshot.upcomingNeedingGifts}
				</dd>
			</div>
			<div class="metric">
				<dt>Incomplete people</dt>
				<dd class:alert={data.home.snapshot.incompletePeople > 0}>
					{data.home.snapshot.incompletePeople}
				</dd>
			</div>
			<div class="metric">
				<dt>Stale drafts</dt>
				<dd class:alert={data.home.snapshot.staleDrafts > 0}>{data.home.snapshot.staleDrafts}</dd>
			</div>
			<div class="metric">
				<dt>Failed jobs (24h)</dt>
				<dd class:alert={data.home.snapshot.failedJobs24h > 0}>
					{data.home.snapshot.failedJobs24h}
				</dd>
			</div>
			<div class="metric">
				<dt>Last backup</dt>
				<dd>{formatTimestamp(data.home.snapshot.lastBackupAt)}</dd>
			</div>
			<div class="metric">
				<dt>Last reminder</dt>
				<dd>{formatTimestamp(data.home.snapshot.lastReminderAt)}</dd>
			</div>
		</div>
	</section>

	{#if data.home.needsReview.incompletePeople.length > 0 || data.home.needsReview.staleDrafts.length > 0}
		<section class="card">
			<p class="eyebrow">Needs review</p>

			{#if data.home.needsReview.incompletePeople.length > 0}
				<h3>People with no occasions</h3>
				<ul class="review-list">
					{#each data.home.needsReview.incompletePeople as p (p.id)}
						<li>
							<a href="/admin/people/{p.id}">{p.display_name}</a>
							{#if p.full_name && p.full_name !== p.display_name}
								<span class="meta">· {p.full_name}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if data.home.needsReview.staleDrafts.length > 0}
				<h3>Stale drafts ({data.home.needsReview.staleDrafts.length})</h3>
				<ul class="review-list">
					{#each data.home.needsReview.staleDrafts as d (d.id)}
						<li>
							{d.draft_type} · {d.owner_username}
							<span class="meta">
								· started {formatTimestamp(d.created_at)}
								{#if ageDays(d.created_at)}
									({Math.round(ageDays(d.created_at) ?? 0)} days old)
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	<section class="card">
		<p class="eyebrow">Manager context</p>
		{#if data.home.managerContext.manager}
			{@const m = data.home.managerContext.manager}
			<dl class="kv">
				<div>
					<dt>Account</dt>
					<dd>{m.display_name} ({m.username})</dd>
				</div>
				<div>
					<dt>Last signed in</dt>
					<dd>{formatTimestamp(m.last_login_at)}</dd>
				</div>
				<div>
					<dt>Last seen</dt>
					<dd>
						{formatTimestamp(m.last_seen_at)}
						{#if m.last_seen_path}
							<span class="meta">· {m.last_seen_path}</span>
						{/if}
					</dd>
				</div>
			</dl>
			{#if data.home.managerContext.anomalies.length > 0}
				<ul class="anomalies">
					{#each data.home.managerContext.anomalies as a (a)}
						<li>{a}</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="body muted">No manager account on file.</p>
		{/if}
	</section>

	<section class="card">
		<p class="eyebrow">Operations</p>
		<ul class="ops-list">
			<li>
				<span class="dot {healthColor(data.home.operations.backup.health)}" aria-hidden="true"></span>
				<div>
					<p class="op-title">Database backup</p>
					<p class="meta">{data.home.operations.backup.detail}</p>
				</div>
			</li>
			<li>
				<span class="dot {healthColor(data.home.operations.reminder.health)}" aria-hidden="true"></span>
				<div>
					<p class="op-title">Reminder job</p>
					<p class="meta">{data.home.operations.reminder.detail}</p>
					<p class="meta">
						Channels:
						{#if data.home.operations.reminder.channelsConfigured.email}
							Email ✓
						{:else}
							Email —
						{/if}
						·
						{#if data.home.operations.reminder.channelsConfigured.telegram}
							Telegram ✓
						{:else}
							Telegram —
						{/if}
					</p>
				</div>
			</li>
		</ul>
	</section>

	<section class="card quick">
		<p class="eyebrow">Quick actions</p>
		<div class="action-grid">
			<a href="/admin/people" class="quick-btn">People</a>
			<a href="/admin/imports" class="quick-btn">Imports</a>
			<a href="/admin/settings" class="quick-btn">Settings</a>
			<a href="/admin/system" class="quick-btn">System &amp; jobs</a>
		</div>
	</section>
</main>

<style>
	.admin-home {
		max-width: 720px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header {
		padding: 6px 0 18px;
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

	.eyebrow.amber {
		color: var(--amber);
	}

	.eyebrow.ok {
		color: var(--green);
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

	.card.priority {
		background: linear-gradient(135deg, #fff2df 0%, #fffdf8 60%);
		border-color: var(--amber);
	}

	.card.calm {
		background: linear-gradient(135deg, #eef3ec 0%, #fffdf8 60%);
		border-color: var(--green-soft);
	}

	h2 {
		font-size: 24px;
		line-height: 1.2;
		margin-bottom: 8px;
	}

	h3 {
		font-family: var(--font-serif);
		font-size: 18px;
		margin-top: 12px;
		margin-bottom: 8px;
	}

	.body {
		font-size: 16px;
		color: var(--ink);
		margin-bottom: 14px;
	}

	.body.muted {
		color: var(--muted);
	}

	.primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 10px 20px;
		background: var(--green);
		color: var(--paper);
		border: 1px solid var(--green);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		text-decoration: none;
	}

	.metric-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 14px;
	}

	.metric {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
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
		font-family: var(--font-serif);
		font-size: 26px;
		color: var(--ink);
	}

	dd.alert {
		color: var(--amber);
	}

	@media (min-width: 640px) {
		.metric-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}

	.review-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}

	.review-list li {
		font-family: var(--font-sans);
		font-size: 15px;
	}

	.meta {
		font-size: 13px;
		color: var(--muted);
	}

	.kv {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 10px;
	}

	.kv > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.anomalies {
		list-style: none;
		padding: 10px 12px;
		background: var(--amber-soft);
		border: 1px solid var(--amber);
		border-radius: var(--radius-control);
		color: var(--amber);
		font-family: var(--font-sans);
		font-size: 14px;
	}

	.ops-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ops-list li {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		margin-top: 8px;
		flex-shrink: 0;
	}

	.dot.ok {
		background: var(--green);
	}

	.dot.warn {
		background: var(--amber);
	}

	.dot.err {
		background: var(--rose);
	}

	.dot.muted {
		background: var(--line);
	}

	.op-title {
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		color: var(--ink);
	}

	.action-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 10px;
	}

	.quick-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 14px 16px;
		background: var(--bg);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		text-decoration: none;
	}

	.quick-btn:hover {
		border-color: var(--green);
		color: var(--green);
	}
</style>
