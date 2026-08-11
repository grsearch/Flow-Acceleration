'use strict';

const assert = require('assert');
const { LaunchQualityObserver } = require('../src/core/LaunchQualityObserver');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:',
    archiveDir: '.',
    rawRetentionHours: 24,
    flushMs: 60_000,
    flushMax: 100,
  }, { configuredTradingCostPct: 0 });
}

function trade({ timestampMs, price, side = 'BUY', wallet = 'wallet-a', solAmount = 0.2 }) {
  return {
    mint: 'launch-quality-mint',
    symbol: 'LQ',
    timestampMs,
    receivedAtMs: timestampMs,
    slot: timestampMs,
    signature: `lq-${timestampMs}-${wallet}-${side}`,
    eventIndex: 0,
    market: 'PUMP_BONDING_CURVE',
    side,
    wallet,
    solAmount,
    tokenAmount: 1_000,
    price,
    reservePrice: price,
    curvePct: 25,
    virtualSolReservesRaw: '50000000000',
  };
}

function main() {
  const store = makeStore();
  let now = 100_000;
  const references = [];
  const observer = new LaunchQualityObserver({
    config: {
      enabled: true,
      snapshotHorizonsMs: [5_000, 10_000, 20_000, 30_000, 60_000],
      maxLaunchAgeMs: 90_000,
      pumpReferencePct: 25,
      pullbackReferencePct: 7.5,
      reboundReferencePct: 3,
      recentBuyerWindowMs: 10_000,
      retentionFloorPct: 10,
      maxObservationLagMs: 2_000,
    },
    store,
    now: () => now,
    onReference: (reference) => references.push(reference),
  });
  observer.onCreate({
    mint: 'launch-quality-mint',
    symbol: 'LQ',
    creator: 'creator-wallet',
    createdAt: 100_000,
  });

  const feed = (input) => {
    now = input.timestampMs;
    observer.observeTrade(trade(input));
  };
  feed({ timestampMs: 100_100, price: 1, wallet: 'wallet-a' });
  feed({ timestampMs: 105_000, price: 1.1, wallet: 'wallet-b' });
  feed({ timestampMs: 106_000, price: 1.3, wallet: 'wallet-c' });
  feed({ timestampMs: 107_000, price: 1.5, wallet: 'wallet-d' });
  feed({ timestampMs: 108_000, price: 1.35, side: 'SELL', wallet: 'wallet-a', solAmount: 0.4 });
  feed({ timestampMs: 109_000, price: 1.4, wallet: 'wallet-e' });
  feed({ timestampMs: 110_000, price: 1.45, wallet: 'wallet-f' });
  feed({ timestampMs: 112_000, price: 1.54, wallet: 'wallet-g' });
  feed({ timestampMs: 114_000, price: 1.47, wallet: 'wallet-h' });
  feed({ timestampMs: 119_000, price: 1.68, wallet: 'wallet-i' });
  feed({ timestampMs: 120_000, price: 1.6, wallet: 'wallet-j' });
  feed({ timestampMs: 130_000, price: 1.5, wallet: 'wallet-k' });
  feed({ timestampMs: 139_000, price: 1.4, wallet: 'wallet-l' });

  now = 142_000;
  observer.advanceTime(now);
  let dashboard = store.launchQualityDashboard();
  assert.strictEqual(dashboard.observations.length, 1);
  assert.strictEqual(dashboard.observations[0].status, 'COMPLETE');
  assert.ok(dashboard.observations[0].pump_25_at);
  assert.ok(dashboard.observations[0].first_pullback_at);
  assert.ok(dashboard.observations[0].rebound_at);
  assert.ok(Number.isFinite(dashboard.observations[0].return_30s));
  assert.ok(
    dashboard.observations[0].reference_features.buyers >= 5,
    JSON.stringify(dashboard.observations[0].reference_features),
  );
  assert.strictEqual(dashboard.snapshots.length, 4, '60s snapshot must remain pending');

  feed({ timestampMs: 160_000, price: 1.42, wallet: 'wallet-m' });
  now = 163_000;
  observer.advanceTime(now);
  dashboard = store.launchQualityDashboard();
  assert.deepStrictEqual(
    dashboard.snapshots.map((row) => row.horizon_ms).sort((a, b) => a - b),
    [5_000, 10_000, 20_000, 30_000, 60_000],
  );
  assert.strictEqual(observer.health().activeLaunches, 0);
  assert.strictEqual(references.length, 1, 'live reference must be emitted exactly once');
  assert.strictEqual(references[0].mint, 'launch-quality-mint');
  assert.ok(references[0].features.netFlowSol > 0);

  const completed = store.getLaunchQualityObservation('launch-quality-mint');
  now = 195_000;
  observer.observeTrade(trade({ timestampMs: now, price: 1.01 }), { replay: true });
  const afterReplay = store.getLaunchQualityObservation('launch-quality-mint');
  assert.strictEqual(afterReplay.label_status, 'COMPLETE');
  assert.strictEqual(afterReplay.rebound_at, completed.rebound_at);
  assert.strictEqual(references.length, 1, 'startup replay must not emit a trading reference');
  const immutable = store.updateLaunchQualityObservation('launch-quality-mint', {
    status: 'NO_REFERENCE_PULLBACK',
    labelStatus: 'NO_REFERENCE',
  });
  assert.strictEqual(immutable.changes, 0, 'terminal labels must be immutable');
  assert.strictEqual(store.getLaunchQualityObservation('launch-quality-mint').label_status, 'COMPLETE');
  assert.strictEqual(observer.health().sendsTransactions, false);
  assert.strictEqual(observer.health().opensSimulatedPositions, false);
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n,
    0,
    'observer must not create live positions',
  );
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM primary_signal_shadow_positions').get().n,
    0,
    'observer must not mix data into existing shadow tables',
  );
  store.close();
  console.log('test-launch-quality-observer: ok');
}

main();
