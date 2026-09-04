'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchStore } = require('../src/data/ResearchStore');
const { DashboardReadModel } = require('../src/data/DashboardReadModel');
const { SmartWalletRegistry } = require('../src/core/SmartWalletRegistry');
const {
  SmartWalletConsensusOverlayObserver,
} = require('../src/core/SmartWalletConsensusOverlayObserver');

async function waitFor(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dashboard-model-'));
  const dbPath = path.join(directory, 'research.db');
  const dashboardDbPath = path.join(directory, 'dashboard.db');
  const storage = {
    dbPath,
    archiveDir: directory,
    rawRetentionHours: 48,
    rawShardingEnabled: false,
    cacheSizeKb: 8_192,
    busyTimeoutMs: 5_000,
    flushMs: 60_000,
    flushMax: 100,
  };
  const store = new ResearchStore(storage, { configuredTradingCostPct: 1.4 });
  const timestampMs = Date.now();
  store.ensureToken('dashboard-mint');
  store.queueRawTrade({
    timestampMs,
    chainTimestampMs: timestampMs,
    receivedAtMs: timestampMs,
    signature: 'dashboard-trade',
    eventIndex: 0,
    market: 'PUMP_BONDING_CURVE',
    mint: 'dashboard-mint',
    wallet: 'dashboard-wallet',
    side: 'BUY',
    solAmount: 1,
    tokenAmount: 1,
    price: 1,
  });
  store.flushRawTrades();
  const registryConfig = {
    enabled: true,
    costModel: { positionSizeSol: 1 },
    maintenanceWorkerEnabled: true,
  };
  const overlayConfig = { enabled: true, profiles: [] };
  // Production creates these schemas before the dashboard worker starts.
  // Mirror that startup order so the read-only worker can materialize them.
  new SmartWalletRegistry({ config: registryConfig, store });
  new SmartWalletConsensusOverlayObserver({ config: overlayConfig, store });

  const model = new DashboardReadModel({
    config: {
      enabled: true,
      dbPath: dashboardDbPath,
      fastRefreshMs: 1_000,
      shadowRefreshMs: 10_000,
      slowRefreshMs: 10_000,
      maxSnapshotAgeMs: 60_000,
      cacheSizeKb: 4_096,
    },
    storage,
    smartWallets: ['dashboard-wallet'],
    liveStrategies: [],
    smartWalletRegistryConfig: registryConfig,
    smartWalletConsensusOverlayConfig: overlayConfig,
  });
  try {
    model.start();
    const overview = await waitFor(() => model.read('overview'));
    const wallets = await waitFor(() => model.read('smart-wallets'));
    const shadow = await waitFor(() => model.read('shadow:primary'));
    const registry = await waitFor(() => model.read('smart-wallet-registry'));
    const overlay = await waitFor(() => model.read('smart-consensus-overlay'));
    assert.ok(overview, 'overview must be preaggregated into the read model');
    assert.strictEqual(overview.value.rawTradesToday, 1);
    assert.ok(wallets, 'wallet statistics must be preaggregated into the read model');
    assert.strictEqual(wallets.value[0].wallet, 'dashboard-wallet');
    assert.ok(shadow, 'shadow statistics must be preaggregated into the read model');
    assert.ok(
      registry,
      `registry dashboard must be served from the read model: ${JSON.stringify(model.health())}`,
    );
    assert.ok(overlay, 'consensus overlay must be served from the read model');
    assert.notStrictEqual(path.resolve(dbPath), path.resolve(dashboardDbPath));
    assert.strictEqual(model.health().mode, 'INDEPENDENT_READ_MODEL');
  } finally {
    await model.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('test-dashboard-read-model: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
