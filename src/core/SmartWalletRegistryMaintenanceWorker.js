'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { SmartWalletRegistry } = require('./SmartWalletRegistry');

function run() {
  const { dbPath, config, task } = workerData;
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 30000');
  const store = { db, config: { dbPath } };
  try {
    const registry = new SmartWalletRegistry({
      config: { ...config, maintenanceWorkerEnabled: false },
      store,
      now: () => task.at,
      fetchImpl: null,
      transactionParser: null,
    });
    let value;
    if (task.type === 'CLUSTERS') {
      value = registry.refreshClusters(task.at, { force: true });
    } else if (task.type === 'GRADES') {
      registry.refreshGrades(task.at, task.options || {});
      value = {
        wallets: db.prepare('SELECT COUNT(*) count FROM smart_wallet_registry').get().count,
      };
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
