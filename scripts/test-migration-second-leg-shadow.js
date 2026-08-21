'use strict';

const assert = require('node:assert/strict');
const { MigrationSecondLegShadowSuite } = require('../src/core/MigrationSecondLegShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore(blockedMints = new Set()) {
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 0 });
  store.preEntryRugRisk = {
    config: { enabled: true },
    evaluateGuard: ({ mint }) => ({
      enabled: true,
      blocked: blockedMints.has(mint),
      sampleReady: true,
      flagged: blockedMints.has(mint),
      reason: blockedMints.has(mint) ? 'TEST_RUG' : 'HEALTHY',
    }),
  };
  return store;
}

const config = {
  enabled: true,
  cohortId: 'M2F-NH10-GUARD-B',
  positionSizeSol: 1,
  entryDelayMs: 200,
  entryTimeoutMs: 2_000,
  exitDelayMs: 200,
  exitTimeoutMs: 2_000,
  maxEntryPriceJumpPct: 15,
  maxNegativeEntryJumpPct: 30,
  hardStopPct: 15,
  maxHoldMs: 10_000,
  thresholds: {
    minAgeMs: 60_000, maxAgeMs: 240_000,
    minCurrentImpulsePct: 10, maxCurrentImpulsePct: 150,
    minPeakImpulsePct: 25, minPullbackPct: 5, maxPullbackPct: 15,
    minReboundPct: 3, minNetFlow10sSol: 1, minNetFlow3sSol: 0.1,
    minBuyers10s: 10, minBuyers3s: 2, maxLargestBuyerSharePct: 45,
    minBuySpeedRatio: 1.05, minNetFlowAcceleration: 0,
    maxSellDecelerationRatio: 1.1, minHolderDiffusionIndex: 8,
    maxEstimatedImpact1SolPct: 1,
  },
  costModel: {
    platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0,
    priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0,
    jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
  },
};

function snapshot(mint, observedAt) {
  return {
    mint, symbol: 'M2F-B', migrationAt: observedAt - 90_000,
    observedAt, ageMs: 90_000, price: 1e-7, baselinePrice: 8e-8,
    peakPrice: 1.12e-7, openingImpulsePct: 25, pullbackPct: 10,
    reboundPct: 4, netFlow3s: 0.5, netFlow10s: 3,
    buyers3s: 3, buyers10s: 14, largestBuyerShare10sPct: 30,
    buySpeedRatio: 1.4, netFlowAcceleration: 1,
    sellDecelerationRatio: 0.5, observedHolderDiffusionIndex: 10,
    quoteReserveSol: 120, estimatedImpact1SolPct: 0.826,
  };
}

function trade(mint, timestampMs, price = 1e-7) {
  return {
    mint, symbol: 'M2F-B', market: 'PUMP_AMM', side: 'BUY', timestampMs,
    price, reservePrice: price,
    poolBaseReservesRaw: '1200000000000000',
    poolQuoteReservesRaw: '120000000000',
    virtualQuoteReservesRaw: '0',
  };
}

function main() {
  let now = 1_000_000;
  const store = makeStore(new Set(['rug-mint']));
  const suite = new MigrationSecondLegShadowSuite({ config, store, now: () => now });
  suite.start();

  suite.onSnapshot(snapshot('healthy-mint', now), trade('healthy-mint', now));
  now += 200;
  suite.observeTrade(trade('healthy-mint', now));
  assert.equal(suite.health().opened, 1);
  now += 10_000;
  suite.observeTrade(trade('healthy-mint', now, 1.1e-7));
  now += 200;
  suite.observeTrade(trade('healthy-mint', now, 1.1e-7));

  suite.onSnapshot(snapshot('rug-mint', now), trade('rug-mint', now));
  now += 200;
  suite.observeTrade(trade('rug-mint', now));

  const dashboard = store.migrationSecondLegShadowDashboard();
  assert.equal(dashboard.stats.signals, 2);
  assert.equal(dashboard.stats.closed_positions, 1);
  assert.equal(dashboard.stats.rug_rejected, 1);
  assert.ok(Number.isFinite(Number(dashboard.stats.average_net_return_pct)));
  assert.equal(
    store.db.prepare(`SELECT COUNT(*) AS n FROM migration_second_leg_shadow_positions
      WHERE cohort_id != 'M2F-NH10-GUARD-B'`).get().n,
    0,
    'unguarded A cohort must not exist',
  );
  assert.equal(suite.health().sendsTransactions, false);
  assert.equal(suite.health().guardRequired, true);
  store.close();

  now = 2_000_000;
  const matrixStore = makeStore();
  const matrixConfig = {
    ...config,
    cohorts: [
      {
        id: 'M2F-NH10-GUARD-B', studyMode: 'ENTRY_CONTROL',
        confirmationMode: 'IMMEDIATE', hardStopPct: 15, maxHoldMs: 10_000,
      },
      {
        id: 'M2F-HOLD-120', studyMode: 'SAME_ENTRY_HOLD_EXTENSION',
        confirmationMode: 'IMMEDIATE', hardStopPct: 100, maxHoldMs: 120_000,
      },
      {
        id: 'M2F-HOLD-240', studyMode: 'SAME_ENTRY_HOLD_EXTENSION',
        confirmationMode: 'IMMEDIATE', hardStopPct: 100, maxHoldMs: 240_000,
      },
      {
        id: 'M2F-HOLD-240-H20', studyMode: 'SAME_ENTRY_HOLD_EXTENSION',
        confirmationMode: 'IMMEDIATE', hardStopPct: 20, maxHoldMs: 240_000,
      },
      {
        id: 'M2F-CF2-H10', studyMode: 'CONFIRM_FILTER',
        confirmationMode: 'TWO_SNAPSHOT_PERSISTENCE',
        confirmationMinGapMs: 500, confirmationMaxGapMs: 2_500,
        maxSellDecelerationIncrease: 0.1, hardStopPct: 15, maxHoldMs: 10_000,
      },
    ],
  };
  const matrixSuite = new MigrationSecondLegShadowSuite({
    config: matrixConfig, store: matrixStore, now: () => now,
  });
  matrixSuite.start();
  const migrationAt = now - 90_000;
  const first = { ...snapshot('matrix-mint', now), migrationAt };
  matrixSuite.onSnapshot(first, trade('matrix-mint', now));
  now += 200;
  matrixSuite.observeTrade(trade('matrix-mint', now));
  assert.equal(matrixSuite.health().opened, 4, 'four immediate cohorts should open');

  now += 800;
  const second = {
    ...snapshot('matrix-mint', now), migrationAt,
    netFlow3s: 0.7, buyers10s: 15, sellDecelerationRatio: 0.45,
  };
  matrixSuite.onSnapshot(second, trade('matrix-mint', now));
  now += 200;
  matrixSuite.observeTrade(trade('matrix-mint', now));

  const matrixDashboard = matrixStore.migrationSecondLegShadowDashboard();
  assert.equal(matrixDashboard.stats.signals, 5);
  assert.equal(matrixDashboard.cohorts.length, 5);
  assert.equal(matrixSuite.health().opened, 5, 'CF2 should open only after persistence');
  assert.deepEqual(
    matrixDashboard.cohorts.map((row) => row.cohort_id).sort(),
    ['M2F-CF2-H10', 'M2F-HOLD-120', 'M2F-HOLD-240', 'M2F-HOLD-240-H20',
      'M2F-NH10-GUARD-B'].sort(),
  );
  assert.equal(matrixSuite.health().sendsTransactions, false);
  assert.equal(matrixSuite.health().strategy.cohorts.length, 5);
  matrixStore.close();
  console.log('test-migration-second-leg-shadow: ok');
}

main();
