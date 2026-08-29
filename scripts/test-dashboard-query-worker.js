'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchStore } = require('../src/data/ResearchStore');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dashboard-worker-'));
  const dbPath = path.join(directory, 'research.db');
  const store = new ResearchStore({
    dbPath,
    archiveDir: directory,
    rawRetentionHours: 48,
    flushMs: 60_000,
    flushMax: 100,
  }, {
    configuredTradingCostPct: 1.4,
  });

  try {
    const migration = await store.dashboardQueryInWorker(
      'migrationSecondLegDashboard',
      { observationLimit: 5, snapshotLimit: 5, statsSnapshotLimit: 10000 },
      { firstWaitMs: 10_000 },
    );
    assert.strictEqual(migration.dashboardQuery.status, 'READY');
    assert.ok(Array.isArray(migration.observations));
    assert.ok(Array.isArray(migration.shadow.cohorts));

    const launch = await store.dashboardQueryInWorker(
      'launchPullbackDashboardBundle',
      { positionLimit: 5, bigWinnerPct: 50 },
      { firstWaitMs: 10_000 },
    );
    assert.strictEqual(launch.dashboardQuery.status, 'READY');
    assert.ok(Array.isArray(launch.timeSessions.sessions));
    assert.ok(Array.isArray(launch.dashboard.cohorts));

    const cached = await store.dashboardQueryInWorker(
      'launchPullbackDashboardBundle',
      { positionLimit: 5, bigWinnerPct: 50 },
    );
    assert.strictEqual(cached.dashboardQuery.source, 'CACHE');
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log('test-dashboard-query-worker: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
