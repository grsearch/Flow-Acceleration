'use strict';
const path = require('path');
const { Worker } = require('worker_threads');

// Worker-only utility. HTTP read/health never open or query SQLite.
function initializeDatabase(filePath, sourceDbPath = null) {
  const fs = require('fs');
  if (sourceDbPath) {
    const source = fs.statSync(sourceDbPath);
    if (fs.existsSync(filePath)) {
      const target = fs.statSync(filePath);
      if (target.dev === source.dev && target.ino === source.ino) {
        throw new Error('Dashboard snapshot database aliases the realtime database');
      }
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new (require('better-sqlite3'))(filePath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 100');
  db.pragma('journal_size_limit = 8388608');
  db.exec(`CREATE TABLE IF NOT EXISTS dashboard_snapshots (
    snapshot_key TEXT PRIMARY KEY, generated_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL, payload_json TEXT NOT NULL)`);
  return db;
}

class DashboardReadModel {
  constructor({ config = {}, storage = {}, smartWallets = [], liveStrategies = [],
    shadowSettings = {}, shadowConfigs = {}, smartWalletRegistryConfig = {},
    smartWalletConsensusOverlayConfig = {}, workerFactory = (file, options) => new Worker(file, options),
    now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.workerFactory = workerFactory;
    this.maxSnapshotBytes = Math.max(1024, Number(config.maxSnapshotBytes) || 4 * 1024 * 1024);
    this.maxMemoryBytes = Math.max(1024, Number(config.maxMemoryBytes) || 32 * 1024 * 1024);
    this.memoryBytes = 0;
    this.sourceDbPath = storage.dbPath === ':memory:' ? ':memory:' : path.resolve(storage.dbPath);
    this.enabled = config.enabled !== false && this.sourceDbPath !== ':memory:';
    this.dbPath = this.enabled ? path.resolve(config.dbPath || './data/flow-dashboard.db') : null;
    if (this.enabled && this.dbPath === this.sourceDbPath) {
      throw new Error('Dashboard snapshot database must differ from the realtime research database');
    }
    this.workerData = { sourceDbPath: this.sourceDbPath, dashboardDbPath: this.dbPath,
      smartWallets: [...new Set(smartWallets.filter(Boolean))],
      liveStrategies: [...new Map(liveStrategies.filter((row) => row?.id).map((row) =>
        [row.id, { id: row.id, enabled: row.enabled, entryEnabled: row.entryEnabled }])).values()],
      shadowSettings, shadowConfigs, smartWalletRegistryConfig, smartWalletConsensusOverlayConfig,
      fastRefreshMs: config.fastRefreshMs, shadowRefreshMs: config.shadowRefreshMs,
      slowRefreshMs: config.slowRefreshMs, idleStrategyRefreshMs: config.idleStrategyRefreshMs,
      cacheSizeKb: config.cacheSizeKb, queryBudgetMs: config.queryBudgetMs,
      maxSnapshotBytes: this.maxSnapshotBytes,
      sourceCacheSizeKb: Math.min(65536, Math.max(2000, Number(storage.cacheSizeKb) || 32768)),
      rawShardReadDays: storage.rawShardReadDays };
    this.memory = new Map();
    this.keyErrors = new Map();
    this.lanes = new Map();
    this.stopping = false;
    this.started = false;
    this.watchdog = null;
    this.metrics = { startedAt: null, lastFastRefreshAt: null, lastShadowRefreshAt: null,
      lastSlowRefreshAt: null, lastFastRefreshMs: null, lastShadowRefreshMs: null,
      lastSlowRefreshMs: null, lastFastError: null, lastShadowError: null, lastSlowError: null,
      refreshErrors: 0, cacheHits: 0, cacheMisses: 0, staleReads: 0, lastError: null,
      workerRestarts: 0, watchdogTimeouts: 0, hydratedSnapshots: 0,
      memoryEvictions: 0, memoryRejected: 0, oversizedSnapshots: 0 };
  }

  start() {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.stopping = false;
    this.metrics.startedAt = this.now();
    for (const name of ['FAST', 'HISTORY']) {
      const lane = { name, worker: null, failures: 0, restartTimer: null,
        lastMessageAt: this.now(), currentKey: null, state: 'STARTING', cooldowns: new Map() };
      this.lanes.set(name, lane);
      this._spawn(lane);
    }
    this.watchdog = setInterval(() => this._checkWatchdog(), 1000);
    this.watchdog.unref?.();
  }

  _spawn(lane) {
    if (this.stopping || lane.worker) return;
    lane.state = 'STARTING';
    lane.lastMessageAt = this.now();
    lane.currentKey = null;
    let worker;
    try { worker = this.workerFactory(path.join(__dirname, 'dashboard-preaggregate-worker.js'), {
      workerData: { ...this.workerData, lane: lane.name, deferUntil: Object.fromEntries(lane.cooldowns) },
      resourceLimits: { maxOldGenerationSizeMb: Math.max(32, lane.name === 'FAST'
        ? Number(this.config.fastWorkerHeapMb) || 128 : Number(this.config.historyWorkerHeapMb) || 256) },
    }); } catch (error) { this._failed(lane, error); return; }
    lane.worker = worker;
    worker.on('message', (message) => {
      if (lane.worker !== worker || this.stopping) return;
      lane.lastMessageAt = this.now();
      if (message.type === 'TASK_START') {
        lane.currentKey = message.key;
        lane.currentTier = message.tier;
        lane.state = 'COMPUTING';
      } else if (message.type === 'SNAPSHOT') {
        const accepted = this._cacheSnapshot(message);
        if (accepted && !message.hydrated) this.keyErrors.delete(message.key);
        if (accepted && message.hydrated) this.metrics.hydratedSnapshots += 1;
        else if (accepted) {
          lane.failures = 0;
          lane.cooldowns.delete(message.key);
          const tier = message.tier === 'SLOW' ? 'Slow' : message.tier === 'SHADOW' ? 'Shadow' : 'Fast';
          this.metrics[`last${tier}RefreshAt`] = this.now();
          this.metrics[`last${tier}RefreshMs`] = message.durationMs;
          this.metrics[`last${tier}Error`] = null;
        }
        lane.currentKey = null;
        lane.state = 'RUNNING';
      } else if (message.type === 'KEY_ERROR') {
        this.keyErrors.set(message.key, { error: message.error, at: this.now(), tier: message.tier });
        this.metrics.refreshErrors += 1;
        const tier = message.tier === 'SLOW' ? 'Slow' : message.tier === 'SHADOW' ? 'Shadow' : 'Fast';
        this.metrics[`last${tier}Error`] = message.error;
        lane.currentKey = null;
        lane.state = 'RUNNING';
      } else if (message.type === 'HEARTBEAT') {
        lane.stats = message.stats;
        lane.state = lane.currentKey ? 'COMPUTING' : 'RUNNING';
      }
      this.metrics.lastError = [...this.keyErrors.values()][0]?.error
        || [...this.lanes.values()].find((item) => item.lastError)?.lastError || null;
      for (const tier of ['Fast', 'Shadow', 'Slow']) {
        this.metrics[`last${tier}Error`] = [...this.keyErrors.values()]
          .find((failure) => failure.tier === tier.toUpperCase())?.error || null;
      }
    });
    worker.on('error', (error) => { if (lane.worker === worker) this._failed(lane, error); });
    worker.on('exit', (code) => {
      if (lane.worker !== worker) return;
      lane.worker = null;
      if (!this.stopping) this._failed(lane, new Error(`dashboard ${lane.name} worker exited (${code})`));
    });
  }

  _cacheSnapshot(message) {
    // Serialized byte counts are supplied by the worker. Never stringify a
    // payload on the HTTP owner just to account for memory. The conservative
    // fixture fallback is used only by old/fake message producers.
    const bytes = Number.isSafeInteger(message.payloadBytes) && message.payloadBytes >= 0
      ? Math.max(1, message.payloadBytes) : 1024;
    const reject = (error) => {
      this.keyErrors.set(message.key, { error, at: this.now(), tier: message.tier });
      this.metrics.refreshErrors += 1;
      return false;
    };
    if (bytes > this.maxSnapshotBytes) {
      this.metrics.oversizedSnapshots += 1;
      return reject('SNAPSHOT_TOO_LARGE');
    }
    const oldBytes = this.memory.get(message.key)?.payloadBytes || 0;
    const required = this.memoryBytes - oldBytes + bytes - this.maxMemoryBytes;
    if (required > 0) {
      const candidates = [...this.memory.entries()].filter(([key, row]) => (
        key !== message.key && row.tier !== 'FAST'
      )).sort((a, b) => a[1].generatedAt - b[1].generatedAt);
      if (candidates.reduce((sum, [, row]) => sum + row.payloadBytes, 0) < required) {
        this.metrics.memoryRejected += 1;
        return reject('SNAPSHOT_MEMORY_CAPACITY');
      }
      for (const [key, row] of candidates) {
        if (this.memoryBytes - oldBytes + bytes <= this.maxMemoryBytes) break;
        this.memory.delete(key);
        this.memoryBytes -= row.payloadBytes;
        this.metrics.memoryEvictions += 1;
        this.keyErrors.set(key, { error: 'SNAPSHOT_EVICTED_CAPACITY', at: this.now(), tier: row.tier });
      }
    }
    this.memory.set(message.key, { value: message.value, generatedAt: message.generatedAt,
      durationMs: message.durationMs, hydrated: Boolean(message.hydrated), payloadBytes: bytes,
      tier: message.tier || (message.key.startsWith('live-trading:') ? 'FAST' : 'SHADOW'),
      queueWaitMs: message.queueWaitMs || 0, nextRefreshAt: message.nextRefreshAt || null });
    this.memoryBytes += bytes - oldBytes;
    return true;
  }

  _failed(lane, error) {
    if (this.stopping || lane.restartTimer || lane.recovering) return;
    lane.recovering = true;
    const worker = lane.worker;
    lane.worker = null;
    const terminated = worker ? worker.terminate().catch(() => {}) : Promise.resolve();
    lane.termination = terminated;
    lane.lastError = error.message;
    lane.state = 'BACKOFF';
    lane.failures += 1;
    this.metrics.refreshErrors += 1;
    this.metrics.lastError = error.message;
    if (lane.currentKey) {
      this.keyErrors.set(lane.currentKey, { error: error.message, at: this.now(),
        tier: lane.currentTier || (lane.name === 'FAST' ? 'FAST' : 'SHADOW') });
      lane.cooldowns.set(lane.currentKey, this.now() + (Number(this.config.hangCooldownMs) || 300000));
    }
    const delay = Math.min(Number(this.config.restartMaxMs) || 60000,
      (Number(this.config.restartBaseMs) || 1000) * 2 ** Math.min(lane.failures - 1, 8));
    lane.restartAt = this.now() + delay;
    // Never start the replacement while a wedged predecessor is still alive.
    void terminated.then(() => {
      lane.recovering = false;
      if (this.stopping) return;
      lane.restartTimer = setTimeout(() => {
        lane.restartTimer = null;
        if (this.stopping) return;
        this.metrics.workerRestarts += 1;
        lane.lastError = null;
        this._spawn(lane);
      }, delay);
      lane.restartTimer.unref?.();
    });
  }

  _checkWatchdog() {
    if (this.stopping) return;
    for (const lane of this.lanes.values()) {
      const timeout = Math.max(1000, Number(this.config.workerTimeoutMs)
        || (lane.name === 'FAST' ? 120000 : 180000));
      if (lane.worker && this.now() - lane.lastMessageAt > timeout) {
        this.metrics.watchdogTimeouts += 1;
        this._failed(lane, new Error(`dashboard ${lane.name} timed out at ${lane.currentKey || 'startup'}`));
      }
    }
  }

  read(key) {
    if (!this.enabled) return null;
    const cached = this.memory.get(key);
    if (!cached) {
      this.metrics.cacheMisses += 1;
      const failure = this.keyErrors.get(key);
      return failure ? { value: null, generatedAt: null, status: 'ERROR', error: failure.error } : null;
    }
    this.metrics.cacheHits += 1;
    const ageMs = Math.max(0, this.now() - cached.generatedAt);
    const error = this.keyErrors.get(key)?.error || null;
    const stale = ageMs > (Number(this.config.maxSnapshotAgeMs) || 900000);
    if (stale) this.metrics.staleReads += 1;
    return { ...cached, ageMs, error, status: error ? 'ERROR' : stale ? 'STALE' : 'READY' };
  }

  health() {
    return { enabled: this.enabled, mode: this.enabled ? 'INDEPENDENT_READ_MODEL' : 'DIRECT_DATABASE',
      dbPath: this.dbPath, workerRunning: [...this.lanes.values()].some((lane) => Boolean(lane.worker)),
      snapshots: this.memory.size, ...this.metrics,
      memoryBytes: this.memoryBytes, maxMemoryBytes: this.maxMemoryBytes,
      maxSnapshotBytes: this.maxSnapshotBytes, memoryAccounting: 'SERIALIZED_PAYLOAD_BYTES',
      workers: [...this.lanes.values()].map(({ name, worker, state, currentKey, lastMessageAt,
        lastError, restartAt, stats, cooldowns }) => ({ name, running: Boolean(worker), state, currentKey,
        lastMessageAt, lastError: lastError || null, restartAt, stats,
        timeoutMs: Number(this.config.workerTimeoutMs) || (name === 'FAST' ? 120000 : 180000),
        deferredUntil: Object.fromEntries(cooldowns) })),
      keyErrors: Object.fromEntries(this.keyErrors) };
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    clearInterval(this.watchdog);
    this.watchdog = null;
    await Promise.all([...this.lanes.values()].map(async (lane) => {
      clearTimeout(lane.restartTimer);
      lane.restartTimer = null;
      const worker = lane.worker;
      lane.worker = null;
      lane.state = 'STOPPED';
      if (!worker) { await lane.termination; return; }
      await new Promise((resolve) => {
        const timer = setTimeout(() => { void worker.terminate().finally(resolve); }, 2000);
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
        worker.on('message', (message) => {
          if (message.type === 'STOPPED') { clearTimeout(timer); resolve(); }
        });
        worker.postMessage({ type: 'STOP' });
      });
    }));
  }
}

module.exports = { DashboardReadModel, initializeDatabase };
