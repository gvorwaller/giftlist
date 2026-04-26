// PM2 ecosystem config. Port 3001 (gaylonphotos occupies 3000 on the shared droplet).
// See cs.md "Production Infrastructure".
//
// Reboot survival on the droplet requires (one-time, as root):
//   pm2 startup systemd            # registers pm2-root.service with systemd
//   pm2 start ecosystem.config.cjs
//   pm2 save                       # snapshots current process list
// systemd then re-launches PM2 on boot, which re-launches giftlist.
//
// Secrets (AUTH_SECRET, GOOGLE_*, SMTP_*, TELEGRAM_*, ENABLE_CRON, etc.)
// live in /opt/giftlist/.env and get loaded at app boot via `dotenv/config`
// imported at the top of src/hooks.server.ts. Don't put secrets here.

module.exports = {
	apps: [
		{
			name: 'giftlist',
			script: 'build/index.js',
			cwd: '/opt/giftlist',

			// SQLite WAL single-writer constraint — never run cluster mode.
			instances: 1,
			exec_mode: 'fork',

			// Crash recovery. PM2 will keep restarting on uncaught throws,
			// backing off restart_delay each time, and stop trying after
			// max_restarts crashes inside min_uptime — defends against tight
			// crash loops (e.g. bad migration, unparseable .env).
			autorestart: true,
			restart_delay: 5000,
			max_restarts: 10,
			min_uptime: 10_000,
			max_memory_restart: '350M',

			env: {
				NODE_ENV: 'production',
				PORT: 3001,
				HOST: '127.0.0.1'
			},

			error_file: '/var/log/pm2/giftlist-error.log',
			out_file: '/var/log/pm2/giftlist-out.log',
			merge_logs: true,
			time: true // prefix log lines with ISO timestamps
		}
	]
};
