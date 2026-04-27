<script lang="ts">
	import type { LayoutData } from './$types';
	import BottomNav from '$components/BottomNav.svelte';
	import SignedInBar from '$components/SignedInBar.svelte';

	interface Props {
		data: LayoutData;
		children?: import('svelte').Snippet;
	}

	let { data, children }: Props = $props();
</script>

{@render children?.()}

<SignedInBar displayName={data.user.display_name} />
<BottomNav role={data.user.role} />
