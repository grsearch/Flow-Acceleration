'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { ResearchStore } = require('./ResearchStore');

function run() {
  const db = new Database(workerData.dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma('busy_timeout = 5000');

  const prototype = ResearchStore.prototype;
  const store = {
    db,
    dashboardStatsCache: new Map(),
    _cachedDashboardStats: prototype._cachedDashboardStats,
    migrationSecondLegShadowDashboard: prototype.migrationSecondLegShadowDashboard,
  };

  try {
    let value;
    if (workerData.task === 'migrationSecondLegDashboard') {
      value = prototype.migrationSecondLegDashboard.call(store, {
        ...(workerData.args || {}),
        cacheStats: false,
      });
    } else if (workerData.task === 'launchPullbackDashboardBundle') {
      value = {
        timeSessions: prototype.shadowTimeSessionDashboard.call(store, 'launch-pullback'),
        dashboard: prototype.launchPullbackShadowDashboard.call(store, {
          ...(workerData.args || {}),
          cacheStats: false,
        }),
      };
    } else {
      throw new Error(`Unsupported dashboard query task: ${workerData.task}`);
    }
    parentPort.postMessage({ ok: true, value });
  } finally {
    db.close();
  }
}

try {
  run();
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.stack || error?.message || String(error),
  });
}
