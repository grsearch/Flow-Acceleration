'use strict';

const path = require('path');

module.exports = {
  apps: [{
    name: 'flow-acceleration-research',
    cwd: path.resolve(__dirname, '..'),
    script: 'src/index.js',
    watch: false,
    autorestart: true,
    restart_delay: 5_000,
    min_uptime: '30s',
    max_restarts: 10,
    kill_timeout: 20_000,
    max_memory_restart: '1500M',
    env: { NODE_ENV: 'production' },
  }],
};

