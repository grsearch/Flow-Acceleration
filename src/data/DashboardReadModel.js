'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');

function initializeDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 100');
    db.pragma('journal_size_limit = 8388608');
    db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_snapshots (
        snapshot_key TEXT PRIMARY KEY,
        generated_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dashboard_refresh_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        started_at INTEGER,
        completed_at INTEGER,
        fast_refreshes INTEGER NOT NULL DEFAULT 0,
        shadow_refreshes INTEGER NOT NULL DEFAULT 0,
        slow_refreshes INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO dashboard_refresh_state(id, updated_at) VALUES(1, 0);
    `);
    const stateColumns = new Set(db.pragma('table_info(dashboard_refresh_state)').map((row) => row.name));
    if (!stateColumns.has('shadow_refreshes')) {
      db.exec('ALTER TABLE dashboard_refresh_state ADD COLUMN shadow_refreshes INTEGER NOT NULL DEFAULT 0');
    }
  } finally {
    db.close();
  }
}

class DashboardReadModel {
  constructor({
    config = {}, storage = {}, smartWallets = [], liveStrategies = [], shadowSettings = {},
    smartWalletRegistryConfig = {}, smartWalletConsensusOverlayConfig = {},
  } = {}) {
    this.config = config;
    this.storage = storage;
    this.sourceDbPath = storage.dbPath === ':memory:' ? ':memory:' : path.resolve(storage.dbPath);
    this.enabled = config.enabled !== false && this.sourceDbPath !== ':memory:';
    this.dbPath = this.enabled ? path.resolve(config.dbPath || './data/flow-dashboard.db') : null;
    if (this.enabled && this.dbPath === this.sourceDbPath) {
      throw new Error('Dashboard snapshot database must differ from the realtime research database');
    }
    this.smartWallets = [...new Set(smartWallets.filter(Boolean))];
    this.liveStrategyIds = [...new Set(liveStrategies.map((row) => row?.id).filter(Boolean))];
    this.shadowSettings = shadowSettings;
    this.smartWalletRegistryConfig = smartWalletRegistryConfig;
    this.smartWalletConsensusOverlayConfig = smartWalletConsensusOverlayConfig;
    this.reader = null;
    this.worker = null;
    this.memory = new Map();
    this.metrics = {
      startedAt: null,
      lastFastRefreshAt: null,
      lastShadowRefreshAt: null,
      lastSlowRefreshAt: null,
      lastFastRefreshMs: null,
      lastShadowRefreshMs: null,
      lastSlowRefreshMs: null,
      refreshErrors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      staleReads: 0,
      lastError: null,
    };
    if (this.enabled) {
      initializeDatabase(this.dbPath);
      this.reader = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      this.reader.pragma('query_only = ON');
      this.reader.pragma('busy_timeout = 1000');
      this.reader.pragma(`cache_size = -${Math.max(2_000, Number(config.cacheSizeKb) || 16_384)}`);
      this.readStatement = this.reader.prepare(`
        SELECT generated_at, duration_ms, payload_json
        FROM dashboard_snapshots WHERE snapshot_key=?
      `);
      this.stateStatement = this.reader.prepare('SELECT * FROM dashboard_refresh_state WHERE id=1');
    }
  }

  start() {
    if (!this.enabled || this.worker) return;
    this.metrics.startedAt = Date.now();
    const worker = new Worker(path.join(__dirname, 'dashboard-preaggregate-worker.js'), {
      workerData: {
        sourceDbPath: this.sourceDbPath,
        dashboardDbPath: this.dbPath,
        smartWallets: this.smartWallets,
        liveStrategyIds: this.liveStrategyIds,
        shadowSettings: this.shadowSettings,
        smartWalletRegistryConfig: this.smartWalletRegistryConfig,
        smartWalletConsensusOverlayConfig: this.smartWalletConsensusOverlayConfig,
        fastRefreshMs: this.config.fastRefreshMs,
        shadowRefreshMs: this.config.shadowRefreshMs,
        slowRefreshMs: this.config.slowRefreshMs,
        cacheSizeKb: this.config.cacheSizeKb,
        sourceCacheSizeKb: Math.min(
          65_536,
          Math.max(2_000, Number(this.storage.cacheSizeKb) || 32_768),
        ),
        rawShardReadDays: this.storage.rawShardReadDays,
      },
    });
    this.worker = worker;
    worker.on('message', (message) => {
      if (message?.type === 'REFRESH') {
        const key = message.tier === 'SLOW'
          ? 'Slow'
          : (message.tier === 'SHADOW' ? 'Shadow' : 'Fast');
        this.metrics[`last${key}RefreshAt`] = message.completedAt;
        this.metrics[`last${key}RefreshMs`] = message.durationMs;
        if (!message.ok) {
          this.metrics.refreshErrors += 1;
          this.metrics.lastError = message.error;
        } else {
          this.metrics.lastError = null;
          for (const snapshot of message.snapshots || []) this.memory.delete(snapshot.key);
        }
      }
    });
    worker.on('error', (error) => {
      this.metrics.refreshErrors += 1;
      this.metrics.lastError = error.message;
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0) {
        this.metrics.refreshErrors += 1;
        this.metrics.lastError = `dashboard preaggregation worker exited with code ${code}`;
      }
    });
  }

  read(key) {
    if (!this.enabled) return null;
    try {
      const row = this.readStatement.get(key);
      if (!row) {
        this.metrics.cacheMisses += 1;
        return null;
      }
      let cached = this.memory.get(key);
      if (!cached || cached.generatedAt !== row.generated_at) {
        cached = {
          generatedAt: row.generated_at,
          durationMs: row.duration_ms,
          value: JSON.parse(row.payload_json),
        };
        this.memory.set(key, cached);
      }
      this.metrics.cacheHits += 1;
      if (Date.now() - cached.generatedAt > (Number(this.config.maxSnapshotAgeMs) || 900_000)) {
        this.metrics.staleReads += 1;
      }
      return cached;
    } catch (error) {
      this.metrics.cacheMisses += 1;
      this.metrics.lastError = error.message;
      return null;
    }
  }

  health() {
    let state = null;
    try { state = this.stateStatement?.get() || null; } catch (_) {}
    return {
      enabled: this.enabled,
      mode: this.enabled ? 'INDEPENDENT_READ_MODEL' : 'DIRECT_DATABASE',
      dbPath: this.dbPath,
      workerRunning: Boolean(this.worker),
      snapshots: this.memory.size,
      state,
      ...this.metrics,
    };
  }

  async stop() {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          void worker.terminate().finally(resolve);
        }, 2_000);
        worker.once('message', (message) => {
          if (message?.type !== 'STOPPED') return;
          clearTimeout(timer);
          resolve();
        });
        worker.postMessage({ type: 'STOP' });
      });
    }
    if (this.reader) this.reader.close();
    this.reader = null;
    this.memory.clear();
  }
}

module.exports = { DashboardReadModel, initializeDatabase };
