'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { ResearchStore } = require('./ResearchStore');
const { attachRawTradeReadView } = require('./RawTradeShardManager');
const { SmartWalletRegistry } = require('../core/SmartWalletRegistry');
const {
  SmartWalletConsensusOverlayObserver,
} = require('../core/SmartWalletConsensusOverlayObserver');

function initializeDashboardDatabase(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 100');
  db.pragma('journal_size_limit = 8388608');
  db.pragma('busy_timeout = 5000');
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
}

function createReadStore(db, sourceDbPath) {
  const store = Object.create(ResearchStore.prototype);
  store.db = db;
  store.config = { dbPath: sourceDbPath };
  store.metrics = {};
  store.rawBuffer = [];
  store.dashboardStatsCache = new Map();
  return store;
}

function snapshotKey(name, qualifier = null) {
  return qualifier == null || qualifier === '' ? name : `${name}:${qualifier}`;
}

const source = new Database(workerData.sourceDbPath, {
  readonly: true,
  fileMustExist: true,
});
source.pragma('busy_timeout = 5000');
source.pragma(`cache_size = -${Math.max(2_000, Number(workerData.sourceCacheSizeKb) || 32_768)}`);
attachRawTradeReadView(source, {
  dbPath: workerData.sourceDbPath,
  readDays: workerData.rawShardReadDays,
});
source.pragma('query_only = ON');

const dashboard = new Database(workerData.dashboardDbPath);
initializeDashboardDatabase(dashboard);
dashboard.pragma(`cache_size = -${Math.max(2_000, Number(workerData.cacheSizeKb) || 16_384)}`);
const store = createReadStore(source, workerData.sourceDbPath);
const smartWalletRegistry = new SmartWalletRegistry({
  config: {
    ...(workerData.smartWalletRegistryConfig || {}),
    skipStorageInit: true,
    readOnlyDashboard: true,
    maintenanceWorkerEnabled: true,
  },
  store,
});
const smartWalletConsensusOverlay = Object.create(
  SmartWalletConsensusOverlayObserver.prototype,
);
Object.assign(smartWalletConsensusOverlay, {
  config: workerData.smartWalletConsensusOverlayConfig || {},
  store,
  now: () => Date.now(),
  lastSyncAt: 0,
  startedAt: 0,
  metrics: {
    syncs: 0,
    classified: 0,
    consensusPassed: 0,
    sourceRowsUpdated: 0,
    lastActionAt: null,
    lastError: null,
  },
});
const upsert = dashboard.prepare(`
  INSERT INTO dashboard_snapshots(snapshot_key, generated_at, duration_ms, payload_json)
  VALUES(@key, @generatedAt, @durationMs, @payloadJson)
  ON CONFLICT(snapshot_key) DO UPDATE SET
    generated_at=excluded.generated_at,
    duration_ms=excluded.duration_ms,
    payload_json=excluded.payload_json
`);
const updateState = dashboard.prepare(`
  UPDATE dashboard_refresh_state SET
    started_at=COALESCE(@startedAt, started_at),
    completed_at=COALESCE(@completedAt, completed_at),
    fast_refreshes=fast_refreshes+@fastRefreshes,
    shadow_refreshes=shadow_refreshes+@shadowRefreshes,
    slow_refreshes=slow_refreshes+@slowRefreshes,
    last_error=@lastError,
    updated_at=@updatedAt
  WHERE id=1
`);

let stopped = false;
let fastTimer = null;
let shadowTimer = null;
let slowTimer = null;

function materialize(key, compute) {
  const startedAt = Date.now();
  const payload = compute();
  const generatedAt = Date.now();
  upsert.run({
    key,
    generatedAt,
    durationMs: generatedAt - startedAt,
    payloadJson: JSON.stringify(payload),
  });
  return { key, generatedAt, durationMs: generatedAt - startedAt };
}

function runTasks(tasks) {
  const snapshots = [];
  const errors = [];
  for (const [key, compute] of tasks) {
    try {
      snapshots.push(materialize(key, compute));
    } catch (error) {
      errors.push(`${key}: ${error?.stack || error?.message || String(error)}`);
    }
  }
  return { snapshots, lastError: errors.length > 0 ? errors.join('\n') : null };
}

function fastRefresh() {
  if (stopped) return;
  const startedAt = Date.now();
  updateState.run({
    startedAt,
    completedAt: null,
    fastRefreshes: 0,
    shadowRefreshes: 0,
    slowRefreshes: 0,
    lastError: null,
    updatedAt: startedAt,
  });
  const tasks = [
    ['overview', () => store.overview(Date.now(), 0)],
    ['recent-signals', () => store.recentSignals(200)],
  ];
  for (const strategyId of workerData.liveStrategyIds || []) {
    tasks.push([snapshotKey('live-trading', strategyId), () => (
        store.liveTradingDashboard({
          strategyId,
          positionLimit: 100,
          orderLimit: 100,
          decisionLimit: 100,
        })
      )]);
  }
  const { snapshots, lastError } = runTasks(tasks);
  const completedAt = Date.now();
  updateState.run({
    startedAt: null,
    completedAt,
    fastRefreshes: lastError ? 0 : 1,
    shadowRefreshes: 0,
    slowRefreshes: 0,
    lastError,
    updatedAt: completedAt,
  });
  parentPort.postMessage({
    type: 'REFRESH',
    tier: 'FAST',
    ok: !lastError,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    snapshots,
    error: lastError,
  });
}

function shadowRefresh() {
  if (stopped) return;
  const startedAt = Date.now();
  const settings = workerData.shadowSettings || {};
  const bundle = (sessionKey, compute) => () => ({
    timeSessions: store.shadowTimeSessionDashboard(sessionKey),
    ...compute(),
  });
  const { snapshots, lastError } = runTasks([
    ['shadow:primary', bundle('primary-shadow', () => store.primarySignalShadowDashboard({
      positionLimit: 100, cacheStats: true,
    }))],
    ['shadow:flow-first', bundle('flow-first', () => store.flowFirstShadowDashboard({
      positionLimit: 100,
      bigWinnerPct: settings.flowFirstBigWinnerPct ?? 50,
      cacheStats: true,
    }))],
    ['shadow:smart-pullback', bundle('smart-pullback', () => store.smartPullbackShadowDashboard({
      positionLimit: 100,
      bigWinnerPct: settings.smartPullbackBigWinnerPct ?? 50,
      cacheStats: true,
    }))],
    ['shadow:smart-open', bundle('smart-open', () => store.smartOpenShadowDashboard({
      positionLimit: 100,
      bigWinnerPct: settings.smartOpenBigWinnerPct ?? 50,
      cacheStats: true,
    }))],
    ['shadow:launch-quality', () => store.launchQualityDashboard({
      observationLimit: 100, snapshotLimit: 100,
    })],
    ['shadow:migrated-rebound', bundle('migrated-rebound', () => (
      store.migratedDropReboundShadowDashboard({
        positionLimit: 100,
        bigWinnerPct: settings.migratedBigWinnerPct ?? 50,
        cacheStats: true,
      })
    ))],
    ['shadow:holder-growth', bundle('holder-growth', () => store.holderGrowthShadowDashboard({
      positionLimit: 100,
      bigWinnerPct: settings.holderGrowthBigWinnerPct ?? 50,
      cacheStats: true,
    }))],
    ['shadow:quality-leader', bundle('quality-leader', () => store.qualityLeaderShadowDashboard({
      positionLimit: 100,
      bigWinnerPct: settings.qualityLeaderBigWinnerPct ?? 100,
    }))],
    ['shadow:migration-continuity', bundle('migration-continuity', () => (
      store.migrationContinuityShadowDashboard({ positionLimit: 100, cacheStats: true })
    ))],
    ['shadow:bonding-momentum', bundle('bonding-momentum', () => (
      store.bondingCurveMomentumShadowDashboard({
        positionLimit: 100,
        snapshotLimit: 100,
        bigWinnerPct: settings.bondingMomentumBigWinnerPct ?? 50,
        cacheStats: true,
      })
    ))],
    ['shadow:range-scalper', bundle('range-scalper', () => (
      store.rangeScalperShadowDashboard({ positionLimit: 100, cacheStats: true })
    ))],
    ['shadow:flow-smart-confirm', bundle('flow-smart-confirm', () => (
      store.flowSmartConfirmShadowDashboard({ positionLimit: 100, cacheStats: true })
    ))],
    ['shadow:cya-early-pyramid', bundle('cya-early-pyramid', () => (
      store.cyaEarlyPyramidShadowDashboard({ positionLimit: 100, cacheStats: true })
    ))],
    ['shadow:graduation-hold', bundle('graduation-hold', () => (
      store.graduationHoldShadowDashboard({
        positionLimit: 100,
        bigWinnerPct: settings.graduationHoldBigWinnerPct ?? 50,
      })
    ))],
    ['shadow:graduation-acceleration', () => store.graduationAccelerationShadowDashboard({
      positionLimit: 100,
      bigWinnerPct: settings.graduationAccelerationBigWinnerPct ?? 50,
      cacheStats: true,
    })],
  ]);
  const completedAt = Date.now();
  updateState.run({
    startedAt: null,
    completedAt,
    fastRefreshes: 0,
    shadowRefreshes: lastError ? 0 : 1,
    slowRefreshes: 0,
    lastError,
    updatedAt: completedAt,
  });
  parentPort.postMessage({
    type: 'REFRESH',
    tier: 'SHADOW',
    ok: !lastError,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    snapshots,
    error: lastError,
  });
}

function slowRefresh() {
  if (stopped) return;
  const startedAt = Date.now();
  const { snapshots, lastError } = runTasks([
    ['smart-wallets', () => (
      store.smartWalletStats(workerData.smartWallets || [])
    )],
    ['signal-repetition', () => store.signalRepetitionStats()],
    ['smart-wallet-registry', () => smartWalletRegistry.dashboard(100)],
    ['smart-consensus-overlay', () => smartWalletConsensusOverlay.dashboard(100)],
  ]);
  const completedAt = Date.now();
  updateState.run({
    startedAt: null,
    completedAt,
    fastRefreshes: 0,
    shadowRefreshes: 0,
    slowRefreshes: lastError ? 0 : 1,
    lastError,
    updatedAt: completedAt,
  });
  parentPort.postMessage({
    type: 'REFRESH',
    tier: 'SLOW',
    ok: !lastError,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    snapshots,
    error: lastError,
  });
}

parentPort.on('message', (message) => {
  if (message?.type === 'REFRESH_FAST') fastRefresh();
  if (message?.type === 'REFRESH_SHADOW') shadowRefresh();
  if (message?.type === 'REFRESH_SLOW') slowRefresh();
  if (message?.type === 'STOP') {
    stopped = true;
    if (fastTimer) clearInterval(fastTimer);
    if (shadowTimer) clearInterval(shadowTimer);
    if (slowTimer) clearInterval(slowTimer);
    try { source.close(); } catch (_) {}
    try { dashboard.close(); } catch (_) {}
    parentPort.postMessage({ type: 'STOPPED' });
    parentPort.close();
  }
});

fastRefresh();
slowRefresh();
shadowRefresh();
fastTimer = setInterval(fastRefresh, Math.max(1_000, Number(workerData.fastRefreshMs) || 5_000));
shadowTimer = setInterval(
  shadowRefresh,
  Math.max(10_000, Number(workerData.shadowRefreshMs) || 60_000),
);
slowTimer = setInterval(slowRefresh, Math.max(10_000, Number(workerData.slowRefreshMs) || 60_000));

module.exports = { initializeDashboardDatabase, snapshotKey };
