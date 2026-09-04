'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { ResearchStore } = require('./ResearchStore');
const { attachRawTradeReadView } = require('./RawTradeShardManager');

function main() {
  const db = new Database(workerData.dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma(`cache_size = -${Math.max(2_000, Number(workerData.cacheSizeKb) || 16_384)}`);
    attachRawTradeReadView(db, {
      dbPath: workerData.dbPath,
      readDays: workerData.rawShardReadDays,
    });
    db.pragma('query_only = ON');
    // Reuse the canonical aggregate queries without constructing a live store,
    // starting timers, running migrations, or touching the writer connection.
    const snapshot = ResearchStore.prototype.health.call({
      db,
      metrics: {},
      rawBuffer: [],
      config: { dbPath: workerData.dbPath },
    });
    parentPort.postMessage({ ok: true, snapshot });
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.stack || error?.message || String(error),
  });
}
