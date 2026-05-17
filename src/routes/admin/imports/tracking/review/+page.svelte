<script lang="ts">
	import { page } from '$app/stores';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	function formatReceived(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso.replace(' ', 'T'));
		if (isNaN(d.getTime())) return iso;
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	const pending = $derived(data.rows.filter((r) => r.disposition === 'pending'));
	// td-3d1ee6: review rows are between pending and handled — they
	// need the admin to pick between candidate gifts found by order# match.
	const review = $derived(data.rows.filter((r) => r.disposition === 'review'));
	const handled = $derived(
		data.rows.filter((r) => r.disposition !== 'pending' && r.disposition !== 'review')
	);

	let confirmingSkipAll = $state(false);
	let confirmingAcceptAll = $state(false);

	const flashCreated = $derived(Number($page.url.searchParams.get('created') ?? '0'));
	const flashLinked = $derived(Number($page.url.searchParams.get('linked') ?? '0'));
	const flashSkipped = $derived(Number($page.url.searchParams.get('skipped') ?? '0'));
	const flashFailed = $derived(Number($page.url.searchParams.get('failed') ?? '0'));
	const flashReview = $derived(Number($page.url.searchParams.get('review') ?? '0'));
	const flashMoveFails = $derived(Number($page.url.searchParams.get('move_failures') ?? '0'));
</script>

<svelte:head>
	<title>Review tracking import — Admin — Gift Tracker</title>
</svelte:head>

<main class="review">
	<header class="page-header">
		<p class="crumbs">
			<a href="/admin/imports/tracking">Tracking import</a> / Review run {data.run.id}
		</p>
		<h1>Review {pending.length} pending</h1>
		<p class="subtitle">
			Fetched {data.run.fetched_count} · Parsed {data.run.parsed_count} · Status
			<strong>{data.run.status}</strong>
		</p>
	</header>

	{#if flashCreated + flashLinked + flashSkipped + flashFailed + flashReview > 0}
		<div class="flash ok" role="status">
			{#if flashCreated > 0}{flashCreated} self-package{flashCreated === 1 ? '' : 's'}
				created · {/if}{#if flashLinked > 0}{flashLinked} linked to existing · {/if}{#if flashSkipped > 0}{flashSkipped}
				skipped · {/if}{#if flashFailed > 0}{flashFailed} failed{/if}{#if flashReview > 0} ·
				<strong>{flashReview} routed to review</strong> (order# matched existing gifts — pick the right
				one below){/if}
			{#if flashMoveFails > 0}
				<br />{flashMoveFails} Gmail label moves failed (check logs).
			{/if}
		</div>
	{/if}

	{#if form?.error}
		<div class="flash err" role="alert">{form.error}</div>
	{/if}

	{#if review.length > 0}
		<!-- td-3d1ee6: rows the importer routed to manual review. Each has
		     one or more candidate gifts that share the parsed order#, but
		     vendor/sender evidence didn't confirm the match. Admin picks
		     which (if any) to attach to. -->
		<form method="POST" action="?/resolveReview" class="review-form review-queue">
			<input type="hidden" name="run_id" value={data.run.id} />
			<header class="queue-head">
				<h2>{review.length} needs your decision</h2>
				<p class="muted bulk">
					The importer found existing gifts with these order numbers but couldn't tell
					if the email actually belongs to one of them (vendor/sender evidence was
					ambiguous). Pick the right match, create a new self-package, or skip.
				</p>
			</header>

			<ul class="rows">
				{#each review as r (r.id)}
					{@const candidates = data.reviewCandidates[r.id] ?? []}
					<li class="row-card review-card">
						<input type="hidden" name="review_row_id" value={r.id} />
						<div class="row-head">
							<div>
								<p class="subject">{r.subject ?? '(no subject)'}</p>
								<p class="meta">
									{r.parsed_carrier ?? 'unknown carrier'}
									· from {r.parsed_sender_domain ?? r.from_address ?? '(unknown)'}
									· {formatReceived(r.received_at)}
								</p>
							</div>
							<div class="infer review">→ ambiguous order# match</div>
						</div>

						{#if r.error_message}
							<p class="warning" role="note">⚠ {r.error_message}</p>
						{/if}

						{#if r.parsed_tracking_number}
							<p class="parsed">
								<span class="label">Tracking</span>
								<span class="mono">{r.parsed_tracking_number}</span>
							</p>
						{/if}
						{#if r.parsed_order_id}
							<p class="parsed">
								<span class="label">Order ID</span>
								<span class="mono">{r.parsed_order_id}</span>
							</p>
						{/if}

						<fieldset class="candidates">
							<legend class="eyebrow">Existing gifts on this order#</legend>
							{#each candidates as c (c.giftId)}
								<label class="candidate">
									<input
										type="radio"
										name="review_action_{r.id}"
										value="attach"
										onchange={(e) => {
											const fd = (e.currentTarget as HTMLInputElement).form;
											const hidden = fd?.querySelector(
												`input[name="review_gift_${r.id}"]`
											) as HTMLInputElement | null;
											if (hidden) hidden.value = String(c.giftId);
										}}
									/>
									<span class="candidate-body">
										<strong>Attach to gift #{c.giftId}</strong>
										— {c.title}
										<br />
										<span class="muted-inline">
											for {c.personDisplayName}
											{#if c.vendorName}· {c.vendorName}{/if}
											· status {c.status}
										</span>
									</span>
								</label>
							{/each}
							<!-- Per-row hidden field captures the chosen giftId; the radio
							     handlers above update it. Server falls back to fail() if
							     attach is selected without a giftId, so the UX is safe
							     even with JS off (no JS → no attach option fires). -->
							<input type="hidden" name="review_gift_{r.id}" value="" />
						</fieldset>

						<div class="choice-grid">
							<label class="radio leave">
								<input
									type="radio"
									name="review_action_{r.id}"
									value="self_package"
								/>
								<span>None of these — create a new self-package</span>
							</label>
							<label class="radio leave">
								<input type="radio" name="review_action_{r.id}" value="skip" />
								<span>Skip → move to Processed</span>
							</label>
							<label class="radio leave">
								<input
									type="radio"
									name="review_action_{r.id}"
									value="leave"
									checked
								/>
								<span>Leave for later → stays in review queue</span>
							</label>
						</div>
					</li>
				{/each}
			</ul>

			<div class="actions">
				<button type="submit" class="primary">Apply review decisions</button>
			</div>
		</form>
	{/if}

	{#if pending.length === 0}
		<section class="card calm">
			<p class="body">Nothing pending for this run.</p>
			<a href="/admin/imports/tracking" class="secondary">Back to scan</a>
		</section>
	{:else}
		<form method="POST" action="?/commit" class="review-form">
			<input type="hidden" name="run_id" value={data.run.id} />
			<p class="muted bulk">
				<strong>Accept</strong> creates a self-package and registers the tracking number with
				Shippo ($0.01 each). Order-confirmation rows (no tracking yet) accept without billing —
				the eventual shipment email upgrades the gift via order# match. <strong>Skip</strong>
				moves the email to Processed without billing. <strong>Leave pending</strong> keeps the
				email in the inbox for re-evaluation on the next scan.
			</p>

			<ul class="rows">
				{#each pending as r (r.id)}
					{@const inference = data.inferences[r.id]}
					<li class="row-card" class:low-confidence={r.error_message != null}>
						<input type="hidden" name="row_id" value={r.id} />

						<div class="row-head">
							<div>
								<p class="subject">{r.subject ?? '(no subject)'}</p>
								<p class="meta">
									{r.parsed_carrier ?? 'unknown carrier'}
									· from {r.parsed_sender_domain ?? r.from_address ?? '(unknown)'}
									· {formatReceived(r.received_at)}
								</p>
							</div>
							{#if inference?.kind === 'link'}
								<div class="infer link">→ link to gift #{inference.giftId}</div>
							{:else if inference?.kind === 'new-no-tracking'}
								<div class="infer new pending-tracking">→ new self-package (no tracking yet)</div>
							{:else}
								<div class="infer new">→ new self-package</div>
							{/if}
						</div>

						{#if r.error_message}
							<p class="warning" role="note">⚠ {r.error_message}</p>
						{/if}

						{#if r.parsed_tracking_number}
							<p class="parsed">
								<span class="label">Tracking</span>
								<span class="mono">{r.parsed_tracking_number}</span>
							</p>
						{/if}
						{#if r.parsed_order_id}
							<p class="parsed">
								<span class="label">Order ID</span>
								<span class="mono">{r.parsed_order_id}</span>
							</p>
						{/if}

						<div class="choice-grid">
							<label class="radio">
								<input
									type="radio"
									name="disposition_{r.id}"
									value="accept"
									checked
								/>
								<span
									>Accept → {inference?.kind === 'link'
										? `link to existing gift`
										: inference?.kind === 'new-no-tracking'
											? 'create self-package (no Shippo registration)'
											: 'create self-package + register'}</span
								>
							</label>
							<label class="radio">
								<input type="radio" name="disposition_{r.id}" value="skip" />
								<span>Skip → move to Processed</span>
							</label>
							<label class="radio leave">
								<input type="radio" name="disposition_{r.id}" value="leave" />
								<span>Leave pending → stays in Inbox, re-surfaces next scan</span>
							</label>
						</div>
					</li>
				{/each}
			</ul>

			<div class="actions">
				<button type="submit" class="primary">Commit selected</button>
				{#if confirmingSkipAll}
					<button
						type="button"
						class="ghost"
						onclick={() => {
							confirmingSkipAll = false;
						}}
					>
						Cancel
					</button>
					<button type="submit" formaction="?/skipAll" class="ghost danger">
						Yes, skip all {pending.length}
					</button>
				{:else if confirmingAcceptAll}
					<button
						type="button"
						class="ghost"
						onclick={() => {
							confirmingAcceptAll = false;
						}}
					>
						Cancel
					</button>
					<button type="submit" formaction="?/acceptAll" class="primary">
						Yes, accept all {pending.length} (~${(pending.length * 0.01).toFixed(2)})
					</button>
				{:else}
					<button
						type="button"
						class="ghost"
						onclick={() => {
							confirmingSkipAll = true;
						}}
					>
						Skip all
					</button>
					<button
						type="button"
						class="ghost"
						onclick={() => {
							confirmingAcceptAll = true;
						}}
					>
						Accept all
					</button>
				{/if}
			</div>
		</form>
	{/if}

	{#if handled.length > 0}
		<section class="card">
			<p class="eyebrow">Already handled in this run ({handled.length})</p>
			<ul class="handled-list">
				{#each handled.slice(0, 30) as r (r.id)}
					<li class="handled-li {r.disposition}">
						<span class="tag">{r.disposition}</span>
						<span class="handled-subject">{r.subject ?? '(no subject)'}</span>
						{#if r.parsed_carrier && r.parsed_tracking_number}
							<span class="muted-inline">
								· {r.parsed_carrier} <span class="mono">{r.parsed_tracking_number}</span>
							</span>
						{/if}
						{#if r.gift_id}
							<span class="muted-inline">
								· <a href="/app/gifts/{r.gift_id}">gift #{r.gift_id}</a>
							</span>
						{/if}
						{#if r.error_message}
							<span class="err-line">· {r.error_message}</span>
						{/if}
					</li>
				{/each}
				{#if handled.length > 30}
					<li class="more">… and {handled.length - 30} more.</li>
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
	.row-card.low-confidence {
		border-color: var(--amber);
		background: var(--amber-soft);
	}
	.warning {
		font-family: var(--font-sans);
		font-size: 13px;
		color: var(--amber);
		font-weight: 600;
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
	}

	.infer {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 600;
		padding: 4px 10px;
		border-radius: var(--radius-pill);
		white-space: nowrap;
		align-self: flex-start;
	}
	.infer.link { background: var(--green-soft); color: var(--green); }
	.infer.new { background: var(--amber-soft); color: var(--amber); }
	.infer.new.pending-tracking { background: var(--bg); color: var(--muted); border: 1px dashed var(--line); }

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
	.mono {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
	}

	.choice-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
		margin-top: 6px;
		padding-top: 10px;
		border-top: 1px dashed var(--line);
	}

	.choice-grid .radio.leave { grid-column: 1 / span 2; }

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

	.actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
		margin-top: 16px;
		position: sticky;
		bottom: 96px;
		/* td-c12570: BottomNav is fixed at z-index: 20 — without an explicit
		   z-index here, taps near the action bar's bottom edge land on the
		   nav instead of the action buttons. */
		z-index: 30;
		background: linear-gradient(180deg, transparent 0%, var(--bg) 50%);
		padding: 16px 0 8px;
	}

	/* td-3d1ee6: review-queue styling */
	.review-queue { margin-bottom: 18px; }
	.queue-head { margin-bottom: 10px; }
	.queue-head h2 {
		font-family: var(--font-serif);
		font-size: 22px;
		color: var(--amber);
		margin-bottom: 6px;
	}
	.review-card {
		border-color: var(--amber);
		background: var(--amber-soft);
	}
	.infer.review {
		background: var(--amber);
		color: var(--paper);
	}
	.candidates {
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		background: var(--paper);
		margin: 6px 0 4px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.candidates legend {
		padding: 0 6px;
		background: var(--paper);
		border-radius: var(--radius-pill);
	}
	.candidate {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		font-family: var(--font-sans);
		font-size: 14px;
		line-height: 1.4;
		min-height: var(--tap-target);
		padding: 6px 4px;
		cursor: pointer;
	}
	.candidate input[type='radio'] {
		width: 20px;
		height: 20px;
		accent-color: var(--green);
		margin-top: 2px;
		flex-shrink: 0;
	}
	.candidate-body { flex: 1 1 auto; min-width: 0; }
	.candidate strong { color: var(--ink); }

	.handled-list li.review .tag { background: var(--amber-soft); color: var(--amber); }

	.primary,
	.ghost,
	.secondary {
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
	.ghost.danger { color: var(--rose); border-color: var(--rose); }
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
		padding: 6px 0;
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: baseline;
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
	}

	.handled-list li.accepted .tag { background: var(--green-soft); color: var(--green); }
	.handled-list li.skipped .tag { background: var(--bg); color: var(--muted); }
	.handled-list li.failed .tag { background: #fde9e6; color: var(--rose); }

	.handled-subject {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink);
	}

	.muted-inline { color: var(--muted); }
	.err-line { color: var(--rose); }
	.more { font-style: italic; }
</style>
