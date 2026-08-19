'use strict';

const assert = require('assert');
const { MigrationSecondLegObserver } = require('../src/core/MigrationSecondLegObserver');
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

function trade(timestampMs, price, {
  side = 'BUY', wallet = `wallet-${timestampMs}`, solAmount = 1, tokenAmount = 1_000,
} = {}) {
  return {
    mint: 'm2f-observer-mint',
    symbol: 'M2F',
    timestampMs,
    receivedAtMs: timestampMs,
    slot: timestampMs,
    signature: `m2f-${timestampMs}-${side}-${wallet}`,
    eventIndex: 0,
    market: 'PUMP_AMM',
    side,
    wallet,
    solAmount,
    tokenAmount,
    price,
    reservePrice: price,
  };
}

function main() {
  const store = makeStore();
  const migrationAt = 1_000_000;
  let now = migrationAt;
  const observer = new MigrationSecondLegObserver({
    config: {
      enabled: true,
      maxAgeMs: 480_000,
      snapshotIntervalMs: 1_000,
      restoreGraceMs: 60_000,
      pullbackArmPct: 8,
      reboundReferencePct: 3,
      retentionFloorPct: 20,
      effectiveBuyMinSol: 0.02,
    },
    store,
    now: () => now,
  });
  observer.onGraduated({
    mint: 'm2f-observer-mint',
    symbol: 'M2F',
    creator: 'creator',
    graduated_at: migrationAt,
  });

  const feed = (timestampMs, price, options) => {
    now = timestampMs;
    observer.observeTrade(trade(timestampMs, price, options));
  };
  feed(migrationAt + 100, 1, { wallet: 'a', solAmount: 1 });
  feed(migrationAt + 1_100, 1.2, { wallet: 'b', solAmount: 2 });
  feed(migrationAt + 2_100, 1.08, { side: 'SELL', wallet: 'a', solAmount: 0.5 });
  feed(migrationAt + 3_100, 1.13, { wallet: 'c', solAmount: 1.5 });
  feed(migrationAt + 4_100, 1.22, { wallet: 'd', solAmount: 0.01 });

  let dashboard = store.migrationSecondLegDashboard();
  assert.strictEqual(dashboard.summary.observations, 1);
  assert.strictEqual(dashboard.summary.snapshots, 5);
  assert.strictEqual(dashboard.summary.first_pullbacks, 1);
  assert.strictEqual(dashboard.summary.rebounds, 1);
  assert.strictEqual(dashboard.observations[0].status, 'OBSERVING');
  assert.strictEqual(dashboard.snapshots[0].buyers_10s, 3,
    'sub-minimum buy must add flow but not an effective buyer');
  assert.strictEqual(dashboard.snapshots[0].feature_completeness.publicOrderFlow, true);
  assert.strictEqual(dashboard.snapshots[0].feature_completeness.quoteReserve, false);
  assert.strictEqual(dashboard.snapshots[0].quote_reserve_sol, null);
  assert.strictEqual(dashboard.snapshots[0].boost_status, 'UNKNOWN');

  const health = observer.health();
  assert.strictEqual(health.mode, 'M2F_OBSERVER_ONLY');
  assert.strictEqual(health.code, 'M2F-OBS');
  assert.strictEqual(health.sendsTransactions, false);
  assert.strictEqual(health.opensSimulatedPositions, false);
  assert.strictEqual(health.addsRpcRequests, false);
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n,
    0,
    'observer must never create a live position',
  );
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM migration_continuity_shadow_positions').get().n,
    0,
    'observer must not mix into an existing shadow position table',
  );

  now = migrationAt + 480_001;
  observer.advanceTime(now);
  dashboard = store.migrationSecondLegDashboard();
  assert.strictEqual(dashboard.observations[0].status, 'COMPLETE');
  assert.strictEqual(observer.health().activeMigrations, 0);
  assert.strictEqual(observer.health().completed, 1);
  store.close();
  console.log('test-migration-second-leg-observer: ok');
}

main();
