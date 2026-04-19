<script lang="ts">
	import type { Role } from '$server/types';
	import { page } from '$app/stores';

	interface NavItem {
		label: string;
		href: string;
	}

	interface Props {
		role: Role;
	}

	let { role }: Props = $props();

	const MANAGER_ITEMS: NavItem[] = [
		{ label: 'Today', href: '/app/today' },
		{ label: 'People', href: '/app/people' },
		{ label: 'Packages', href: '/app/packages' }
	];

	const ADMIN_ITEMS: NavItem[] = [
		{ label: 'Home', href: '/admin' },
		{ label: 'People', href: '/admin/people' },
		{ label: 'Imports', href: '/admin/imports' },
		{ label: 'Settings', href: '/admin/settings' }
	];

	let items = $derived(role === 'admin' ? ADMIN_ITEMS : MANAGER_ITEMS);

	function isActive(href: string, pathname: string): boolean {
		if (href === pathname) return true;
		return pathname.startsWith(href + '/');
	}
</script>

<nav class="bottom-nav" aria-label="Primary">
	{#each items as item (item.href)}
		<a
			href={item.href}
			class="nav-item"
			class:active={isActive(item.href, $page.url.pathname)}
			aria-current={isActive(item.href, $page.url.pathname) ? 'page' : undefined}
		>
			{item.label}
		</a>
	{/each}
</nav>

<style>
	.bottom-nav {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		background: rgba(255, 253, 248, 0.96);
		backdrop-filter: blur(10px);
		border-top: 1px solid var(--line);
		padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
		z-index: 20;
	}

	.nav-item {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap-target);
		padding: 8px 12px;
		color: var(--muted);
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		text-decoration: none;
		border-radius: var(--radius-control);
	}

	.nav-item.active {
		color: var(--green);
		background: var(--green-soft);
	}
</style>
