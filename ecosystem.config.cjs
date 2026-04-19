// PM2 ecosystem config. Port 3001 (gaylonphotos occupies 3000 on the shared droplet).
// See cs.md "Production Infrastructure".

module.exports = {
	apps: [
		{
			name: 'giftlist',
			script: 'build/index.js',
			cwd: '/opt/giftlist',
			instances: 1, // Single process — SQLite WAL single-writer constraint.
			exec_mode: 'fork',
			env: {
				NODE_ENV: 'production',
				PORT: 3001,
				HOST: '127.0.0.1'
			},
			error_file: '/var/log/pm2/giftlist-error.log',
			out_file: '/var/log/pm2/giftlist-out.log',
			merge_logs: true,
			max_memory_restart: '350M'
		}
	]
};
