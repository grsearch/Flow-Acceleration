'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { attachRawTradeReadView, shanghaiDay } = require('./RawTradeShardManager');
const { initializeDatabase } = require('./DashboardReadModel');
const { createReadStore, createSnapshotTasks } = require('./dashboard-snapshot-tasks');

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

// Reopen the read-only connection on CST day change so raw_trades_all includes
// newly rotated shards and releases retired attachments. No historical rewrite.
class RotatingReadSource {
  constructor(data, now = () => Date.now()) {
    this.data = data;
    this.now = now;
    this.db = null;
    this.day = null;
    this.rotations = 0;
    this.nextMetadataCheckAt = 0;
    this.activeDay = null;
    this.hasShardMetadata = false;
  }
  refresh() {
    const day = shanghaiDay(this.now());
    if (this.db && day === this.day) {
      if (this.now() < this.nextMetadataCheckAt) return false;
      this.nextMetadataCheckAt = this.now() + 30000;
      // The new day's shard can be created just AFTER midnight's first read.
      // Observe the writer's rotation marker without rescanning trade tables.
      const activeDay = this.hasShardMetadata
        ? this.db.prepare('SELECT active_day FROM raw_trade_shard_meta WHERE id=1').get()?.active_day
        : null;
      if (activeDay === this.activeDay) return false;
    }
    const next = new Database(this.data.sourceDbPath, { readonly: true, fileMustExist: true });
    try {
      next.pragma('busy_timeout = 1000');
      next.pragma(`cache_size = -${Math.max(2000, Number(this.data.sourceCacheSizeKb) || 32768)}`);
      attachRawTradeReadView(next, { dbPath: this.data.sourceDbPath,
        readDays: this.data.rawShardReadDays, now: this.now() });
      next.pragma('query_only = ON');
    } catch (error) { next.close(); throw error; }
    this.db?.close();
    this.db = next;
    this.day = day;
    this.hasShardMetadata = Boolean(next.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='raw_trade_shard_meta'`).get());
    this.activeDay = this.hasShardMetadata
      ? next.prepare('SELECT active_day FROM raw_trade_shard_meta WHERE id=1').get()?.active_day : null;
    this.nextMetadataCheckAt = this.now() + 30000;
    this.rotations += 1;
    return true;
  }
  close() { this.db?.close(); this.db = null; }
}

// A synchronous SQL statement cannot yield halfway through. Between keys we
// always yield, and the owner watchdog can terminate this lane at its deadline.
// An expensive key gets a proportional cooldown rather than an overdue loop.
function nextRefreshDelay(intervalMs, durationMs, failures = 0) {
  return Math.max(intervalMs, Math.min(900000, durationMs * 4),
    failures ? Math.min(900000, 10000 * 2 ** Math.min(failures - 1, 6)) : 0);
}

async function run(data, port) {
  let stopped = false;
  let timer = null;
  let wake = null;
  let dashboard;
  const source = new RotatingReadSource(data);
  const maxSnapshotBytes = Math.max(1024, Number(data.maxSnapshotBytes) || 4 * 1024 * 1024);
  const stats = { completed: 0, errors: 0, budgetExceeded: 0, sourceRotations: 0,
    pendingKeys: 0, lastDurationMs: null, maxDurationMs: 0, lastQueueWaitMs: null,
    currentKey: null, lastError: null, maxSnapshotBytes,
    queryBudgetMs: Number(data.queryBudgetMs) || 1000, oversizedSnapshots: 0 };
  const heartbeat = setInterval(() => port.postMessage({ type: 'HEARTBEAT', stats }), 1000);
  const stop = () => { stopped = true; clearTimeout(timer); clearInterval(heartbeat); wake?.(); };
  port.on('message', (message) => {
    if (message.type === 'STOP') stop();
  });
  try {
    dashboard = initializeDatabase(data.dashboardDbPath, data.sourceDbPath);
    dashboard.pragma(`cache_size = -${Math.max(2000, Number(data.cacheSizeKb) || 16384)}`);
    const upsert = dashboard.prepare(`INSERT INTO dashboard_snapshots
      (snapshot_key,generated_at,duration_ms,payload_json) VALUES(?,?,?,?)
      ON CONFLICT(snapshot_key) DO UPDATE SET generated_at=excluded.generated_at,
      duration_ms=excluded.duration_ms,payload_json=excluded.payload_json`);
    const read = dashboard.prepare(`SELECT generated_at,duration_ms,
      length(CAST(payload_json AS BLOB)) AS payload_bytes,
      CASE WHEN length(CAST(payload_json AS BLOB))<=? THEN payload_json ELSE NULL END AS payload_json
      FROM dashboard_snapshots WHERE snapshot_key=?`);
    let tasks = [];
    function rotate() {
      if (!source.refresh()) return;
      const previous = new Map(tasks.map((task) => [task.key, task]));
      const store = createReadStore(source.db, data.sourceDbPath);
      tasks = createSnapshotTasks(store, data).map((task) => ({ ...task,
        dueAt: Math.max(previous.get(task.key)?.dueAt || Date.now(), Number(data.deferUntil?.[task.key]) || 0),
        failures: previous.get(task.key)?.failures || 0 }));
      stats.sourceRotations = source.rotations;
    }
    rotate();
    // Existing snapshots are served before any potentially heavy recomputation.
    for (const task of tasks) {
      if (stopped) break;
      try {
        const row = read.get(maxSnapshotBytes, task.key);
        if (row?.payload_bytes > maxSnapshotBytes) {
          stats.oversizedSnapshots += 1;
          throw new Error('SNAPSHOT_TOO_LARGE');
        }
        if (row) {
          port.postMessage({ type: 'SNAPSHOT', key: task.key, tier: task.tier,
            generatedAt: row.generated_at, durationMs: row.duration_ms,
            value: JSON.parse(row.payload_json), payloadBytes: row.payload_bytes, hydrated: true });
        }
      } catch (error) {
        port.postMessage({ type: 'KEY_ERROR', key: task.key, tier: task.tier,
          error: `hydrate: ${error.message}` });
      }
      await yieldTurn();
    }
    while (!stopped) {
      rotate();
      const now = Date.now();
      const task = tasks.reduce((first, row) => !first || row.dueAt < first.dueAt ? row : first, null);
      stats.pendingKeys = tasks.filter((row) => row.dueAt <= now).length;
      if (!task || task.dueAt > now) {
        await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve,
          Math.min(1000, Math.max(10, task ? task.dueAt - now : 1000))); });
        wake = null;
        continue;
      }
      const startedAt = Date.now();
      const queueWaitMs = Math.max(0, startedAt - task.dueAt);
      stats.currentKey = task.key;
      port.postMessage({ type: 'TASK_START', key: task.key, tier: task.tier, queueWaitMs });
      try {
        const value = task.compute();
        const payload = JSON.stringify(value);
        const payloadBytes = Buffer.byteLength(payload);
        if (payloadBytes > maxSnapshotBytes) {
          stats.oversizedSnapshots += 1;
          throw new Error('SNAPSHOT_TOO_LARGE');
        }
        const generatedAt = Date.now();
        upsert.run(task.key, generatedAt, generatedAt - startedAt, payload);
        const durationMs = Date.now() - startedAt;
        task.failures = 0;
        task.dueAt = Date.now() + nextRefreshDelay(task.intervalMs, durationMs);
        stats.completed += 1;
        stats.lastError = null;
        port.postMessage({ type: 'SNAPSHOT', key: task.key, tier: task.tier, value,
          generatedAt, durationMs, queueWaitMs, payloadBytes, nextRefreshAt: task.dueAt });
      } catch (error) {
        task.failures += 1;
        task.dueAt = Date.now() + nextRefreshDelay(task.intervalMs,
          Date.now() - startedAt, task.failures);
        stats.errors += 1;
        stats.lastError = error.message;
        port.postMessage({ type: 'KEY_ERROR', key: task.key, tier: task.tier, error: error.message });
      }
      stats.lastDurationMs = Date.now() - startedAt;
      stats.maxDurationMs = Math.max(stats.maxDurationMs, stats.lastDurationMs);
      stats.lastQueueWaitMs = queueWaitMs;
      stats.currentKey = null;
      if (stats.lastDurationMs > (Number(data.queryBudgetMs) || 1000)) stats.budgetExceeded += 1;
      await yieldTurn();
    }
  } finally {
    stop();
    source.close();
    dashboard?.close();
    port.postMessage({ type: 'STOPPED' });
    port.close();
  }
}

if (parentPort && workerData) void run(workerData, parentPort).catch((error) => { throw error; });
module.exports = { RotatingReadSource, nextRefreshDelay, run };
