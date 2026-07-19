// PM2 ecosystem config for the giftlist-cv instance (Caleb & Debbie's family).
// Port 3005 (3000-3004 are taken by gaylonphotos, giftlist, madonnahist,
// birds, trips on the shared droplet). Same repo, separate checkout at
// /opt/giftlist-cv with its own .env and SQLite file — full data isolation
// by construction (see docs/2026-07-19-multiuser-households-plan.md, Option B).
//
// One-time start on the droplet (after clone + .env + build + seed):
//   pm2 start ecosystem-cv.config.cjs
//   pm2 save
//
// Secrets live in /opt/giftlist-cv/.env, loaded via dotenv at app boot.

module.exports = {
	apps: [
		{
			name: 'giftlist-cv',
			script: 'build/index.js',
			cwd: '/opt/giftlist-cv',

			// SQLite WAL single-writer constraint — never run cluster mode.
			instances: 1,
			exec_mode: 'fork',

			autorestart: true,
			restart_delay: 5000,
			max_restarts: 10,
			min_uptime: 10_000,
			max_memory_restart: '350M',

			env: {
				NODE_ENV: 'production',
				PORT: 3005,
				HOST: '127.0.0.1'
			},

			error_file: '/var/log/pm2/giftlist-cv-error.log',
			out_file: '/var/log/pm2/giftlist-cv-out.log',
			merge_logs: true,
			time: true
		}
	]
};
