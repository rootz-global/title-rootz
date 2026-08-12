/**
 * PM2 ecosystem for title.rootz.global (commercial-readiness C3).
 *
 * Captures the title-records process config in git so a box rebuild reproduces it
 * — previously this lived only in the box's `pm2 save` dump (deploy drift). The
 * `--max-memory-restart` guard is the safety belt for the /api/fl/search memory
 * recycles (see PLAN-commercial-readiness.md Workstream C); the real fix for the
 * recycle RATE is a per-request-memory refactor / horizontal scaling (escalated).
 *
 * Reproduce on a fresh box:
 *   cd /var/www/title-rootz-v2 && pm2 start ecosystem.config.cjs && pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'title-records',
      script: 'src/server.js',
      cwd: '/var/www/title-rootz-v2',
      // Node loads .env at runtime (Node >=20 --env-file); this is why CENSUS_API_KEY
      // etc. are present without a dotenv package.
      node_args: '--env-file=.env',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1600M',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PORT: '3035',
      },
      // logs → PM2 default (~/.pm2/logs) for the running user
    },
  ],
};
