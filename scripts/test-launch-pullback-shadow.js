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
        id: 'FO_F2_J2_3S', label: 'FO-F2-J2', profileId: 'FO_F2_J2',
        referenceProfileId: 'LEGACY_7_5_R3', referencePullbackPct: 7.5,
        referenceReboundPct: 3, minNetFlowSol: 20, maxCreatorSharePct: 10,
        maxTop3SharePct: 100, maxEntryPriceJumpPct: 2,
        exitPolicy: 'FIXED_HOLD', fixedHoldMs: 3_000,
      },
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
      {
        id: 'FO_D12_R3_Q_10S', label: 'FO-D12-R3-Q', profileId: 'FO_D12_R3_Q',
        referenceProfileId: 'DEEP_D12_5_R3', referencePullbackPct: 12.5,
        referenceReboundPct: 3, minNetFlowSol: 15, maxNetFlowSol: 50,
        maxCreatorSharePct: 5, minRetentionPct: 70, maxTop3SharePct: 50,
        exitPolicy: 'FIXED_HOLD', fixedHoldMs: 10_000,
      },
      {
        id: 'FO_D12_R3_QC_10S', label: 'FO-D12-R3-QC', profileId: 'FO_D12_R3_QC',
        referenceProfileId: 'DEEP_D12_5_R3', referencePullbackPct: 12.5,
        referenceReboundPct: 3, minNetFlowSol: 15, maxNetFlowSol: 50,
        maxCreatorSharePct: 3, minRetentionPct: 70, maxTop3SharePct: 50,
        exitPolicy: 'FIXED_HOLD', fixedHoldMs: 10_000,
      },
      {
        id: 'FO_D12_R3_Q_T10_H30', label: 'FO-D12-R3-Q-T10',
        profileId: 'FO_D12_R3_Q', referenceProfileId: 'DEEP_D12_5_R3',
        referencePullbackPct: 12.5, referenceReboundPct: 3,
        minNetFlowSol: 15, maxNetFlowSol: 50, maxCreatorSharePct: 5,
        minRetentionPct: 70, maxTop3SharePct: 50, exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: 20, trailingDrawdownPct: 10,
        minHoldMs: 0, maxHoldMs: 30_000, hardStopPct: 20,
      },
      {
        id: 'F2_8S_NF30', label: 'F2-8S-NF30', profileId: 'F2_NF30',
        referenceProfileId: 'LEGACY_7_5_R3', referencePullbackPct: 7.5,
        referenceReboundPct: 3, minNetFlowSol: 30, maxCreatorSharePct: 10,
        maxTop3SharePct: 100, exitPolicy: 'FIXED_HOLD', fixedHoldMs: 8_000,
      },
      {
        id: 'FT_C_NF30', label: 'FT-C-NF30', profileId: 'F2_NF30',
        referenceProfileId: 'LEGACY_7_5_R3', referencePullbackPct: 7.5,
        referenceReboundPct: 3, minNetFlowSol: 30, maxCreatorSharePct: 10,
        maxTop3SharePct: 100, exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: 30, trailingDrawdownPct: 20,
        minHoldMs: 0, maxHoldMs: 120_000, hardStopPct: 30,
      },
      {
        id: 'F_ABSORB3_8S', label: 'F-ABSORB3', profileId: 'F_ABSORB3',
        referenceProfileId: 'LEGACY_7_5_R3', referencePullbackPct: 7.5,
        referenceReboundPct: 3, minNetFlowSol: 20, maxCreatorSharePct: 10,
        maxTop3SharePct: 100, minSellSolSincePeak: 3, minBuyRefillRatio: 0.5,
        exitPolicy: 'FIXED_HOLD', fixedHoldMs: 8_000,
      },
      {
        id: 'F_ABSORB5_RUNNER', label: 'F-ABSORB5', profileId: 'F_ABSORB5',
        referenceProfileId: 'LEGACY_7_5_R3', referencePullbackPct: 7.5,
        referenceReboundPct: 3, minNetFlowSol: 20, maxCreatorSharePct: 10,
        maxTop3SharePct: 100, minSellSolSincePeak: 5, minBuyRefillRatio: 0.5,
        exitPolicy: 'TRAILING_STOP', trailingActivationPct: 30,
        trailingDrawdownPct: 20, minHoldMs: 0, maxHoldMs: 120_000,
        hardStopPct: 30,
      },
      {
        id: 'F_REACCEL0_8S', label: 'F-REACCEL0', profileId: 'F_REACCEL0',
        referenceProfileId: 'LEGACY_7_5_R3', referencePullbackPct: 7.5,
        referenceReboundPct: 3, minNetFlowSol: 20, maxCreatorSharePct: 10,
        maxTop3SharePct: 100, minRecentNetFlow1s: 0,
        minNetFlowAcceleration1s: 0, exitPolicy: 'FIXED_HOLD', fixedHoldMs: 8_000,
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
    13,
    'legacy reference should preserve six original cohorts and record seven matching optimization cohorts',
  );
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint='legacy-optimization' AND cohort_id='FO_C70_10S'").get().n,
    1,
  );
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint='legacy-optimization' AND cohort_id='FO_F2_J2_3S'").get().n,
    1,
  );
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint='legacy-optimization' AND cohort_id='FO_D12_R3_10S'").get().n,
    0,
  );
  assert.deepStrictEqual(
    store.db.prepare(`
      SELECT cohort_id, status FROM launch_pullback_shadow_positions
      WHERE mint='legacy-optimization' AND cohort_id IN ('F2_8S_NF30', 'FT_C_NF30')
      ORDER BY cohort_id
    `).all(),
    [
      { cohort_id: 'F2_8S_NF30', status: 'RULE_REJECTED' },
      { cohort_id: 'FT_C_NF30', status: 'RULE_REJECTED' },
    ],
    'NF30 cohorts must retain rejected samples without changing the old F2 cohorts',
  );
  assert.deepStrictEqual(
    store.db.prepare(`
      SELECT cohort_id, status FROM launch_pullback_shadow_positions
      WHERE mint='legacy-optimization'
        AND cohort_id IN ('F_ABSORB3_8S', 'F_ABSORB5_RUNNER', 'F_REACCEL0_8S')
      ORDER BY cohort_id
    `).all(),
    [
      { cohort_id: 'F_ABSORB3_8S', status: 'PENDING_ENTRY' },
      { cohort_id: 'F_ABSORB5_RUNNER', status: 'RULE_REJECTED' },
      { cohort_id: 'F_REACCEL0_8S', status: 'PENDING_ENTRY' },
    ],
    'causal cohorts must use sell absorption and 1-second re-acceleration independently',
  );
  const evidence = store.db.prepare(`
    SELECT sell_sol_since_peak, buy_sol_since_peak, buy_refill_ratio,
      recent_net_flow_1s, previous_net_flow_1s, net_flow_acceleration_1s,
      market_regime_independent_mints, market_regime_win_rate_5s
    FROM launch_pullback_shadow_positions
    WHERE mint='legacy-optimization' AND cohort_id='F_ABSORB3_8S'
  `).get();
  assert.deepStrictEqual(evidence, {
    sell_sol_since_peak: 4,
    buy_sol_since_peak: 2.4,
    buy_refill_ratio: 0.6,
    recent_net_flow_1s: 0.4,
    previous_net_flow_1s: 0.1,
    net_flow_acceleration_1s: 0.3,
    market_regime_independent_mints: 18,
    market_regime_win_rate_5s: 56,
  });

  now += 1_000;
  const strongAbsorption = reference('strong-absorption', now);
  strongAbsorption.features.sellSolSincePeak = 6;
  strongAbsorption.features.buySolSincePeak = 3.6;
  suite.onReference(strongAbsorption);
  assert.strictEqual(
    store.db.prepare(`
      SELECT status FROM launch_pullback_shadow_positions
      WHERE mint='strong-absorption' AND cohort_id='F_ABSORB5_RUNNER'
    `).get().status,
    'PENDING_ENTRY',
  );

  now += 1_000;
  const weakRefill = reference('weak-refill', now);
  weakRefill.features.sellSolSincePeak = 6;
  weakRefill.features.buySolSincePeak = 2;
  suite.onReference(weakRefill);
  assert.ok(store.db.prepare(`
    SELECT rejection_reason FROM launch_pullback_shadow_positions
    WHERE mint='weak-refill' AND cohort_id='F_ABSORB5_RUNNER'
  `).get().rejection_reason.includes('BUY_REFILL_BELOW_MIN'));

  now += 1_000;
  const decelerating = reference('decelerating', now);
  decelerating.features.recentNetFlow1s = -0.1;
  decelerating.features.previousNetFlow1s = 0.3;
  decelerating.features.netFlowAcceleration1s = -0.4;
  suite.onReference(decelerating);
  const reaccelRejected = store.db.prepare(`
    SELECT rejection_reason FROM launch_pullback_shadow_positions
    WHERE mint='decelerating' AND cohort_id='F_REACCEL0_8S'
  `).get().rejection_reason;
  assert.ok(reaccelRejected.includes('RECENT_NET_FLOW_1S_BELOW_MIN'));
  assert.ok(reaccelRejected.includes('NET_FLOW_ACCEL_1S_BELOW_MIN'));

  now += 2_000;
  suite.onReference(reference('nf30-optimization', now, 30, 4));
  assert.deepStrictEqual(
    store.db.prepare(`
      SELECT cohort_id, status FROM launch_pullback_shadow_positions
      WHERE mint='nf30-optimization' AND cohort_id IN ('F2_8S_NF30', 'FT_C_NF30')
      ORDER BY cohort_id
    `).all(),
    [
      { cohort_id: 'F2_8S_NF30', status: 'PENDING_ENTRY' },
      { cohort_id: 'FT_C_NF30', status: 'PENDING_ENTRY' },
    ],
    'NetFlow 30 must arm both independent high-flow cohorts',
  );
  suite.observeTrade(trade('nf30-optimization', now + 200, 1));
  suite.observeTrade(trade('nf30-optimization', now + 500, 1.4));
  suite.observeTrade(trade('nf30-optimization', now + 700, 1.1));
  suite.observeTrade(trade('nf30-optimization', now + 900, 1.08));
  assert.strictEqual(
    store.db.prepare("SELECT status FROM launch_pullback_shadow_positions WHERE mint='nf30-optimization' AND cohort_id='FT_C_NF30'").get().status,
    'CLOSED',
    'the high-flow trailing cohort must use FT-C exit behavior',
  );

  now += 5_000;
  suite.onReference(reference('low-jump-filter', now));
  suite.observeTrade(trade('low-jump-filter', now + 200, 1.03));
  assert.deepStrictEqual(
    store.db.prepare(`
      SELECT status, rejection_reason FROM launch_pullback_shadow_positions
      WHERE mint='low-jump-filter' AND cohort_id='FO_F2_J2_3S'
    `).get(),
    { status: 'PRICE_JUMP', rejection_reason: 'ENTRY_PRICE_JUMP_3.00PCT' },
    'new F2 cohort must enforce its own two-percent entry-jump ceiling',
  );
  assert.strictEqual(
    store.db.prepare(`
      SELECT status FROM launch_pullback_shadow_positions
      WHERE mint='low-jump-filter' AND cohort_id='F2_3S'
    `).get().status,
    'OPEN',
    'historical F2 must retain the original ten-percent ceiling',
  );

  now += 10_000;
  const deep = reference('deep-optimization', now);
  deep.referenceProfileId = 'DEEP_D12_5_R3';
  suite.onReference(deep);
  assert.deepStrictEqual(
    store.db.prepare(`
      SELECT cohort_id, status FROM launch_pullback_shadow_positions
      WHERE mint='deep-optimization' ORDER BY cohort_id
    `).all(),
    [
      { cohort_id: 'FO_D12_R3_10S', status: 'PENDING_ENTRY' },
      { cohort_id: 'FO_D12_R3_QC_10S', status: 'RULE_REJECTED' },
      { cohort_id: 'FO_D12_R3_Q_10S', status: 'PENDING_ENTRY' },
      { cohort_id: 'FO_D12_R3_Q_T10_H30', status: 'PENDING_ENTRY' },
    ],
    'deep quality cohorts must stay isolated and apply the strict Creator ceiling',
  );
  assert.ok(store.db.prepare(`
    SELECT rejection_reason FROM launch_pullback_shadow_positions
    WHERE mint='deep-optimization' AND cohort_id='FO_D12_R3_QC_10S'
  `).get().rejection_reason.includes('CREATOR_SHARE_ABOVE_MAX'));

  now += 1_000;
  const strictQuality = reference('deep-strict-quality', now, 20, 2);
  strictQuality.referenceProfileId = 'DEEP_D12_5_R3';
  suite.onReference(strictQuality);
  assert.strictEqual(
    store.db.prepare(`
      SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
      WHERE mint='deep-strict-quality' AND status='PENDING_ENTRY'
    `).get().n,
    4,
    'Creator<=3 must arm both quality entries and their independent exits',
  );

  now += 1_000;
  const excessiveFlow = reference('deep-excessive-flow', now, 60, 2);
  excessiveFlow.referenceProfileId = 'DEEP_D12_5_R3';
  suite.onReference(excessiveFlow);
  assert.strictEqual(
    store.db.prepare(`
      SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
      WHERE mint='deep-excessive-flow' AND rejection_reason LIKE '%NET_FLOW_ABOVE_MAX%'
    `).get().n,
    3,
    'the new quality cohorts must reject NetFlow above their causal upper bound',
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
      sellSolSincePeak: 4,
      buySolSincePeak: 2.4,
      recentNetFlow1s: 0.4,
      previousNetFlow1s: 0.1,
      netFlowAcceleration1s: 0.3,
      marketRegimeObservedAt: at,
      marketRegimeIndependentMints: 18,
      marketRegimeAverageNetReturn5s: 2.5,
      marketRegimeWinRate5s: 56,
      marketRegimeBig20Rate5s: 12,
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

function testFlowConsensusAndExitVariants() {
  const store = makeStore();
  let now = 6_000_000;
  const config = makeConfig();
  config.profiles = [];
  config.holds = [];
  config.optimizationCohorts = [
    {
      id: 'FC_BASE_X12', label: 'base', profileId: 'FC_BASE',
      referenceProfileId: 'LEGACY_7_5_R3', minNetFlowSol: 5,
      maxCreatorSharePct: 5, minRecentBuyers: 10, maxTop3SharePct: 100,
      flowConfirmationWindowMs: 5_000, minFlowSignalBuyersW3: 3,
      maxEntryPriceJumpPct: 3, exitPolicy: 'FIXED_HOLD', fixedHoldMs: 12_000,
    },
    {
      id: 'FC_BASE_STAIR60', label: 'stair', profileId: 'FC_BASE',
      referenceProfileId: 'LEGACY_7_5_R3', minNetFlowSol: 5,
      maxCreatorSharePct: 5, minRecentBuyers: 10, maxTop3SharePct: 100,
      flowConfirmationWindowMs: 5_000, minFlowSignalBuyersW3: 3,
      maxEntryPriceJumpPct: 3, exitPolicy: 'TIERED_TRAILING',
      trailingTiers: [{ activationPct: 20, drawdownPct: 10 }],
      minHoldMs: 0, maxHoldMs: 60_000, hardStopPct: 25,
    },
    {
      id: 'FC_BASE_WEAK3_X12', label: 'weak3', profileId: 'FC_BASE',
      referenceProfileId: 'LEGACY_7_5_R3', minNetFlowSol: 5,
      maxCreatorSharePct: 5, minRecentBuyers: 10, maxTop3SharePct: 100,
      flowConfirmationWindowMs: 5_000, minFlowSignalBuyersW3: 3,
      maxEntryPriceJumpPct: 3, exitPolicy: 'EARLY_STRENGTH',
      strengthCheckMs: 3_000, minStrengthMfePct: 5,
      maxHoldMs: 12_000, hardStopPct: 25,
    },
  ];
  const suite = new LaunchPullbackShadowSuite({ config, store, now: () => now });
  suite.start();

  suite.onReference(reference('no-flow', now));
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
    WHERE mint='no-flow' AND status='RULE_REJECTED'
  `).get().n, 3, 'a launch reference alone must not satisfy Flow consensus');

  now += 10_000;
  suite.onSignal({
    mint: 'confirmed', timestampMs: now - 1_000, signalVariant: 'primary_3w',
    uniqueBuyersW3: 3, netFlowW3: 8,
  });
  const confirmed = reference('confirmed', now);
  confirmed.features.recentBuyers = 12;
  suite.onReference(confirmed);
  const evidence = store.db.prepare(`
    SELECT flow_confirmation_at, flow_confirmation_variant, flow_confirmation_buyers_w3,
      flow_confirmation_netflow_w3, flow_confirmation_window_ms
    FROM launch_pullback_shadow_positions
    WHERE mint='confirmed' AND cohort_id='FC_BASE_X12'
  `).get();
  assert.deepStrictEqual(evidence, {
    flow_confirmation_at: now - 1_000,
    flow_confirmation_variant: 'primary_3w',
    flow_confirmation_buyers_w3: 3,
    flow_confirmation_netflow_w3: 8,
    flow_confirmation_window_ms: 5_000,
  });
  suite.observeTrade(trade('confirmed', now + 200, 1.02));
  suite.observeTrade(trade('confirmed', now + 3_200, 1.03));
  suite.observeTrade(trade('confirmed', now + 3_400, 1.03));
  assert.deepStrictEqual(store.db.prepare(`
    SELECT status, exit_reason FROM launch_pullback_shadow_positions
    WHERE mint='confirmed' AND cohort_id='FC_BASE_WEAK3_X12'
  `).get(), { status: 'CLOSED', exit_reason: 'NO_STRENGTH_3S' });

  suite.observeTrade(trade('confirmed', now + 4_000, 1.5));
  suite.observeTrade(trade('confirmed', now + 4_200, 1.34));
  suite.observeTrade(trade('confirmed', now + 4_400, 1.33));
  assert.ok(store.db.prepare(`
    SELECT exit_reason FROM launch_pullback_shadow_positions
    WHERE mint='confirmed' AND cohort_id='FC_BASE_STAIR60'
  `).get().exit_reason.startsWith('TIERED_TRAILING_20_10'));

  now += 20_000;
  suite.onReference(reference('future-signal', now));
  suite.onSignal({
    mint: 'future-signal', timestampMs: now + 1, uniqueBuyersW3: 10, netFlowW3: 50,
  });
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
    WHERE mint='future-signal' AND status='RULE_REJECTED'
  `).get().n, 3, 'signals after the reference must never leak into the entry decision');
  store.close();
}

testFlowConsensusAndExitVariants();
