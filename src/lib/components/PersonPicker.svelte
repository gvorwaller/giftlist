<script lang="ts">
	/**
	 * td-77a119: searchable, accessible recipient picker.
	 *
	 * Drop-in replacement for `<select name="person_id">` across the app's
	 * gift forms and Amazon-review pickers. Types-to-filter against
	 * display_name + full_name + relationship. Keyboard-first (↑/↓/Enter/Esc).
	 * Hidden <input> carries the selected id to the form action — so this
	 * component works with both `bind:value` reactive flows and plain POST
	 * form submissions (no `use:enhance` required).
	 *
	 * People-list size in this app is small (10-30 typical); no virtualization
	 * needed. Filter is plain substring match — predictable across mobile
	 * touch keyboards.
	 */
	import type { Person } from '$lib/server/types';

	interface Props {
		people: Person[];
		value: number | null;
		name: string;
		placeholder?: string;
		required?: boolean;
		disabled?: boolean;
		onchange?: (id: number | null) => void;
		/** Unique id for ARIA wiring; defaults to a random one. */
		id?: string;
	}

	let {
		people,
		value = $bindable(null),
		name,
		placeholder = '— choose a recipient —',
		required = false,
		disabled = false,
		onchange,
		id = `pp-${Math.random().toString(36).slice(2, 9)}`
	}: Props = $props();

	let query = $state('');
	let open = $state(false);
	let activeIndex = $state(-1);
	let inputEl: HTMLInputElement | null = $state(null);

	// Resolve the currently-selected person for the input's display value.
	const selected = $derived(value != null ? people.find((p) => p.id === value) ?? null : null);

	// Filter people by substring match against display_name, full_name,
	// and relationship (so typing "niece" surfaces all nieces). Case-insensitive.
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return people;
		return people.filter((p) => {
			const haystack = [
				p.display_name,
				p.full_name ?? '',
				p.relationship ?? ''
			]
				.join(' ')
				.toLowerCase();
			return haystack.includes(q);
		});
	});

	function displayLabel(p: Person | null): string {
		if (!p) return '';
		if (p.full_name && p.full_name !== p.display_name) {
			return `${p.display_name} (${p.full_name})`;
		}
		return p.display_name;
	}

	function selectPerson(p: Person | null) {
		value = p?.id ?? null;
		query = displayLabel(p);
		open = false;
		activeIndex = -1;
		onchange?.(value);
	}

	function onInput(e: Event) {
		query = (e.target as HTMLInputElement).value;
		open = true;
		activeIndex = filtered.length > 0 ? 0 : -1;
		// Typing clears the bound value until a selection is made — otherwise
		// the hidden form input would still submit a stale id.
		if (value !== null) {
			value = null;
			onchange?.(null);
		}
	}

	function onFocus() {
		open = true;
		if (selected) {
			// Show all options when re-focusing a selected field.
			query = '';
		}
		activeIndex = filtered.length > 0 ? 0 : -1;
	}

	function onBlur() {
		// Delay close so a click on the listbox can register before unmount.
		setTimeout(() => {
			open = false;
			// If user typed without selecting, revert to the last valid label.
			if (selected) {
				query = displayLabel(selected);
			} else if (query.trim() === '') {
				query = '';
			}
		}, 120);
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
			open = true;
			activeIndex = filtered.length > 0 ? 0 : -1;
			e.preventDefault();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (e.key === 'Enter') {
			if (activeIndex >= 0 && activeIndex < filtered.length) {
				e.preventDefault();
				selectPerson(filtered[activeIndex]);
			}
		} else if (e.key === 'Escape') {
			open = false;
			activeIndex = -1;
			if (selected) query = displayLabel(selected);
		} else if (e.key === 'Tab') {
			// Tab commits the active option if any.
			if (activeIndex >= 0 && activeIndex < filtered.length) {
				selectPerson(filtered[activeIndex]);
			}
		}
	}

	// Initialize the displayed query from value on first render.
	$effect(() => {
		if (value !== null && selected && query === '') {
			query = displayLabel(selected);
		}
		if (value === null && selected === null && query === '' && !inputEl) {
			// no-op
		}
	});

	const listboxId = $derived(`${id}-listbox`);
</script>

<div
	class="person-picker"
	role="combobox"
	aria-expanded={open}
	aria-controls={listboxId}
	aria-haspopup="listbox"
>
	<input
		bind:this={inputEl}
		type="text"
		role="searchbox"
		aria-autocomplete="list"
		aria-controls={listboxId}
		aria-activedescendant={activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
		{id}
		value={query}
		oninput={onInput}
		onfocus={onFocus}
		onblur={onBlur}
		onkeydown={onKeydown}
		{placeholder}
		{disabled}
		autocomplete="off"
		spellcheck="false"
	/>
	<!-- Hidden field that actually submits with the form. Native form
	     submission picks this up; SvelteKit `use:enhance` flows do too. -->
	<input type="hidden" {name} value={value ?? ''} {required} />

	{#if open && filtered.length > 0}
		<ul role="listbox" id={listboxId} class="options">
			{#each filtered as p, i (p.id)}
				<li
					role="option"
					id="{id}-opt-{i}"
					aria-selected={value === p.id}
					class:active={i === activeIndex}
					onmousedown={(e) => {
						// Prevent input blur from firing before click registers.
						e.preventDefault();
						selectPerson(p);
					}}
				>
					<span class="opt-name">{p.display_name}</span>
					{#if p.full_name && p.full_name !== p.display_name}
						<span class="opt-full">{p.full_name}</span>
					{/if}
					{#if p.relationship}
						<span class="opt-rel">{p.relationship}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if open && query.trim()}
		<ul role="listbox" id={listboxId} class="options empty">
			<li role="option" aria-selected="false" aria-disabled="true" class="no-match">
				No matches for "{query}"
			</li>
		</ul>
	{/if}
</div>

<style>
	.person-picker {
		position: relative;
		display: block;
	}

	input[type='text'] {
		width: 100%;
		min-height: 48px;
		padding: 12px 14px;
		font-family: var(--font-sans);
		font-size: 18px;
		color: var(--ink);
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: 14px;
		box-sizing: border-box;
	}
	input[type='text']:focus {
		outline: 2px solid var(--green);
		outline-offset: -1px;
	}
	input[type='text']:disabled {
		background: var(--bg);
		color: var(--muted);
	}

	.options {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		max-height: 320px;
		overflow-y: auto;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: 14px;
		box-shadow: var(--shadow);
		list-style: none;
		margin: 0;
		padding: 4px;
		z-index: 50;
	}

	.options li {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-height: 48px;
		padding: 10px 12px;
		border-radius: 10px;
		font-family: var(--font-sans);
		font-size: 16px;
		color: var(--ink);
		cursor: pointer;
	}
	.options li.active,
	.options li:hover {
		background: var(--green-soft);
	}
	.options li.no-match {
		color: var(--muted);
		font-style: italic;
		cursor: default;
	}

	.opt-name {
		font-weight: 600;
	}
	.opt-full {
		font-size: 14px;
		color: var(--muted);
	}
	.opt-rel {
		font-size: 13px;
		color: var(--green);
		margin-left: auto;
		flex-shrink: 0;
	}
</style>
