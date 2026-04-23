<script lang="ts">
	import { page } from '$app/stores';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	function priceDollars(cents: number | null): string {
		if (cents == null) return '';
		return `$${(cents / 100).toFixed(2)}`;
	}

	function parseCandidates(json: string | null): Array<{ personId: number; displayName: string; confidence: string; distance?: number }> {
		if (!json) return [];
		try {
			return JSON.parse(json);
		} catch {
			return [];
		}
	}

	function formatReceived(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso.replace(' ', 'T'));
		if (isNaN(d.getTime())) return iso;
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	const pending = $derived(data.rows.filter((r) => r.disposition === 'pending'));
	const handled = $derived(data.rows.filter((r) => r.disposition !== 'pending'));

	const flashGifts = $derived(Number($page.url.searchParams.get('gifts') ?? '0'));
	const flashSkipped = $derived(Number($page.url.searchParams.get('skipped') ?? '0'));
	const flashFailed = $derived(Number($page.url.searchParams.get('failed') ?? '0'));
	const flashMoveFails = $derived(Number($page.url.searchParams.get('move_failures') ?? '0'));
</script>

<svelte:head>
	<title>Review import — Admin — Gift Tracker</title>
</svelte:head>

<main class="review">
	<header class="page-header">
		<p class="crumbs">
			<a href="/admin/imports/amazon">Amazon import</a> / Review run {data.run.id}
		</p>
		<h1>Review {pending.length} pending</h1>
		<p class="subtitle">
			Fetched {data.run.fetched_count} · Parsed {data.run.parsed_count} · Status
			<strong>{data.run.status}</strong>
		</p>
	</header>

	{#if flashGifts + flashSkipped + flashFailed > 0}
		<div class="flash ok" role="status">
			{flashGifts > 0
				? `${flashGifts} gift${flashGifts === 1 ? '' : 's'} created · `
				: ''}{flashSkipped > 0 ? `${flashSkipped} skipped · ` : ''}{flashFailed > 0
				? `${flashFailed} failed`
				: ''}
			{#if flashMoveFails > 0}
				<br />{flashMoveFails} Gmail label moves failed (check logs).
			{/if}
		</div>
	{/if}

	{#if form?.error}
		<div class="flash err" role="alert">{form.error}</div>
	{/if}

	{#if pending.length === 0}
		<section class="card calm">
			<p class="body">Nothing pending for this run.</p>
			<a href="/admin/imports/amazon" class="secondary">Back to scan</a>
		</section>
	{:else}
		<form method="POST" action="?/commit" class="review-form">
			<input type="hidden" name="run_id" value={data.run.id} />
			<p class="muted bulk">
				Default action per row is <strong>accept with the matched person</strong>. Switch to
				<em>skip</em> to dispose of marketing/review emails; leave person blank to force a
				manual assignment.
			</p>

			<ul class="rows">
				{#each pending as r (r.id)}
					{@const candidates = parseCandidates(r.match_candidates_json)}
					<li class="row-card">
						<input type="hidden" name="row_id" value={r.id} />

						<div class="row-head">
							<div>
								<p class="subject">{r.subject ?? '(no subject)'}</p>
								<p class="meta">
									{r.email_type}
									{#if r.parsed_order_id}· order {r.parsed_order_id}{/if}
									· {formatReceived(r.received_at)}
								</p>
							</div>
							<div class="price">{priceDollars(r.parsed_price_cents)}</div>
						</div>

						{#if r.parsed_title}
							<p class="parsed"><span class="label">Item</span> {r.parsed_title}</p>
						{/if}
						{#if r.parsed_tracking_number || r.parsed_carrier}
							<p class="parsed">
								<span class="label">Tracking</span>
								{r.parsed_carrier ?? ''} {r.parsed_tracking_number ?? ''}
							</p>
						{/if}
						{#if r.parsed_recipient_name}
							<p class="parsed">
								<span class="label">To</span> {r.parsed_recipient_name}
								{#if r.parsed_shipping_address}
									<span class="addr">· {r.parsed_shipping_address}</span>
								{/if}
							</p>
						{/if}
						{#if r.parsed_gift_message}
							<p class="parsed gift-msg">
								<span class="label">Gift message</span> {r.parsed_gift_message}
							</p>
						{/if}

						<div class="choice-grid">
							<label class="radio">
								<input
									type="radio"
									name="disposition_{r.id}"
									value="accept"
									checked={r.email_type === 'order_placed' ||
										r.email_type === 'shipped' ||
										r.email_type === 'delivered'}
								/>
								<span>Accept → create / advance gift</span>
							</label>
							<label class="radio">
								<input
									type="radio"
									name="disposition_{r.id}"
									value="skip"
									checked={r.email_type === 'marketing' ||
										r.email_type === 'review_request' ||
										r.email_type === 'unknown'}
								/>
								<span>Skip</span>
							</label>

							<label class="person-select">
								<span class="label">Assign to</span>
								<select name="person_{r.id}">
									<option value="">— unassigned —</option>
									{#each data.people as p (p.id)}
										<option
											value={String(p.id)}
											selected={r.match_person_id === p.id}
										>
											{p.display_name}{#if p.full_name && p.full_name !== p.display_name} ({p.full_name}){/if}
										</option>
									{/each}
								</select>
								{#if r.match_person_id && r.match_confidence}
									<span class="hint">
										{r.match_confidence} match
										{#if candidates.length > 1}
											· {candidates.length} candidates
										{/if}
									</span>
								{/if}
							</label>

							{#if r.parsed_recipient_name && r.match_confidence !== 'exact'}
								<label class="alias">
									<input type="checkbox" name="alias_{r.id}" />
									<span>Remember "{r.parsed_recipient_name}" as an alias for this person</span>
								</label>
							{/if}
						</div>
					</li>
				{/each}
			</ul>

			<div class="actions">
				<button type="submit" class="primary">Commit selected</button>
				<button type="submit" formaction="?/skipAll" class="ghost">Skip all pending</button>
			</div>
		</form>
	{/if}

	{#if handled.length > 0}
		<section class="card">
			<p class="eyebrow">Already handled in this run ({handled.length})</p>
			<ul class="handled-list">
				{#each handled.slice(0, 20) as r (r.id)}
					<li class={r.disposition}>
						<span class="tag">{r.disposition}</span>
						{r.subject ?? '(no subject)'}
						{#if r.gift_id}
							· <a href="/app/gifts/{r.gift_id}">gift #{r.gift_id}</a>
						{/if}
						{#if r.error_message}
							<span class="err-line">· {r.error_message}</span>
						{/if}
					</li>
				{/each}
				{#if handled.length > 20}
					<li class="more">… and {handled.length - 20} more.</li>
				{/if}
			</ul>
		</section>
	{/if}
</main>

<style>
	.review {
		max-width: 960px;
		margin: 0 auto;
		padding: 20px 18px 120px;
	}

	.page-header { padding: 6px 0 18px; }
	.crumbs { font-family: var(--font-sans); font-size: 14px; color: var(--muted); }
	.crumbs a { color: var(--muted); }
	h1 { margin-top: 6px; font-size: 28px; }
	.subtitle {
		margin-top: 6px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--muted);
	}

	.flash {
		padding: 14px 18px;
		border-radius: var(--radius-control);
		margin-bottom: 14px;
		font-family: var(--font-sans);
		font-size: 15px;
	}
	.flash.ok { background: var(--green-soft); color: var(--green); border: 1px solid var(--green); }
	.flash.err { background: #fde9e6; color: var(--rose); border: 1px solid var(--rose); }

	.card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 20px;
		margin-bottom: 12px;
	}
	.card.calm { background: var(--green-soft); border-color: var(--green); }

	.muted.bulk {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: 12px 14px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
		margin-bottom: 12px;
	}

	.rows {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.row-card {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.row-head {
		display: flex;
		justify-content: space-between;
		gap: 14px;
	}

	.subject {
		font-family: var(--font-serif);
		font-size: 17px;
		line-height: 1.25;
	}

	.meta {
		margin-top: 2px;
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
		text-transform: capitalize;
	}

	.price {
		font-family: var(--font-sans);
		font-size: 17px;
		font-weight: 600;
		color: var(--green);
	}

	.parsed {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--ink);
	}
	.parsed .label {
		display: inline-block;
		width: 78px;
		text-transform: uppercase;
		font-size: 11px;
		letter-spacing: 0.05em;
		color: var(--muted);
		font-weight: 600;
	}
	.parsed .addr { color: var(--muted); }
	.parsed.gift-msg { background: var(--amber-soft); padding: 6px 10px; border-radius: 8px; }

	.choice-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
		margin-top: 6px;
		padding-top: 10px;
		border-top: 1px dashed var(--line);
	}

	.choice-grid .radio {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-sans);
		font-size: 14px;
	}

	.choice-grid .radio input[type='radio'] {
		width: 20px;
		height: 20px;
		accent-color: var(--green);
	}

	.choice-grid .person-select {
		grid-column: 1 / span 2;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.choice-grid .person-select .label {
		font-family: var(--font-sans);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.choice-grid select {
		min-height: 40px;
		padding: 8px 10px;
		font-family: var(--font-sans);
		font-size: 15px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.choice-grid .hint {
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
	}

	.choice-grid .alias {
		grid-column: 1 / span 2;
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.choice-grid .alias input[type='checkbox'] {
		width: 18px;
		height: 18px;
		accent-color: var(--green);
	}

	.actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
		margin-top: 16px;
		position: sticky;
		bottom: 96px;
		background: linear-gradient(180deg, transparent 0%, var(--bg) 50%);
		padding: 16px 0 8px;
	}

	.primary, .ghost, .secondary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 12px 22px;
		border-radius: var(--radius-control);
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.primary { background: var(--green); color: var(--paper); border-color: var(--green); }
	.ghost { background: transparent; color: var(--muted); border-color: var(--line); }
	.secondary { background: transparent; color: var(--green); border-color: var(--green); }

	.eyebrow {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--green);
		margin-bottom: 10px;
	}

	.handled-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.handled-list li {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--muted);
	}

	.handled-list .tag {
		display: inline-block;
		padding: 2px 8px;
		border-radius: var(--radius-pill);
		background: var(--bg);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-right: 6px;
	}

	.handled-list li.accepted .tag { background: var(--green-soft); color: var(--green); }
	.handled-list li.skipped .tag { background: var(--bg); color: var(--muted); }
	.handled-list li.failed .tag { background: #fde9e6; color: var(--rose); }

	.err-line { color: var(--rose); }
	.more { font-style: italic; }
</style>
