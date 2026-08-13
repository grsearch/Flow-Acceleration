'use strict';

const assert = require('assert');
const { LaunchPullbackShadowSuite } = require('../src/core/LaunchPullbackShadowSuite');
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

function makeConfig({ withTrailing = false, withDeep = false, withOptimization = false } = {}) {
  return {
    enabled: true,
    positionSizeSol: 0.05,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 10,
    bigWinnerPct: 50,
    profiles: [
      { id: 'F1', label: 'F1', minNetFlowSol: 15, maxCreatorSharePct: 5 },
      { id: 'F2', label: 'F2', minNetFlowSol: 20, maxCreatorSharePct: 10 },
      { id: 'F3', label: 'F3', minNetFlowSol: 20, maxCreatorSharePct: 20 },
    ],
    holds: [
      { id: '3S', label: '3s', fixedHoldMs: 3_000 },
      { id: '8S', label: '8s', fixedHoldMs: 8_000 },
    ],
    trailingCohorts: withTrailing ? [
      {
        id: 'FT_A', label: 'FT-A', profileId: 'F2', trailingActivationPct: 0,
        trailingDrawdownPct: 20, minHoldMs: 3_000, maxHoldMs: 120_000,
        hardStopPct: null,
      },
      {
        id: 'FT_B', label: 'FT-B', profileId: 'F1', trailingActivationPct: 10,
        trailingDrawdownPct: 20, minHoldMs: 3_000, maxHoldMs: 120_000,
        hardStopPct: 30,
      },
      {
        id: 'FT_C', label: 'FT-C', profileId: 'F2', trailingActivationPct: 30,
        trailingDrawdownPct: 20, minHoldMs: 0, maxHoldMs: 120_000,
        hardStopPct: 30,
      },
      {
        id: 'FT_D', label: 'FT-D', profileId: 'F1', trailingActivationPct: 30,
        trailingDrawdownPct: 15, minHoldMs: 3_000, maxHoldMs: 120_000,
        hardStopPct: 30,
      },
    ] : [],
    deepCohorts: withDeep ? [
      {
        id: 'DEEP_D12_5_R5', cohortId: 'FD12_5_R5_5S', label: 'FD12.5-R5',
        profileId: 'DEEP_D12_5_R5', pullbackPct: 12.5, reboundPct: 5,
        lowStableMs: 1_000, minNewBuyers: 2, flowWindowMs: 1_000,
        minWindowNetFlowSol: 0.01, maxPullbackPct: 25,
        minNetFlowSol: 15, maxCreatorSharePct: 5,
        fixedHoldMs: 5_000,
      },
    ] : [],
    optimizationCohorts: withOptimization ? [
      {
        id: 'FO_C70_10S', label: 'FO-C70', profileId: 'FO_C70',
        referenceProfileId: 'LEGACY_7_5_R3', referencePullbackPct: 7.5,
        referenceReboundPct: 3, minNetFlowSol: 0, maxCreatorSharePct: 100,
        maxTop3SharePct: 70, exitPolicy: 'FIXED_HOLD', fixedHoldMs: 10_000,
      },
      {
        id: 'FO_D12_R3_10S', label: 'FO-D12-R3', profileId: 'FO_D12_R3',
        referenceProfileId: 'DEEP_D12_5_R3', referencePullbackPct: 12.5,
        referenceReboundPct: 3, minNetFlowSol: 15, maxCreatorSharePct: 5,
        maxTop3SharePct: 100, exitPolicy: 'FIXED_HOLD', fixedHoldMs: 10_000,
      },
    ] : [],
    costModel: {
      platformFeePct: 1.4,
      buySlippagePct: 0.3,
      sellSlippagePct: 0.3,
      priceImpactPct: 0.2,
      baseTxFeeSol: 0.00001,
      priorityFeeSol: 0.0005,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 0.05,
    },
  };
}

function testTrailingCohorts() {
  const store = makeStore();
  let now = 1_000_000;
  const suite = new LaunchPullbackShadowSuite({
    config: makeConfig({ withTrailing: true }),
    store,
    now: () => now,
  });
  suite.start();
  suite.onReference(reference('trail', now));
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint = 'trail'").get().n,
    10,
    'six historical cohorts and four new trailing cohorts must coexist',
  );

  suite.observeTrade(trade('trail', now + 200, 1));
  suite.observeTrade(trade('trail', now + 1_000, 1.5));
  suite.observeTrade(trade('trail', now + 2_500, 1.1));
  assert.strictEqual(
    store.db.prepare("SELECT status FROM launch_pullback_shadow_positions WHERE cohort_id = 'FT_C' AND mint = 'trail'").get().status,
    'EXIT_PENDING',
    'FT-C should trail immediately once its +30% activation was reached',
  );
  assert.strictEqual(
    store.db.prepare("SELECT status FROM launch_pullback_shadow_positions WHERE cohort_id = 'FT_A' AND mint = 'trail'").get().status,
    'OPEN',
    'FT-A must respect its three-second minimum hold',
  );
  suite.observeTrade(trade('trail', now + 2_700, 1.08));
  suite.observeTrade(trade('trail', now + 3_200, 1.1));
  suite.observeTrade(trade('trail', now + 3_400, 1.08));
  const exits = store.db.prepare(`
    SELECT cohort_id, status, exit_reason FROM launch_pullback_shadow_positions
    WHERE mint = 'trail' AND cohort_id LIKE 'FT_%' ORDER BY cohort_id
  `).all();
  assert.deepStrictEqual(exits.map((row) => row.status), ['CLOSED', 'CLOSED', 'CLOSED', 'CLOSED']);
  assert.ok(exits.every((row) => row.exit_reason.startsWith('TRAILING_DRAWDOWN_')));

  now = 2_000_000;
  suite.onReference(reference('hard-stop', now));
  suite.observeTrade(trade('hard-stop', now + 200, 1));
  suite.observeTrade(trade('hard-stop', now + 500, 0.69));
  suite.observeTrade(trade('hard-stop', now + 700, 0.68));
  const hardStops = store.db.prepare(`
    SELECT cohort_id, status, exit_reason FROM launch_pullback_shadow_positions
    WHERE mint = 'hard-stop' AND cohort_id LIKE 'FT_%' ORDER BY cohort_id
  `).all();
  assert.strictEqual(hardStops.find((row) => row.cohort_id === 'FT_A').status, 'OPEN');
  assert.ok(hardStops.filter((row) => row.cohort_id !== 'FT_A').every((row) => (
    row.status === 'CLOSED' && row.exit_reason === 'HARD_STOP_30PCT'
  )));

  now = 3_000_000;
  suite.onReference(reference('max-hold', now));
  suite.observeTrade(trade('max-hold', now + 200, 1));
  suite.advanceTime(now + 120_200);
  suite.observeTrade(trade('max-hold', now + 120_400, 1.1));
  const maxHold = store.db.prepare(`
    SELECT status, exit_reason FROM launch_pullback_shadow_positions
    WHERE mint = 'max-hold' AND cohort_id = 'FT_A'
  `).get();
  assert.deepStrictEqual(maxHold, { status: 'CLOSED', exit_reason: 'MAX_HOLD_120S' });
  assert.strictEqual(suite.health().sendsTransactions, false);
  store.close();
}

function testDeepCohortsStayIsolated() {
  const store = makeStore();
  let now = 4_000_000;
  const suite = new LaunchPullbackShadowSuite({
    config: makeConfig({ withDeep: true }),
    store,
    now: () => now,
  });
  suite.start();

  suite.onReference(reference('legacy-only', now));
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint='legacy-only'").get().n,
    6,
    'legacy 7.5% reference must not create the new deep cohort',
  );
  assert.strictEqual(suite.health().referencesSeen, 1);

  now += 10_000;
  const deep = reference('deep-only', now);
  deep.referenceProfileId = 'DEEP_D12_5_R5';
  deep.features.deepReboundPct = 5.2;
  deep.features.lowStableMs = 1_200;
  deep.features.buyersSincePullbackLow = 3;
  deep.features.windowNetFlowSol = 0.4;
  deep.features.flowWindowMs = 1_000;
  suite.onReference(deep);
  assert.strictEqual(suite.health().referencesSeen, 2,
    'suite metrics must count each independent reference profile once');
  const deepRows = store.db.prepare(`
    SELECT cohort_id, reference_profile_id, low_stable_ms,
      buyers_since_pullback_low, window_net_flow_sol
    FROM launch_pullback_shadow_positions WHERE mint='deep-only'
  `).all();
  assert.deepStrictEqual(deepRows, [{
    cohort_id: 'FD12_5_R5_5S',
    reference_profile_id: 'DEEP_D12_5_R5',
    low_stable_ms: 1200,
    buyers_since_pullback_low: 3,
    window_net_flow_sol: 0.4,
  }]);

  now += 10_000;
  const tooDeep = reference('too-deep', now);
  tooDeep.referenceProfileId = 'DEEP_D12_5_R5';
  tooDeep.rejectionReason = 'MAX_PULLBACK_31.00PCT';
  suite.onReference(tooDeep);
  const rejected = store.db.prepare(`
    SELECT status, rejection_reason FROM launch_pullback_shadow_positions
    WHERE mint='too-deep'
  `).get();
  assert.deepStrictEqual(rejected, {
    status: 'RULE_REJECTED',
    rejection_reason: 'MAX_PULLBACK_31.00PCT',
  }, 'pullbacks beyond the safety ceiling must be recorded without opening');

  now -= 10_000;
  suite.observeTrade(trade('deep-only', now + 200, 1.01));
  suite.observeTrade(trade('deep-only', now + 5_200, 1.2));
  suite.observeTrade(trade('deep-only', now + 5_400, 1.21));
  assert.strictEqual(
    store.db.prepare("SELECT status FROM launch_pullback_shadow_positions WHERE mint='deep-only'").get().status,
    'CLOSED',
  );
  assert.strictEqual(suite.health().sendsTransactions, false);
  store.close();
}

function testOptimizationCohortsStayIsolated() {
  const store = makeStore();
  let now = 5_000_000;
  const suite = new LaunchPullbackShadowSuite({
    config: makeConfig({ withOptimization: true }),
    store,
    now: () => now,
  });
  suite.start();

  suite.onReference(reference('legacy-optimization', now));
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint='legacy-optimization'").get().n,
    7,
    'legacy reference should create six original cohorts plus its matching FO cohort',
  );
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint='legacy-optimization' AND cohort_id='FO_C70_10S'").get().n,
    1,
  );
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint='legacy-optimization' AND cohort_id='FO_D12_R3_10S'").get().n,
    0,
  );

  now += 10_000;
  const deep = reference('deep-optimization', now);
  deep.referenceProfileId = 'DEEP_D12_5_R3';
  suite.onReference(deep);
  assert.deepStrictEqual(
    store.db.prepare("SELECT cohort_id, status FROM launch_pullback_shadow_positions WHERE mint='deep-optimization'").all(),
    [{ cohort_id: 'FO_D12_R3_10S', status: 'PENDING_ENTRY' }],
    'deep reference should create only the matching deep FO cohort',
  );
  assert.strictEqual(suite.health().referenceGroups.length, 2);
  assert.strictEqual(suite.health().sendsTransactions, false);
  store.close();
}

function reference(mint, at, netFlowSol = 20, creatorSharePct = 4) {
  return {
    mint,
    symbol: mint.toUpperCase(),
    createdAt: at - 10_000,
    referenceAt: at,
    referencePrice: 1,
    pump25At: at - 3_000,
    referencePeakAt: at - 2_000,
    referencePeakPrice: 1.2,
    firstPullbackAt: at - 1_000,
    pullbackLowPrice: 0.9,
    maxPullbackPct: 25,
    features: {
      netFlowSol,
      creatorSharePct,
      buyers: 20,
      recentBuyers: 8,
      retentionPct: 70,
      top1SharePct: 12,
      top3SharePct: 28,
    },
  };
}

function trade(mint, timestampMs, price) {
  return {
    mint,
    timestampMs,
    market: 'PUMP_BONDING_CURVE',
    side: 'BUY',
    price,
    reservePrice: price,
  };
}

function main() {
  const store = makeStore();
  let now = 100_000;
  const suite = new LaunchPullbackShadowSuite({
    config: makeConfig(),
    store,
    now: () => now,
  });
  suite.start();
  suite.onReference(reference('winner', now));
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions').get().n,
    6,
  );
  suite.observeTrade(trade('winner', now + 199, 1.01));
  assert.strictEqual(suite.health().opened, 0);
  suite.observeTrade(trade('winner', now + 200, 1.02));
  assert.strictEqual(suite.health().opened, 6);

  suite.observeTrade(trade('winner', now + 3_200, 1.18));
  suite.observeTrade(trade('winner', now + 3_400, 1.20));
  assert.strictEqual(suite.health().closed, 3);
  suite.observeTrade(trade('winner', now + 8_200, 1.28));
  suite.observeTrade(trade('winner', now + 8_400, 1.30));
  assert.strictEqual(suite.health().closed, 6);

  let dashboard = store.launchPullbackShadowDashboard({ bigWinnerPct: 20 });
  assert.strictEqual(dashboard.cohorts.length, 6);
  assert.ok(dashboard.cohorts.every((cohort) => cohort.resolved === 1));
  assert.ok(dashboard.cohorts.every((cohort) => cohort.average_net_return_pct > 0));
  assert.ok(dashboard.cohorts.every((cohort) => cohort.independent_mints === 1));

  now = 200_000;
  suite.onReference(reference('rejected', now, 10, 0));
  assert.strictEqual(
    store.db.prepare(`
      SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
      WHERE mint = 'rejected' AND status = 'RULE_REJECTED'
    `).get().n,
    6,
  );

  now = 300_000;
  suite.onReference(reference('jump', now, 25, 2));
  suite.observeTrade(trade('jump', now + 200, 1.2));
  assert.strictEqual(
    store.db.prepare(`
      SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
      WHERE mint = 'jump' AND status = 'PRICE_JUMP'
    `).get().n,
    6,
  );

  now = 400_000;
  suite.onReference(reference('restore', now, 25, 2));
  suite.observeTrade(trade('restore', now + 200, 1.01));
  suite.stop();
  const restored = new LaunchPullbackShadowSuite({
    config: makeConfig(),
    store,
    now: () => now + 500,
  });
  restored.start();
  assert.strictEqual(restored.health().activePositions, 6);

  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n,
    0,
    'shadow F must never create live positions',
  );
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM flow_first_shadow_positions').get().n,
    0,
    'shadow F must remain isolated from old strategy tables',
  );
  assert.strictEqual(restored.health().sendsTransactions, false);
  dashboard = store.launchPullbackShadowDashboard();
  assert.ok(dashboard.positions.some((row) => row.mint === 'restore'));
  store.close();
  console.log('test-launch-pullback-shadow: ok');
}

main();
testTrailingCohorts();
testDeepCohortsStayIsolated();
testOptimizationCohortsStayIsolated();
