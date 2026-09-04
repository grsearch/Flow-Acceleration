'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { SmartWalletRegistry } = require('./SmartWalletRegistry');

function run() {
  const { dbPath, config, task } = workerData;
  // The worker owns the expensive historical scans, not database mutations.
  // Keeping this connection read-only leaves the realtime ResearchStore as the
  // sole writer and removes recurring SQLITE_BUSY collisions.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 30000');
  const store = { db, config: { dbPath } };
  try {
    const registry = new SmartWalletRegistry({
      config: {
        ...config,
        maintenanceWorkerEnabled: false,
        skipStorageInit: true,
      },
      store,
      now: () => task.at,
      fetchImpl: null,
      transactionParser: null,
    });
    let value;
    if (task.type === 'CLUSTERS') {
      value = registry.refreshClusters(task.at, { force: true, collectOnly: true });
    } else if (task.type === 'GRADES') {
      value = registry.refreshGrades(task.at, {
        ...(task.options || {}),
        collectOnly: true,
      });
    } else {
      throw new Error(`Unsupported Smart Wallet maintenance task: ${task.type}`);
    }
    db.close();
    parentPort.postMessage({ ok: true, type: task.type, value });
  } catch (error) {
    try { db.close(); } catch (_) {}
    throw error;
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
