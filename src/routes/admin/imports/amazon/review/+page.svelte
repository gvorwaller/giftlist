<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/stores';
	import type { ActionData, PageData } from './$types';
	import PersonPicker from '$lib/components/PersonPicker.svelte';

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

	// td-3e9ae2 / td-77a119: per-row state for the "Apply same recipient to all"
	// shortcut + the per-line-item recipient pickers. State-driven (was
	// DOM-driven against native <select>) so the new PersonPicker combobox
	// works without manual DOM access. Eagerly seed every key — PersonPicker's
	// `value` prop is typed `number | null`; a dictionary lookup that returns
	// `undefined` throws Svelte 5 `props_invalid_value` during hydration, which
	// silently aborts client-side SvelteKit navigation into this route.
	let applyAllSelected = $state<Record<number, boolean>>(
		untrack(() => Object.fromEntries(data.rows.map((r) => [r.id, false])))
	);
	let applyAllPerson = $state<Record<number, number | null>>(
		untrack(() => Object.fromEntries(data.rows.map((r) => [r.id, null])))
	);
	let lineSelections = $state<Record<string, number | null>>(
		untrack(() =>
			Object.fromEntries(
				data.rows.flatMap((r) =>
					(data.rowItems[r.id] ?? []).map((_, i) => [`${r.id}:${i}`, null] as const)
				)
			)
		)
	); // key = `${rowId}:${idx}`
	let singleSelections = $state<Record<number, number | null>>(
		untrack(() => Object.fromEntries(data.rows.map((r) => [r.id, r.match_person_id ?? null])))
	); // key = rowId

	function syncLineItemPickers(rowId: number, count: number) {
		// When "apply same to all" is on and a person is chosen, propagate
		// to every line-item picker for this row.
		const pid = applyAllPerson[rowId] ?? null;
		for (let i = 0; i < count; i++) {
			lineSelections[`${rowId}:${i}`] = pid;
		}
	}

	let confirmingSkipAll = $state(false);
	let expandedHandledRowId = $state<number | null>(null);

	function priceDollarsOrEmpty(c: number | null | undefined): string {
		return c == null ? '' : `$${(c / 100).toFixed(2)}`;
	}

	const flashGifts = $derived(Number($page.url.searchParams.get('gifts') ?? '0'));
	const flashSkipped = $derived(Number($page.url.searchParams.get('skipped') ?? '0'));
	const flashFailed = $derived(Number($page.url.searchParams.get('failed') ?? '0'));
	const flashMoveFails = $derived(Number($page.url.searchParams.get('move_failures') ?? '0'));
	const flashReassigned = $derived(Number($page.url.searchParams.get('reassigned') ?? '0'));
	const flashRetried = $derived(Number($page.url.searchParams.get('retried') ?? '0'));
	const flashRematched = $derived(Number($page.url.searchParams.get('rematched') ?? '0'));
	// td-1d01e9 Phase B: LLM re-evaluate flash params.
	const flashLlmSkipped = $derived($page.url.searchParams.get('llm_skipped') === '1');
	const flashLlmEval = $derived(Number($page.url.searchParams.get('llm_evaluated') ?? '0'));
	const flashLlmConfirmed = $derived(Number($page.url.searchParams.get('llm_confirmed') ?? '0'));
	const flashLlmRejected = $derived(Number($page.url.searchParams.get('llm_rejected') ?? '0'));
	const flashLlmCalls = $derived(Number($page.url.searchParams.get('llm_api_calls') ?? '0'));
	const flashLlmErrors = $derived(Number($page.url.searchParams.get('llm_errors') ?? '0'));

	const failedWithOrder = $derived(
		data.rows.filter((r) => r.disposition === 'failed' && r.parsed_order_id)
	);
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
	{:else if flashReassigned > 0}
		<div class="flash ok" role="status">
			Row reassigned and gift created.
		</div>
	{:else if flashRetried > 0}
		<div class="flash ok" role="status">
			{#if flashRematched > 0}
				{flashRematched} of {flashRetried} failed row{flashRetried === 1 ? '' : 's'} re-matched
				to existing gifts by order # — moved back to pending for review.
			{:else}
				Re-checked {flashRetried} failed row{flashRetried === 1 ? '' : 's'} but no order # matches found.
			{/if}
		</div>
	{:else if flashFailed > 0}
		<div class="flash err" role="alert">
			Reassign failed: {flashFailed} row could not be created.
		</div>
	{/if}

	{#if form?.error}
		<div class="flash err" role="alert">{form.error}</div>
	{/if}

	<!-- td-1d01e9 Phase B: LLM re-evaluation flash + admin trigger -->
	{#if flashLlmSkipped}
		<div class="flash err" role="alert">
			AI re-evaluation skipped: <code>ANTHROPIC_API_KEY</code> is not set on the server.
			Add it to <code>.env</code> and restart, or stick with heuristic matching only.
		</div>
	{:else if flashLlmEval > 0}
		<div class="flash ok" role="status">
			AI re-evaluated {flashLlmEval} weak match{flashLlmEval === 1 ? '' : 'es'} —
			<strong>{flashLlmConfirmed} confirmed</strong>, {flashLlmRejected} rejected
			({flashLlmCalls} API call{flashLlmCalls === 1 ? '' : 's'}{flashLlmErrors > 0
				? `, ${flashLlmErrors} errors`
				: ''}).
		</div>
	{/if}

	{#if pending.length > 0}
		<form method="POST" action="?/reevaluateMatches" class="llm-tools">
			<input type="hidden" name="run_id" value={data.run.id} />
			<button type="submit" class="ghost">Re-evaluate weak matches with AI</button>
			<span class="muted-inline">
				Asks Haiku to confirm or reject weak gift-match suggestions. ~$0.001/row, cached.
			</span>
		</form>
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
				Default per row is <strong>accept with matched person</strong> for order lifecycle
				emails, <strong>skip</strong> for marketing/review noise. Pick <strong>leave pending</strong>
				on anything you're unsure about — the email stays in Inbox and re-surfaces on the next
				scan. Leave person blank to force a manual assignment.
			</p>

			<ul class="rows">
				{#each pending as r (r.id)}
					{@const candidates = parseCandidates(r.match_candidates_json)}
					{@const giftMatch = data.giftMatches[r.id]}
					{@const giftCandidates = giftMatch?.candidates ?? []}
					{@const items = data.rowItems[r.id] ?? []}
					{@const isMultiItem = items.length > 1}
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

						{#if !isMultiItem && r.parsed_title}
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

						{#if isMultiItem}
							<fieldset class="line-items">
								<legend>
									{items.length} line items —
									<span class="hint">assign each to its recipient (td-3e9ae2)</span>
								</legend>
								<label class="apply-all">
									<input
										type="checkbox"
										checked={applyAllSelected[r.id] ?? false}
										onchange={(e) => {
											applyAllSelected[r.id] = (e.currentTarget as HTMLInputElement).checked;
											if (applyAllSelected[r.id]) syncLineItemPickers(r.id, items.length);
										}}
									/>
									<span>Same recipient for all {items.length}</span>
									{#if applyAllSelected[r.id]}
										<div class="apply-all-picker">
											<PersonPicker
												people={data.people}
												bind:value={applyAllPerson[r.id]}
												name="_apply_all_{r.id}"
												placeholder="— choose —"
												onchange={() => syncLineItemPickers(r.id, items.length)}
											/>
										</div>
									{/if}
								</label>
								<ul class="line-list">
									{#each items as it, idx (idx)}
										{@const lineMatch = data.lineItemMatches[`${r.id}:${idx}`]}
										<li class="line-li">
											<div class="line-head">
												<p class="line-title">{it.title}</p>
												<p class="line-price">{priceDollarsOrEmpty(it.priceCents ?? null)}</p>
											</div>
											<label class="line-pick">
												<span class="lbl">Recipient</span>
												<PersonPicker
													people={data.people}
													bind:value={lineSelections[`${r.id}:${idx}`]}
													name="lineperson_{r.id}_{idx}"
													placeholder="— choose —"
												/>
											</label>
											{#if lineMatch && lineMatch.candidates.length > 0}
												<fieldset class="line-gift">
													<legend>
														Existing
														{lineMatch.candidates.length === 1 ? 'gift idea' : 'gift ideas'}
														{#if lineMatch.confidence === 'strong'}
															<span class="badge strong">strong match</span>
														{:else}
															<span class="badge weak">weak match</span>
														{/if}
													</legend>
													<label class="gift-radio">
														<input
															type="radio"
															name="linegift_{r.id}_{idx}"
															value=""
															checked={lineMatch.confidence !== 'strong'}
														/>
														<span>Don't link — create a new gift</span>
													</label>
													{#each lineMatch.candidates as g (g.giftId)}
														<label class="gift-radio">
															<input
																type="radio"
																name="linegift_{r.id}_{idx}"
																value={String(g.giftId)}
																checked={lineMatch.topId === g.giftId}
															/>
															<span>
																<strong>{g.title}</strong>
																<span class="muted">→ {g.personDisplayName}</span>
																<span class="score">{Math.round(g.score * 100)}%</span>
															</span>
														</label>
													{/each}
												</fieldset>
											{/if}
										</li>
									{/each}
								</ul>
							</fieldset>
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
								<span>Skip → move to Processed</span>
							</label>
							<label class="radio leave">
								<input type="radio" name="disposition_{r.id}" value="leave" />
								<span>Leave pending → stays in Inbox, re-surfaces next scan</span>
							</label>

							{#if giftCandidates.length > 0 && !isMultiItem}
								<fieldset class="gift-link">
									<legend>
										Looks like an existing
										{giftCandidates.length === 1 ? 'gift' : 'gift idea'}
										{#if giftMatch?.confidence === 'strong'}
											<span class="badge strong">strong match</span>
										{:else if giftMatch?.llmVerdict?.confirmedGiftId}
											<!-- td-1d01e9 Phase B: AI confirmed one weak candidate -->
											<span class="badge ai-confirmed">AI confirmed</span>
										{:else if giftMatch?.llmVerdict && giftMatch.llmVerdict.confirmedGiftId === null}
											<!-- td-1d01e9 Phase B: AI rejected all weak candidates -->
											<span class="badge ai-rejected">AI rejected</span>
										{:else}
											<span class="badge weak">weak match</span>
										{/if}
									</legend>
									{#if giftMatch?.llmVerdict}
										<p class="ai-reason">
											<em>AI:</em>
											{giftMatch.llmVerdict.reason}
										</p>
									{/if}
									<label class="gift-radio">
										<input
											type="radio"
											name="gift_{r.id}"
											value=""
											checked={giftMatch?.confidence !== 'strong' &&
												!giftMatch?.llmVerdict?.confirmedGiftId}
										/>
										<span>Don't link — create a new gift</span>
									</label>
									{#each giftCandidates as g (g.giftId)}
										<label class="gift-radio">
											<input
												type="radio"
												name="gift_{r.id}"
												value={String(g.giftId)}
												checked={giftMatch?.topId === g.giftId ||
													giftMatch?.llmVerdict?.confirmedGiftId === g.giftId}
											/>
											<span>
												<strong>{g.title}</strong>
												<span class="muted">→ {g.personDisplayName}</span>
												<span class="score">{Math.round(g.score * 100)}%</span>
												{#if giftMatch?.llmVerdict?.confirmedGiftId === g.giftId}
													<span class="badge ai-pill">AI pick</span>
												{/if}
											</span>
										</label>
									{/each}
									<p class="hint">
										Linking will set the gift's order ID, advance it from idea
										to ordered/shipped/delivered, and use the gift's recipient.
									</p>
								</fieldset>
							{/if}

							{#if !isMultiItem}
								<label class="person-select">
									<span class="label">Or assign to person</span>
									<PersonPicker
										people={data.people}
										bind:value={singleSelections[r.id]}
										name="person_{r.id}"
										placeholder="— unassigned —"
									/>
									{#if r.match_person_id && r.match_confidence}
										<span class="hint">
											{r.match_confidence} match
											{#if candidates.length > 1}
												· {candidates.length} candidates
											{/if}
										</span>
									{/if}
								</label>
							{/if}

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
						Yes, skip all {pending.length} pending
					</button>
				{:else}
					<button
						type="button"
						class="ghost"
						onclick={() => {
							confirmingSkipAll = true;
						}}
					>
						Skip all pending
					</button>
				{/if}
			</div>
		</form>
	{/if}

	{#if handled.length > 0}
		<section class="card">
			<div class="handled-header">
				<p class="eyebrow">Already handled in this run ({handled.length})</p>
				{#if failedWithOrder.length > 0}
					<form method="POST" action="?/retryFailedByOrder" class="retry-form">
						<input type="hidden" name="run_id" value={data.run.id} />
						<button type="submit" class="ghost small" title="Re-check failed rows against existing gifts by order #">
							Retry {failedWithOrder.length} failed by order #
						</button>
					</form>
				{/if}
			</div>
			<ul class="handled-list">
				{#each handled.slice(0, 20) as r (r.id)}
					{@const reassignable = r.disposition === 'failed' || r.disposition === 'skipped'}
					{@const expanded = expandedHandledRowId === r.id}
					<li class="handled-li {r.disposition}">
						<button
							type="button"
							class="handled-summary"
							aria-expanded={expanded}
							onclick={() => {
								if (!reassignable) return;
								expandedHandledRowId = expanded ? null : r.id;
							}}
							disabled={!reassignable}
						>
							<span class="tag">{r.disposition}</span>
							<span class="handled-subject">{r.subject ?? '(no subject)'}</span>
							{#if r.gift_id}
								<span class="muted-inline">· <a href="/app/gifts/{r.gift_id}">gift #{r.gift_id}</a></span>
							{/if}
							{#if r.error_message}
								<span class="err-line">· {r.error_message}</span>
							{/if}
							{#if reassignable}
								<span class="caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
							{/if}
						</button>

						{#if expanded && reassignable}
							<div class="handled-detail">
								<dl class="row-kv">
									{#if r.parsed_recipient_name}
										<div><dt>Parsed recipient</dt><dd>{r.parsed_recipient_name}</dd></div>
									{/if}
									{#if r.parsed_title}
										<div><dt>Item</dt><dd>{r.parsed_title}</dd></div>
									{/if}
									{#if r.parsed_order_id}
										<div><dt>Order</dt><dd class="mono">{r.parsed_order_id}</dd></div>
									{/if}
									{#if r.parsed_price_cents != null}
										<div><dt>Price</dt><dd>{priceDollarsOrEmpty(r.parsed_price_cents)}</dd></div>
									{/if}
									{#if r.parsed_shipping_address}
										<div><dt>Ships to</dt><dd>{r.parsed_shipping_address}</dd></div>
									{/if}
									{#if r.parsed_gift_message}
										<div><dt>Gift message</dt><dd>{r.parsed_gift_message}</dd></div>
									{/if}
								</dl>

								<form method="POST" action="?/reassign" class="reassign-form">
									<input type="hidden" name="run_id" value={data.run.id} />
									<input type="hidden" name="row_id" value={r.id} />
									<label class="reassign-row">
										<span class="lbl">Assign to person</span>
										<select name="person_id" required>
											<option value="">— choose —</option>
											{#each data.people as p (p.id)}
												<option value={p.id}>{p.display_name}</option>
											{/each}
										</select>
									</label>
									{#if r.parsed_recipient_name}
										<label class="alias">
											<input type="checkbox" name="alias" />
											<span>Remember "{r.parsed_recipient_name}" as an alias for this person</span>
										</label>
									{/if}
									<div class="reassign-actions">
										<button type="submit" class="primary">Reassign &amp; create gift</button>
									</div>
								</form>
							</div>
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

	.choice-grid .radio.leave {
		grid-column: 1 / span 2;
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

	.gift-link {
		grid-column: 1 / span 2;
		border: 1px solid var(--green);
		background: var(--green-soft);
		border-radius: var(--radius-control);
		padding: 12px 14px;
		margin: 4px 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* td-3e9ae2: multi-item Amazon order — per-line-item recipient pickers. */
	.line-items {
		border: 1px solid var(--amber);
		background: var(--amber-soft);
		border-radius: var(--radius-control);
		padding: 14px 16px;
		margin: 8px 0 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.line-items legend {
		font-family: var(--font-sans);
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--amber);
		padding: 0 8px;
	}
	.line-items legend .hint {
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--muted);
	}
	.line-items .apply-all {
		display: flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--ink);
	}
	.line-items .apply-all input[type='checkbox'] {
		width: 22px;
		height: 22px;
		accent-color: var(--amber);
	}
	.line-items .apply-all-picker {
		flex: 1 1 200px;
		min-width: 0;
	}
	.line-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.line-li {
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.line-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}
	.line-title {
		font-family: var(--font-serif);
		font-size: 16px;
		color: var(--ink);
		margin: 0;
		flex: 1;
	}
	.line-price {
		font-family: var(--font-sans);
		font-variant-numeric: tabular-nums;
		color: var(--muted);
		margin: 0;
	}
	.line-pick {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.line-pick .lbl {
		font-family: var(--font-sans);
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
	}
	.line-pick select {
		min-height: 48px;
		padding: 8px 10px;
		border-radius: var(--radius-control);
		border: 1px solid var(--line);
		background: var(--bg);
		font-size: 16px;
	}
	.line-gift {
		border: 1px solid var(--green);
		background: var(--green-soft);
		border-radius: var(--radius-control);
		padding: 8px 10px;
		margin: 0;
	}
	.line-gift legend {
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--green);
		padding: 0 6px;
	}
	.line-gift .badge {
		display: inline-block;
		padding: 1px 8px;
		border-radius: var(--radius-pill);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		margin-left: 6px;
		text-transform: uppercase;
	}
	.line-gift .badge.strong {
		background: var(--green);
		color: var(--paper);
	}
	.line-gift .badge.weak {
		background: var(--amber-soft);
		color: var(--amber);
		border: 1px solid var(--amber);
	}

	.gift-link legend {
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--green);
		padding: 0 8px;
	}

	.gift-link .badge {
		display: inline-block;
		padding: 1px 8px;
		border-radius: var(--radius-pill);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		margin-left: 6px;
		text-transform: uppercase;
	}
	.gift-link .badge.strong {
		background: var(--green);
		color: var(--paper);
	}
	.gift-link .badge.weak {
		background: var(--amber-soft);
		color: var(--amber);
		border: 1px solid var(--amber);
	}
	/* td-1d01e9 Phase B: LLM verdict badges */
	.gift-link .badge.ai-confirmed {
		background: var(--green);
		color: var(--paper);
	}
	.gift-link .badge.ai-rejected {
		background: var(--bg);
		color: var(--muted);
		border: 1px solid var(--line);
	}
	.gift-link .badge.ai-pill {
		background: var(--green-soft);
		color: var(--green);
		font-size: 10px;
		padding: 1px 8px;
		margin-left: 8px;
	}
	.ai-reason {
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
		padding: 6px 10px;
		background: var(--bg);
		border-radius: var(--radius-control);
		margin: 4px 0 8px;
	}
	.llm-tools {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding: 10px 12px;
		background: var(--paper);
		border: 1px dashed var(--line);
		border-radius: var(--radius-control);
		margin-bottom: 12px;
	}
	.llm-tools .muted-inline {
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
	}

	.gift-radio {
		display: flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--ink);
		padding: 4px 0;
	}

	.gift-radio input[type='radio'] {
		width: 20px;
		height: 20px;
		accent-color: var(--green);
		flex-shrink: 0;
	}

	.gift-radio .muted {
		color: var(--muted);
		font-size: 13px;
		margin-left: 6px;
	}

	.gift-radio .score {
		margin-left: auto;
		font-size: 12px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.gift-link .hint {
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--muted);
		margin-top: 4px;
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
		/* td-c12570: BottomNav is fixed at z-index: 20 — without an explicit
		   z-index here, taps near the action bar's bottom edge land on the
		   nav instead of the Commit/Skip buttons. */
		z-index: 30;
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

	.handled-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}
	.handled-header .eyebrow { margin-bottom: 0; }
	.retry-form { margin: 0; }
	.ghost.small {
		min-height: 36px;
		padding: 6px 14px;
		font-size: 13px;
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

	.handled-li {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.handled-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		text-align: left;
		padding: 8px 0;
		min-height: var(--tap-target);
		background: transparent;
		border: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.handled-summary:disabled {
		cursor: default;
	}

	.handled-summary:not(:disabled):hover .handled-subject {
		color: var(--ink);
	}

	.handled-subject {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.muted-inline {
		color: var(--muted);
		font-size: 13px;
	}

	.caret {
		color: var(--muted);
		font-size: 11px;
		margin-left: 4px;
	}

	.handled-detail {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: 14px 16px;
		margin: 6px 0 10px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.row-kv {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
	}

	.row-kv > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.row-kv dt {
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.row-kv dd {
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--ink);
	}

	.row-kv .mono {
		font-family: 'SF Mono', ui-monospace, monospace;
		font-size: 13px;
	}

	.reassign-form {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.reassign-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.reassign-row .lbl {
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.reassign-row select {
		min-height: var(--tap-target);
		padding: 8px 12px;
		font-family: var(--font-sans);
		font-size: 15px;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		color: var(--ink);
	}

	.alias {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-sans);
		font-size: 14px;
		color: var(--ink);
	}

	.reassign-actions {
		display: flex;
		gap: 10px;
	}

	.primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
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
</style>
