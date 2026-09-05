'use strict';

const path = require('path');

// Research/debug sessions only. Managed live collection must use the systemd
// unit and deploy/safe-update.sh, which preserve a failed write drain.
// PM2 sends SIGKILL after kill_timeout; increasing that timeout cannot guarantee
// a completed drain. Do not use PM2 restart/reload as a production update path.
module.exports = {
  apps: [{
    name: 'flow-acceleration-research',
    cwd: path.resolve(__dirname, '..'),
    script: 'src/index.js',
    watch: false,
    autorestart: false,
    restart_delay: 5_000,
    min_uptime: '30s',
    max_restarts: 10,
    kill_timeout: 20_000,
    env: { NODE_ENV: 'production' },
  }],
};
