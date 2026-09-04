'use strict';

const assert = require('node:assert/strict');
const {
  MigrationSecondLegShadowSuite,
  MarketRegimeTracker,
} = require('../src/core/MigrationSecondLegShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore(blockedMints = new Set()) {
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 0 });
  store.preEntryRugRisk = {
    config: { enabled: true },
    evaluateGuard: ({ mint, enforcementMode = 'HARD_BLOCK' }) => ({
      enabled: true,
      blocked: blockedMints.has(mint) && enforcementMode === 'HARD_BLOCK',
      sampleReady: true,
      flagged: blockedMints.has(mint),
      reason: blockedMints.has(mint) && enforcementMode === 'HARD_BLOCK'
        ? 'PRE_ENTRY_RUG_TEST' : 'HEALTHY',
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
  const quoteReserveRaw = String(Math.max(1, Math.round(price * 1.2e18)));
  return {
    mint, symbol: 'M2F-B', market: 'PUMP_AMM', side: 'BUY', timestampMs,
    price, reservePrice: price,
    poolBaseReservesRaw: '1200000000000000',
    poolQuoteReservesRaw: quoteReserveRaw,
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

  suite.onSnapshot(snapshot('scale-error-mint', now), trade('scale-error-mint', now));
  now += 200;
  suite.observeTrade(trade('scale-error-mint', now));
  now += 100;
  suite.observeTrade(trade('scale-error-mint', now, 2e-5));

  const dashboard = store.migrationSecondLegShadowDashboard();
  assert.equal(dashboard.stats.signals, 3);
  assert.equal(dashboard.stats.closed_positions, 1);
  assert.equal(dashboard.stats.rug_rejected, 1);
  const scaleError = store.db.prepare(`SELECT * FROM migration_second_leg_shadow_positions
    WHERE mint = 'scale-error-mint'`).get();
  assert.equal(scaleError.status, 'DATA_ERROR');
  assert.match(scaleError.exit_reason, /^PRICE_SCALE_DISCONTINUITY_/);
  assert.equal(scaleError.net_return_pct, null);
  assert.equal(suite.health().dataError, 1);
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

function testShadowOnlyMarketRegime() {
  const tracker = new MarketRegimeTracker({
    maturityAgeMs: 60_000,
    lookbackMs: 600_000,
    minMints: 3,
    minPositiveReturnRatePct: 50,
    maxRugCollapseRatePct: 20,
    minPositiveNetFlowRatePct: 50,
    maxMedianEstimatedImpact1SolPct: 5,
  });
  const observedAt = 10_000_000;
  const outcome = (mint, returnPct, options = {}) => ({
    mint,
    observedAt,
    ageMs: 60_000,
    baselinePrice: 1,
    price: 1 + (returnPct / 100),
    netFlow10s: options.netFlow10s ?? 1,
    estimatedImpact1SolPct: options.impactPct ?? 2,
    featureCompleteness: options.blocked
      ? { preEntryRugRisk: { blocked: true } }
      : null,
  });
  tracker.observe(outcome('regime-a', 20));
  tracker.observe(outcome('regime-b', 5));
  tracker.observe(outcome('regime-c', -10));
  const green = tracker.snapshot(observedAt + 1);
  assert.equal(green.state, 'GREEN');
  assert.equal(green.shadowOnly, true);

  tracker.observe(outcome('regime-rug', 5, { blocked: true }));
  const red = tracker.snapshot(observedAt + 2);
  assert.equal(red.state, 'RED', 'a blocked RUG label contributes to the regime risk rate');
}

testShadowOnlyMarketRegime();

function testTrailingAndStrictRugPair() {
  let now = 3_000_000;
  const store = makeStore(new Set(['paired-rug-mint']));
  const pairBase = {
    ...config,
    cohortId: undefined,
    cohorts: [
      {
        id: 'PMO-FLOW-H20-A75-D25-X300',
        label: 'PMO BASE',
        rugGuardMode: 'LABEL_ONLY',
        hardBlockSignatures: [],
        hardStopPct: 20,
        trailingActivationPct: 75,
        trailingStopPct: 25,
        maxHoldMs: 300_000,
      },
      {
        id: 'PMO-FLOW-H20-A75-D25-X300-RUGX',
        label: 'PMO RUGX',
        rugGuardMode: 'HARD_BLOCK',
        hardBlockSignatures: ['crossMintToxicWallets'],
        hardStopPct: 20,
        trailingActivationPct: 75,
        trailingStopPct: 25,
        maxHoldMs: 300_000,
      },
    ],
  };
  const suite = new MigrationSecondLegShadowSuite({ config: pairBase, store, now: () => now });
  suite.start();

  suite.onSnapshot(snapshot('paired-rug-mint', now), trade('paired-rug-mint', now));
  now += 200;
  suite.observeTrade(trade('paired-rug-mint', now));
  assert.equal(suite.health().opened, 1, 'BASE opens while the strictly paired RUGX arm blocks');
  assert.equal(suite.health().rugRejected, 1);
  now += 100;
  suite.observeTrade(trade('paired-rug-mint', now, 1e-8));
  now += 200;
  suite.observeTrade(trade('paired-rug-mint', now, 1e-8));

  suite.onSnapshot(snapshot('trailing-mint', now), trade('trailing-mint', now));
  now += 200;
  suite.observeTrade(trade('trailing-mint', now));
  now += 100;
  suite.observeTrade(trade('trailing-mint', now, 2e-7));
  now += 100;
  suite.observeTrade(trade('trailing-mint', now, 1.4e-7));
  now += 200;
  suite.observeTrade(trade('trailing-mint', now, 1.35e-7));

  const trailingRows = store.db.prepare(`
    SELECT cohort_id, status, exit_reason FROM migration_second_leg_shadow_positions
    WHERE mint = 'trailing-mint' ORDER BY cohort_id
  `).all();
  assert.equal(trailingRows.length, 2);
  assert.ok(trailingRows.every((row) => row.status === 'CLOSED'));
  assert.ok(trailingRows.every((row) => row.exit_reason === 'TRAILING_STOP_A75_D25'));

  const dashboard = store.migrationSecondLegShadowDashboard();
  const pair = dashboard.rugComparisons.find((row) => (
    row.id === 'PMO-FLOW-H20-A75-D25-X300-RUGX'
  ));
  assert.equal(pair.pairedSignals, 2);
  assert.equal(pair.blocked, 1);
  assert.equal(pair.resolvedBlocked, 1);
  assert.equal(pair.avoidedRug50, 1);
  assert.equal(pair.blockedWinners, 0);
  assert.equal(dashboard.pmoStats.signals, 4);
  assert.equal(dashboard.pmoStats.rug_rejected, 1);
  store.close();
}

testTrailingAndStrictRugPair();
