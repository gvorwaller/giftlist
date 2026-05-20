import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5175,
		strictPort: true
	},
	// better-sqlite3 and argon2 are native modules — keep them external to Vite bundling
	ssr: {
		external: ['better-sqlite3', 'argon2']
	},
	// Keep vitest out of `.claude/worktrees/` — stale copies of test files
	// with broken tsconfig resolution that crash before any tests run.
	test: {
		include: ['src/**/*.{test,spec}.{ts,js}'],
		exclude: ['.claude/**', 'node_modules/**', 'build/**', '.svelte-kit/**']
	}
});
