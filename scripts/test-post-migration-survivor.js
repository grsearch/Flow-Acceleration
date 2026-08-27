'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  PostMigrationSurvivorObserver,
  aggregate,
  deterministicPercent,
} = require('../src/core/PostMigrationSurvivorObserver');

function trade({ mint, timestampMs, price, side = 'buy', wallet = 'wallet-a', solAmount = 1 }) {
  return {
    mint,
    timestampMs,
    market: 'PUMP_AMM',
    price,
    side,
    wallet,
    solAmount,
  };
}

function main() {
  const db = new Database(':memory:');
  let rugChecks = 0;
  const observer = new PostMigrationSurvivorObserver({
    store: { db },
    rugRiskTracker: {
      snapshot() {
        rugChecks += 1;
        return { flagged: false };
      },
    },
    config: {
      enabled: true,
      positionSol: 1,
      baselineStageMs: 5 * 60_000,
      extendedStageMs: 30 * 60_000,
      maxAgeMs: 60 * 60_000,
      inactivityMs: 180_000,
      maxActive: 100,
      maxThirtyMinuteSurvivors: 50,
      maxSixtyMinuteSurvivors: 20,
      holdoutPct: 0,
      softFailConfirmations: 2,
      softFailConfirmationMs: 30_000,
      riskCheckIntervalMs: 2_000,
      hardPriceRetentionPct: 15,
      hardExecutableRecoveryPct: 15,
      stage5MinPeakRetentionPct: 30,
      stage5MinTrades60s: 8,
      stage5MinBuyers60s: 3,
      stage5MinBuyTx60s: 2,
      stage5MinSellTx60s: 1,
      stage5MinExecutableRecoveryPct: 25,
      stage30MinBaselineReturnPct: -10,
      stage30MinPeakRetentionPct: 45,
      stage30MinTrades300s: 12,
      stage30MinBuyers300s: 5,
      stage30MinNetFlowSol: 0,
      stage30MinExecutableRecoveryPct: 50,
      maxEventsPerMint: 64,
      dashboardLimit: 100,
    },
  });
  observer.start();

  const migratedAt = 1_800_000_000_000;
  const survivorMint = 'PostMigrationSurvivor11111111111111111111111';
  observer.onGraduated({ mint: survivorMint, symbol: 'SURV', migratedAt });
  observer.observeTrade(trade({ mint: survivorMint, timestampMs: migratedAt + 1_000, price: 1 }));

  for (let index = 0; index < 8; index += 1) {
    observer.observeTrade(trade({
      mint: survivorMint,
      timestampMs: migratedAt + 245_000 + index * 7_000,
      price: 1.1 + index * 0.01,
      side: index === 3 ? 'sell' : 'buy',
      wallet: `five-minute-${index % 4}`,
      solAmount: index === 3 ? 0.2 : 0.5,
    }));
  }
  observer.advanceTime(migratedAt + 5 * 60_000);
  assert.strictEqual(observer.health().passedFiveMinutes, 1,
    'a liquid two-way five-minute survivor should advance to the 30-minute layer');

  for (let index = 0; index < 12; index += 1) {
    observer.observeTrade(trade({
      mint: survivorMint,
      timestampMs: migratedAt + 25 * 60_000 + index * 24_000,
      price: 1.25 + index * 0.01,
      side: index % 5 === 4 ? 'sell' : 'buy',
      wallet: `thirty-minute-${index % 6}`,
      solAmount: index % 5 === 4 ? 0.2 : 0.6,
    }));
  }
  observer.advanceTime(migratedAt + 30 * 60_000);
  assert.strictEqual(observer.health().passedThirtyMinutes, 1,
    'a healthy 30-minute survivor should advance to the 60-minute layer');

  observer.observeTrade(trade({
    mint: survivorMint,
    timestampMs: migratedAt + 60 * 60_000 - 1_000,
    price: 2.2,
    wallet: 'sixty-minute-wallet',
  }));
  observer.advanceTime(migratedAt + 60 * 60_000);
  const completed = db.prepare(
    'SELECT * FROM post_migration_survivor_observations WHERE mint=?',
  ).get(survivorMint);
  assert.strictEqual(completed.status, 'COMPLETE');
  assert.strictEqual(completed.passed_5m, 1);
  assert.strictEqual(completed.passed_30m, 1);
  assert(completed.mfe_pct >= 100, 'the observer should retain a 60-minute big winner');
  assert(Number.isFinite(completed.return_60m_pct), 'the 60-minute return must be persisted');

  const rugMint = 'PostMigrationRug1111111111111111111111111111';
  observer.onGraduated({ mint: rugMint, migratedAt: migratedAt + 4_000_000 });
  observer.observeTrade(trade({ mint: rugMint, timestampMs: migratedAt + 4_001_000, price: 1 }));
  observer.observeTrade(trade({ mint: rugMint, timestampMs: migratedAt + 4_004_000, price: 0.1 }));
  const dropped = db.prepare(
    'SELECT * FROM post_migration_survivor_observations WHERE mint=?',
  ).get(rugMint);
  assert.strictEqual(dropped.status, 'DROPPED');
  assert.strictEqual(dropped.drop_reason, 'HARD_PRICE_COLLAPSE');

  const health = observer.health();
  assert.strictEqual(health.observerOnly, true);
  assert.strictEqual(health.sendsTransactions, false);
  assert.strictEqual(health.extraRpcCalls, false);
  assert(rugChecks > 0 && rugChecks < health.tradesObserved,
    'RUG checks should be throttled instead of running for every hot-path trade');
  assert.strictEqual(db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='live_positions'",
  ).get().count, 0, 'observer must not create a live-trading table');

  const dashboard = observer.dashboard({ limit: 100 });
  assert.strictEqual(dashboard.summary.completed, 1);
  assert.strictEqual(dashboard.summary.dropped, 1);
  assert(dashboard.summary.mfe.big100RatePct >= 100);
  assert(dashboard.milestones.length >= 6);

  assert.strictEqual(deterministicPercent('same-mint'), deterministicPercent('same-mint'));
  const stats = aggregate([-20, 10, 50, 100, 200]);
  assert.strictEqual(stats.count, 5);
  assert.strictEqual(stats.big50RatePct, 60);
  assert.strictEqual(stats.big100RatePct, 40);
  assert.strictEqual(stats.big200RatePct, 20);

  observer.stop();
  db.close();
  console.log('post-migration survivor observer tests passed');
}

main();
