<script lang="ts">
	import type { LayoutData } from './$types';
	import BottomNav from '$components/BottomNav.svelte';

	interface Props {
		data: LayoutData;
		children?: import('svelte').Snippet;
	}

	let { data, children }: Props = $props();
</script>

{@render children?.()}

<BottomNav role={data.user.role} />
