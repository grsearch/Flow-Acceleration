'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { config: runtimeConfig } = require('../src/config');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartWalletRegistry } = require('../src/core/SmartWalletRegistry');

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Smart Wallet maintenance workers');
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-wallet-maintenance-'));
  const dbPath = path.join(directory, 'research.db');
  const store = new ResearchStore({
    dbPath,
    archiveDir: directory,
    rawRetentionHours: 24,
    flushMs: 60_000,
    flushMax: 100,
  }, { configuredTradingCostPct: 0 });
  const now = 1_900_000_000_000;
  const registry = new SmartWalletRegistry({
    config: {
      ...runtimeConfig.smartWalletRegistry,
      enabled: true,
      seedWallets: [],
      seedClusters: [],
      ageCheckEnabled: false,
      pnlGateEnabled: false,
      historyBackfillEnabled: false,
      clusterAutoEnabled: true,
      maintenanceWorkerEnabled: true,
      maintenanceWorkerTimeoutMs: 60_000,
    },
    store,
    now: () => now,
    fetchImpl: null,
  });

  try {
    registry.discoverWallet({
      wallet: 'maintenance-worker-wallet',
      source: 'TEST',
      discoveredAt: now - 60_000,
      effectiveFrom: now - 60_000,
    });

    const startedAt = Date.now();
    assert.strictEqual(registry._queueMaintenance(
      'GRADES', now, { forceModelMigration: true },
    ), true);
    assert.strictEqual(registry._queueMaintenance('CLUSTERS', now), true);
    assert.ok(Date.now() - startedAt < 500,
      'queueing maintenance must not execute the full scan on the main thread');
    assert.deepStrictEqual(
      [...registry.maintenancePendingTypes].sort(),
      ['CLUSTERS', 'GRADES'],
    );

    let eventLoopTurned = false;
    setImmediate(() => { eventLoopTurned = true; });
    await waitUntil(() => registry.metrics.maintenanceRunsCompleted === 2);

    const health = registry.maintenanceHealth();
    assert.strictEqual(eventLoopTurned, true,
      'the event loop must remain responsive while maintenance is running');
    assert.strictEqual(health.workerEnabled, true);
    assert.strictEqual(health.inFlight, null);
    assert.deepStrictEqual(health.queued, []);
    assert.deepStrictEqual(health.pendingTypes, []);
    assert.strictEqual(health.maintenanceRunsStarted, 2);
    assert.strictEqual(health.maintenanceRunsCompleted, 2);
    assert.strictEqual(health.maintenanceRunsFailed, 0);
    assert.strictEqual(health.lastMaintenanceError, null);
    assert.ok(Number.isFinite(health.lastMaintenanceDurationMs));

    const row = store.db.prepare(`
      SELECT wallet, metrics_json FROM smart_wallet_registry WHERE wallet=?
    `).get('maintenance-worker-wallet');
    assert.strictEqual(row.wallet, 'maintenance-worker-wallet');
    assert.ok(JSON.parse(row.metrics_json).candidateGrades,
      'the background grade refresh must persist its result');

    registry.setCluster({
      wallet: 'maintenance-worker-wallet',
      clusterId: 'independent:maintenance-worker-wallet',
      confidence: 'CONFIRMED',
      validFrom: now - 1,
    });
    registry.setGrades({
      wallet: 'maintenance-worker-wallet',
      selectionGrade: 'S_A',
      copyGrade: 'C_A',
      holdingGrade: 'H_A',
      status: 'ACTIVE',
      effectiveAt: now - 1,
      metrics: {
        pnlStatus: 'PNL_PROFITABLE',
        pnlEligible: true,
        pnlEligibilityClass: 'ACTIVE_24H',
        longTermElite: false,
        actualPnl24h: { closedPositions: 2, realizedPnlSol: 1, capitalReturnPct: 10 },
        actualPnl7d: { closedPositions: 2, realizedPnlSol: 1, capitalReturnPct: 10 },
        actualPnl30d: { closedPositions: 2, realizedPnlSol: 1, capitalReturnPct: 10 },
        actualPnl60d: { closedPositions: 2, realizedPnlSol: 1, capitalReturnPct: 10 },
      },
    });
    assert.strictEqual(
      registry._refreshWalletEligibilitySnapshot(now, { force: true }),
      true,
    );

    const exactPnlSnapshot = registry._actualPnlSnapshot;
    const exactMonitoringSnapshot = registry.monitoringSnapshot;
    registry._actualPnlSnapshot = () => {
      throw new Error('cached reads must not scan 60d PnL on the main thread');
    };
    registry.monitoringSnapshot = () => {
      throw new Error('cached reads must not query a wallet snapshot on the main thread');
    };
    const cachedMonitoring = registry.cachedMonitoringSnapshot(
      'maintenance-worker-wallet', now,
    );
    const cachedVoting = registry.cachedWalletSnapshot('maintenance-worker-wallet', now);
    assert.strictEqual(cachedMonitoring.wallet, 'maintenance-worker-wallet');
    assert.strictEqual(cachedVoting.votingEligible, true);
    assert.strictEqual(cachedVoting.snapshotGeneratedAt, now);
    const snapshotRefreshes = registry.metrics.eligibilitySnapshotRefreshes;
    registry.walletEligibilitySnapshotDirty = true;
    assert.deepStrictEqual(registry.activeClusterCounts(now), {
      eligible: 1,
      selectionA: 1,
    });
    assert.deepStrictEqual(registry.activeClusterCounts(now + 1), {
      eligible: 1,
      selectionA: 1,
    });
    assert.strictEqual(registry.dashboard(10).wallets[0].voting_eligible, 1);
    assert.strictEqual(registry.health().votingEligible, 1);
    assert.strictEqual(registry.metrics.eligibilitySnapshotRefreshes, snapshotRefreshes,
      'dashboard and health polling must not refresh a dirty snapshot before its TTL');
    assert.strictEqual(registry.walletEligibilitySnapshotDirty, true);
    registry._actualPnlSnapshot = exactPnlSnapshot;
    registry.monitoringSnapshot = exactMonitoringSnapshot;
    assert.strictEqual(registry.maintenanceHealth().clusterCountCached, true);
    assert.strictEqual(
      registry.maintenanceHealth().clusterCountMode,
      'MEMORY_VOTING_SNAPSHOT',
    );
  } finally {
    registry.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log('test-smart-wallet-maintenance-worker: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
