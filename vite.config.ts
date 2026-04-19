import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5175,
		strictPort: true
	},
	// better-sqlite3 and argon2 are native modules — keep them external to Vite bundling
	ssr: {
		external: ['better-sqlite3', 'argon2']
	}
});
