'use strict';

const { workerData, parentPort } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../data/ResearchStore');
const { attachRawTradeReadView } = require('../data/RawTradeShardManager');
const { runBacktest } = require('../core/FlowBacktester');

let db;
try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 1000');
  db.pragma('cache_size = -8192');
  attachRawTradeReadView(db, { dbPath: workerData.dbPath, readDays: workerData.rawShardReadDays });
  db.pragma('query_only = ON');
  const store = Object.create(ResearchStore.prototype);
  Object.assign(store, { db, dashboardStatsCache: new Map() });
  let value;
  if (workerData.task === 'backtest') {
    value = runBacktest(db, workerData.args);
  } else if (workerData.task === 'migrationSecondLegDashboard') {
    value = store.migrationSecondLegDashboard({ ...workerData.args, cacheStats: false });
  } else if (workerData.task === 'launchPullbackDashboardBundle') {
    value = { timeSessions: store.shadowTimeSessionDashboard('launch-pullback'),
      dashboard: store.launchPullbackShadowDashboard({ ...workerData.args, cacheStats: false }) };
  } else throw new Error('Unsupported research task');
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally {
  db?.close();
  parentPort.close();
}
