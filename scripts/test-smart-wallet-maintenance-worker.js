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

    const exactPnlSnapshot = registry._actualPnlSnapshot;
    registry._actualPnlSnapshot = () => {
      throw new Error('production cluster counts must not scan 60d PnL on the main thread');
    };
    assert.deepStrictEqual(registry.activeClusterCounts(now), {
      eligible: 0,
      selectionA: 0,
    });
    assert.deepStrictEqual(registry.activeClusterCounts(now + 1), {
      eligible: 0,
      selectionA: 0,
    });
    registry._actualPnlSnapshot = exactPnlSnapshot;
    assert.strictEqual(registry.maintenanceHealth().clusterCountCached, true);
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
