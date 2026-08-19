'use strict';

const assert = require('assert');
const { PublicKey } = require('@solana/web3.js');
const { NATIVE_MINT } = require('@solana/spl-token');
const { canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');
const { MigrationSecondLegObserver } = require('../src/core/MigrationSecondLegObserver');
const { ResearchStore } = require('../src/data/ResearchStore');

const OBSERVED_MINT = new PublicKey(Buffer.alloc(32, 8)).toBase58();
const OBSERVED_POOL = canonicalPumpPoolPda(
  new PublicKey(OBSERVED_MINT),
  NATIVE_MINT,
).toBase58();

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
    mint: OBSERVED_MINT,
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
    pool: OBSERVED_POOL,
    poolQuoteReservesRaw: '100000000000',
    virtualQuoteReservesRaw: '20000000000',
    cashbackFeeBasisPoints: 0,
    cashbackRaw: '0',
    canBoost: true,
  };
}

function main() {
  const store = makeStore();
  const migrationAt = 1_000_000;
  let now = migrationAt;
  store.createMigrationSecondLegObservation({
    mint: 'interrupted-observer-mint',
    migrationAt: migrationAt - 1_000,
    migrationSource: 'MIGRATION',
  });
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
  const originalAllTokens = store.allTokens.bind(store);
  const originalRecentAmmTrades = store.recentAmmTrades.bind(store);
  store.allTokens = () => { throw new Error('startup must not scan all tokens'); };
  store.recentAmmTrades = () => { throw new Error('startup must not replay AMM history'); };
  assert.doesNotThrow(() => observer.start());
  store.allTokens = originalAllTokens;
  store.recentAmmTrades = originalRecentAmmTrades;
  assert.strictEqual(
    store.getMigrationSecondLegObservation('interrupted-observer-mint').status,
    'RIGHT_CENSORED',
  );
  assert.strictEqual(observer.health().startupReplaySkipped, true);
  assert.strictEqual(observer.health().startupRowsCensored, 1);
  observer.onGraduated({
    mint: OBSERVED_MINT,
    symbol: 'M2F',
    creator: 'creator',
    graduated_at: migrationAt,
    migration_pool: OBSERVED_POOL,
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
  assert.strictEqual(dashboard.summary.observations, 2);
  assert.strictEqual(dashboard.summary.right_censored, 1);
  assert.strictEqual(dashboard.summary.snapshots, 5);
  assert.strictEqual(dashboard.summary.first_pullbacks, 1);
  assert.strictEqual(dashboard.summary.rebounds, 1);
  assert.strictEqual(dashboard.observations[0].status, 'OBSERVING');
  assert.strictEqual(dashboard.snapshots[0].buyers_10s, 3,
    'sub-minimum buy must add flow but not an effective buyer');
  assert.strictEqual(dashboard.snapshots[0].feature_completeness.publicOrderFlow, true);
  assert.strictEqual(dashboard.snapshots[0].feature_completeness.quoteReserve, true);
  assert.strictEqual(
    dashboard.snapshots[0].feature_completeness.onfi10,
    'PROVISIONAL_GROSS',
  );
  assert.strictEqual(dashboard.snapshots[0].feature_completeness.boost, 'HINT_ONLY');
  assert.strictEqual(dashboard.snapshots[0].feature_completeness.cashback, 'HINT_ONLY');
  assert.strictEqual(dashboard.snapshots[0].feature_completeness.canonicalPool, true);
  assert.strictEqual(dashboard.snapshots[0].quote_reserve_sol, 120);
  assert.ok(Math.abs(dashboard.snapshots[0].onfi_10_pct - (4.01 / 120 * 100)) < 1e-9);
  assert.ok(Math.abs(
    dashboard.snapshots[0].estimated_impact_005_pct - (0.05 / 120.05 * 100),
  ) < 1e-9);
  assert.ok(Math.abs(
    dashboard.snapshots[0].estimated_impact_01_pct - (0.1 / 120.1 * 100),
  ) < 1e-9);
  assert.ok(Math.abs(
    dashboard.snapshots[0].estimated_impact_025_pct - (0.25 / 120.25 * 100),
  ) < 1e-9);
  assert.strictEqual(dashboard.snapshots[0].boost_status, 'CAN_BOOST_HINT');
  assert.strictEqual(
    dashboard.snapshots[0].cashback_status,
    'NO_TRADE_CASHBACK_OBSERVED',
  );
  assert.strictEqual(dashboard.snapshots[0].canonical_pool_status, 'CANONICAL');
  assert.ok(dashboard.featureAvailability.observed.includes('effective quote reserve'));
  assert.ok(dashboard.featureAvailability.provisional.some((value) => value.includes('normalized')));
  assert.ok(dashboard.featureAvailability.unavailable.includes('Mayhem authoritative flag'));
  assert.strictEqual(dashboard.observations[0].quote_reserve_status, 'OBSERVED');
  assert.strictEqual(dashboard.observations[0].canonical_pool_status, 'CANONICAL');

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
