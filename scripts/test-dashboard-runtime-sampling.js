'use strict';

const assert = require('assert');
const { SmartWalletRegistry } = require('../src/core/SmartWalletRegistry');
const { SmartWalletConsensusOverlayObserver } = require('../src/core/SmartWalletConsensusOverlayObserver');
const { SmartWalletConsensusFlowRunnerShadowSuite } = require('../src/core/SmartWalletConsensusFlowRunnerShadowSuite');
const { collectRuntime } = require('../src/server/DashboardProcessServer');

let now = 1_900_000_000_000;
let databaseTouches = 0;
const trap = () => { databaseTouches += 1; throw new Error('SQL/refresh forbidden in runtime sampling'); };
const store = { config: { dbPath: 'unused-disk.db' }, healthSnapshot: () => ({ writeStatus: 'OK' }) };
Object.defineProperty(store, 'db', { configurable: true, get: trap });
const registry = new SmartWalletRegistry({
  config: { enabled: true, skipStorageInit: true, maintenanceWorkerEnabled: true },
  store, now: () => now,
});
const originalRefresh = registry._refreshWalletEligibilitySnapshot;
registry._refreshWalletEligibilitySnapshot = trap;
const initialEligibility = registry.walletEligibilitySnapshot;
const initialMetrics = { ...registry.metrics };
const unavailable = registry.health({ includeDatabase: false });
assert.strictEqual(databaseTouches, 0);
assert.strictEqual(unavailable.databaseSnapshot.status, 'UNAVAILABLE');
assert.strictEqual(unavailable.historyComplete, null);
assert.strictEqual(unavailable.historyDailyCredits, null);
assert.strictEqual(unavailable.clusterConfirmedIndependent, null);
assert.strictEqual(unavailable.wallets, null);
assert.strictEqual(unavailable.votingEligible, null);
assert.strictEqual(unavailable.eligibilitySnapshotStatus, 'UNAVAILABLE');
assert.strictEqual(registry.walletEligibilitySnapshot, initialEligibility);
assert.strictEqual(registry.walletEligibilitySnapshotDirty, true);
assert.deepStrictEqual(registry.metrics, initialMetrics, 'sampling must not increment eligibility-read metrics');

// Exercise the ordinary database-backed contract, then prohibit all database access.
const queries = [];
Object.defineProperty(store, 'db', { configurable: true, value: {
  prepare(sql) {
    queries.push(sql);
    return {
      all() { return sql.includes('cluster_evaluations')
        ? [{ status: 'CONFIRMED_INDEPENDENT', count: 5 }]
        : [{ status: 'COMPLETE', count: 3 }]; },
      get() {
        if (sql.includes('SUM(pages_fetched)')) return { pages: 8, credits: 9, transactions: 10, events: 11 };
        if (sql.includes('ledger_complete=0')) return { n: 2 };
        return { wallets_started: 4, pages_fetched: 6, credits_spent: 7 };
      },
      run() { return { changes: 0 }; },
    };
  },
} });
let refreshCalls = 0;
registry._refreshWalletEligibilitySnapshot = () => { refreshCalls += 1; };
Object.assign(initialEligibility, { generatedAt: now, expiresAt: now + 10, registryVersion: 7,
  all: new Map([['wallet', {}]]), monitoring: new Map([['wallet', {}]]),
  voting: new Map([['wallet', {}]]), controlVoting: new Map(),
  clusterCounts: { eligible: 8, selectionA: 3 }, statusCounts: { ACTIVE: 1 },
  pnlCounts: { PNL_PROFITABLE: 1 }, ageCounts: { ELIGIBLE: 1 }, selectionGradeCounts: { S_A: 1 } });
const full = registry.health();
assert.strictEqual(refreshCalls, 1);
assert(queries.length >= 5, 'legacy full health must still perform its complete SQL reads');
assert.strictEqual(full.historyComplete, 3);
assert.strictEqual(full.historyLedgerIncomplete, 2);
assert.strictEqual(full.historyPagesTotal, 8);
assert.strictEqual(full.historyDailyCredits, 7);
assert.strictEqual(full.clusterConfirmedIndependent, 5);
assert.strictEqual(full.active, 1);
assert.strictEqual(full.historyPending, 0, 'known zero remains zero in a complete snapshot');
assert.strictEqual(full.databaseSnapshot.status, 'READY');

Object.defineProperty(store, 'db', { configurable: true, get: trap });
registry._refreshWalletEligibilitySnapshot = trap;
registry._historyDailyUsage = trap;
registry.activeClusterCounts = trap;
registry._activeClusterCountsExact = trap;
registry._activeClusterCountsFromGradeSnapshots = trap;
registry.cachedMonitoringSnapshot = trap;
registry.monitoringSnapshot = trap;
now += 100;
registry.metrics.discovered = 42;
const before = { ...registry.metrics };
const cached = registry.health({ includeDatabase: false });
assert.strictEqual(cached.databaseSnapshot.status, 'CACHED');
assert.strictEqual(cached.databaseSnapshot.ageMs, 100);
assert.strictEqual(cached.historyComplete, 3);
assert.strictEqual(cached.historyDailyCredits, 7);
assert.strictEqual(cached.discovered, 42);
assert.strictEqual(cached.eligibilitySnapshotStatus, 'STALE');
assert.strictEqual(cached.votingEligible, 1, 'report an expired snapshot without refreshing or changing votes');
assert.strictEqual(initialEligibility.expiresAt, now - 90);
assert.strictEqual(registry.walletEligibilitySnapshot, initialEligibility);
assert.strictEqual(registry.walletEligibilitySnapshotDirty, true);
assert.deepStrictEqual(registry.metrics, before);
assert.strictEqual(databaseTouches, 0);

const overlay = Object.create(SmartWalletConsensusOverlayObserver.prototype);
Object.assign(overlay, { config: { enabled: true, profiles: [] }, store, now: () => now,
  lastSyncAt: 0, metrics: { syncs: 2, classified: 6, consensusPassed: 4 } });
assert.strictEqual(overlay.health({ includeDatabase: false }).noConsensus, null);
assert.strictEqual(overlay.health({ includeDatabase: false }).databaseSnapshot.status, 'UNAVAILABLE');
overlay.databaseHealthSnapshot = { generatedAt: now - 50, byGate: { PASS: 4, NO_CONSENSUS: 2 } };
const overlayCached = overlay.health({ includeDatabase: false });
assert.strictEqual(overlayCached.noConsensus, 2);
assert.strictEqual(overlayCached.classified, 6, 'process metrics preserve their original meaning');
assert.strictEqual(overlayCached.databaseSnapshot.status, 'CACHED');

const consensus = Object.create(SmartWalletConsensusFlowRunnerShadowSuite.prototype);
Object.assign(consensus, { config: { enabled: true, dynamicThresholds: [
  { maxEligibleClusters: 10, ordinary: 2, strong: 3 },
] }, registry, now: () => now, positions: new Map(), rowsByMint: new Map(), states: new Map(),
  entryProfiles: new Map(), exitProfiles: new Map(), metrics: {}, trackedMints: trap,
  _thresholdSnapshot: trap, _holdingVotes: trap });
const consensusCached = consensus.health({ includeDatabase: false });
assert.strictEqual(consensusCached.dynamicThresholds.eligible, 8);
assert.strictEqual(consensusCached.dynamicThresholds.ordinary, 2);
assert.strictEqual(consensusCached.dynamicThresholds.status, 'STALE');
assert.strictEqual(consensusCached.holdingSubscriptionMints, null);
registry.walletEligibilitySnapshot = { ...initialEligibility, generatedAt: 0 };
assert.strictEqual(consensus.health({ includeDatabase: false }).dynamicThresholds.ordinary, null);
registry.walletEligibilitySnapshot = initialEligibility;

const snapshot = collectRuntime({ store, smartWalletRegistry: registry,
  smartWalletConsensusOverlay: overlay, smartWalletConsensusFlowRunnerShadow: consensus });
assert.deepStrictEqual(snapshot.errors, []);
assert.strictEqual(snapshot.sections.smartWalletRegistry.historyComplete, 3);
assert.strictEqual(snapshot.sections.smartWalletConsensusOverlay.noConsensus, 2);
assert.strictEqual(snapshot.sections.smartWalletConsensusFlowRunnerShadow.dynamicThresholds.status, 'STALE');
assert.strictEqual(databaseTouches, 0, 'end-to-end parent IPC sampling must not query or mutate SQL');
assert.deepStrictEqual(registry.metrics, before);
assert.strictEqual(registry.walletEligibilitySnapshotDirty, true);
registry._refreshWalletEligibilitySnapshot = originalRefresh;

async function verifyFullRuntime() {
  const { config } = require('../src/config');
  const { createRuntime } = require('../src/index');
  const app = createRuntime({ ...config,
    storage: { ...config.storage, dbPath: ':memory:' },
    liveTrading: { ...config.liveTrading, enabled: false, dryRun: true },
    server: { ...config.server, port: 0, host: '127.0.0.1' },
  });
  // Only in-memory test stores materialize this once synchronously; production
  // disk stores already expose their scheduled health snapshot without SQL.
  app.store.healthSnapshot();
  const db = app.store.db;
  let reads = 0;
  Object.defineProperty(app.store, 'db', { configurable: true,
    get() { reads += 1; throw new Error('runtime health accessed SQL'); } });
  try {
    const sampled = collectRuntime(app);
    assert.deepStrictEqual(sampled.errors, []);
    assert.strictEqual(reads, 0);
    assert(Object.keys(sampled.sections).length >= 40, 'sample every configured component, including nested health helpers');
  } finally {
    Object.defineProperty(app.store, 'db', { configurable: true, writable: true, value: db });
    await app.stop('runtime-sampling-test');
  }
  console.log('test-dashboard-runtime-sampling: ok (41 components, no SQL/refresh, unknown vs cached, expired votes unchanged)');
}
verifyFullRuntime().catch(error => { console.error(error); process.exitCode = 1; });
