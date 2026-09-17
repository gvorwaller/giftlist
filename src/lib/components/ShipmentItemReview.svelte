<script lang="ts">
	import { untrack } from 'svelte';
	import type { ShipmentPlan, ShipmentItemPlan } from '$server/shipment-reconciliation';
	let {
		plan,
		entry,
		people
	}: {
		plan: ShipmentPlan;
		entry: ShipmentItemPlan;
		people: Array<{ id: number; display_name: string }>;
	} = $props();
	const initial = untrack(() => entry);
	let action = $state(initial.excluded ? 'ignore' : initial.giftId ? 'match' : 'pending');
	let person = $state('');
	let selected = $state<number[]>([]);
	let order = $state(untrack(() => (plan.orderIds.length === 1 ? plan.orderIds[0] : '')));
	const prefix = $derived(`shipment_${plan.rowId}_${entry.itemIndex}`);
	const match = $derived(plan.gifts.find((g) => g.id === entry.giftId));
	const choices = $derived(
		plan.gifts.filter((g) => !g.is_archived && (!person || g.person_id === Number(person)))
	);
	function label(g: ShipmentPlan['gifts'][number]) {
		const settled =
			['wrapped', 'given', 'returned'].includes(g.status) ||
			(plan.target === 'shipped' && g.status === 'delivered');
		return settled
			? `Link to ${g.personName}’s ${g.title} — keep ${g.status}`
			: `Mark ${g.personName}’s ${g.title} as ${plan.target}`;
	}
	function toggle(id: number, checked: boolean) {
		selected = checked
			? entry.item.quantity === 1
				? [id]
				: [...selected, id]
			: selected.filter((x) => x !== id);
	}
</script>

<fieldset>
	<legend
		>{entry.item.title}{entry.item.quantity > 1 ? ` (quantity ${entry.item.quantity})` : ''}</legend
	>
	{#if entry.resolved}
		<p>
			Saved: {entry.savedAction === 'ignore'
				? 'Not tracking this item'
				: entry.savedGiftIds
						.map((id) => {
							const g = plan.gifts.find((g) => g.id === id);
							return g ? `${g.personName} — ${g.title}` : `Gift #${id}`;
						})
						.join('; ')}
		</p>
	{:else}
		<p>{entry.reason}</p>
		<label
			>Action
			<select name="{prefix}_action" bind:value={action}>
				{#if match}<option value="match">{label(match)}</option>{/if}
				<option value="pending">Leave this item pending</option>
				<option value="update">Choose a person and existing gift — mark {plan.target}</option>
				<option value="ignore">Not tracking this item</option>
				<option value="create">Create a new gift explicitly</option>
			</select>
		</label>
		{#if action === 'match' && match}
			<input type="hidden" name="{prefix}_gift" value={match.id} />
			<p>
				<strong>{label(match)}</strong>{match.occasionLabel ? ` · ${match.occasionLabel}` : ''}.
				Recipient and occasion stay assigned.
			</p>
		{:else if action === 'update' || action === 'create'}
			<label
				>Person
				<select name="{prefix}_person" bind:value={person} required={action === 'create'}>
					<option value=""
						>{action === 'update'
							? 'All people — choose to narrow gifts'
							: 'Choose recipient'}</option
					>
					{#each people as p (p.id)}<option value={String(p.id)}>{p.display_name}</option>{/each}
				</select>
			</label>
			{#if action === 'update'}
				<p>
					Select {entry.item.quantity === 1
						? 'the existing gift'
						: `${entry.item.quantity} gifts, one for each unit`}. Selected: {selected.length}.
				</p>
				{#each selected as id}<input type="hidden" name="{prefix}_gift" value={id} />{/each}
				<div class="gifts">
					{#each choices as g (g.id)}
						<label class="gift"
							><input
								type="checkbox"
								checked={selected.includes(g.id)}
								onchange={(e) => toggle(g.id, e.currentTarget.checked)}
							/>
							<span
								>{label(g)}{g.occasionLabel ? ` · ${g.occasionLabel}` : ''}<small
									>Currently {g.status}{g.canonicalOrderId
										? ` · order ${g.canonicalOrderId}`
										: ''}</small
								></span
							>
						</label>
					{:else}<p>No available gifts for this person.</p>{/each}
				</div>
				{#if selected.length}<p>
						Chosen: {selected
							.map((id) => {
								const g = plan.gifts.find((g) => g.id === id);
								return g ? `${g.personName} — ${g.title}` : '';
							})
							.join('; ')}
					</p>{/if}
			{:else}
				<p>
					This creates {entry.item.quantity} new gift{entry.item.quantity === 1 ? '' : 's'} and marks
					{entry.item.quantity === 1 ? 'it' : 'them'}
					{plan.target}. Check existing gifts first.
				</p>
				{#if plan.orderIds.length}
					<label
						>Order for this item <select name="{prefix}_order" bind:value={order} required>
							<option value="">Choose the item’s order</option>
							{#each plan.orderIds as id}<option value={id}>{id}</option>{/each}
						</select></label
					>
				{/if}
			{/if}
		{/if}
	{/if}
</fieldset>

<style>
	fieldset {
		min-width: 0;
		border: 1px solid var(--border, #b5afa3);
		border-radius: 12px;
		padding: 1rem;
		margin: 1rem 0;
		background: var(--surface, #fffdf7);
		color: var(--text, #292b24);
	}
	legend {
		font-weight: 700;
		overflow-wrap: anywhere;
		max-width: 100%;
	}
	p {
		margin: 0.75rem 0;
		overflow-wrap: anywhere;
	}
	label {
		display: grid;
		gap: 0.4rem;
		margin: 0.5rem 0;
	}
	select {
		min-height: 48px;
		width: 100%;
		max-width: 100%;
		font: inherit;
		font-size: 18px;
		color: inherit;
		background: var(--surface, #fffdf7);
		padding: 0.5rem;
		border: 1px solid var(--border, #888);
		border-radius: 6px;
	}
	.gifts {
		max-height: 24rem;
		overflow: auto;
	}
	.gift {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		min-height: 48px;
		padding: 0.5rem;
	}
	input[type='checkbox'] {
		width: 24px;
		height: 24px;
		flex-shrink: 0;
	}
	small {
		display: block;
		font-size: 1rem;
		margin-top: 0.2rem;
	}
</style>
