'use strict';

require('dotenv').config();
const { config } = require('../src/config');

// Operational readiness must stay O(1). Detailed /api/health statistics are
// served from a background database snapshot and are not a liveness probe.
const url = `http://127.0.0.1:${config.server.port}/health`;
fetch(url)
  .then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    console.log(JSON.stringify(health, null, 2));
    if (health.status !== 'streaming') process.exitCode = 1;
  })
  .catch((error) => {
    console.error(`Flow service is unavailable at ${url}: ${error.message}`);
    process.exitCode = 1;
  });
