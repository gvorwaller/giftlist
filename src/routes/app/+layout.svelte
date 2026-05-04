<script lang="ts">
	import type { LayoutData } from './$types';
	import BottomNav from '$components/BottomNav.svelte';
	import SignedInBar from '$components/SignedInBar.svelte';
	import PreviewBanner from '$components/PreviewBanner.svelte';

	interface Props {
		data: LayoutData;
		children?: import('svelte').Snippet;
	}

	let { data, children }: Props = $props();
</script>

{#if data.previewAsManager}
	<PreviewBanner adminDisplayName={data.adminDisplayName ?? ''} />
{/if}

<div class:with-preview={data.previewAsManager}>
	{@render children?.()}
</div>

<SignedInBar
	displayName={data.previewAsManager
		? `${data.adminDisplayName ?? 'Admin'} (viewing as ${data.user.display_name})`
		: data.user.display_name}
/>
<BottomNav role={data.previewAsManager ? 'manager' : data.user.role} />

<style>
	/* Push page content down so the fixed preview banner doesn't cover the
	   sticky page header on the manager screens. */
	.with-preview {
		padding-top: 56px;
	}
</style>
