'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { CyaOrganicBurstShadowSuite } = require('../src/core/CyaOrganicBurstShadowSuite');
const { config: runtimeConfig } = require('../src/config');

function main() {
  const base = 1_801_000_000_000;
  let now = base;
  let sequence = 0;
  const targetWallet = 'cya-target-wallet';
  const otherSmartWallet = 'other-smart-wallet';
  const liveSignals = [];
  const mint = 'CyaOrganicBurst11111111111111111111111111';
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  store.recordCreate({
    mint, symbol: 'COB', name: null, uri: null, bondingCurve: null,
    creator: 'creator-wallet', createdAt: base - 6_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  const config = {
    enabled: true,
    targetWallet,
    smartWallets: [targetWallet, otherSmartWallet],
    positionSizeSol: 1,
    featureWindowMs: 15_000,
    maxTradesPerMint: 32,
    stateRetentionMs: 60_000,
    episodeCooldownMs: 60_000,
    targetLabelWindowMs: 15_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 35,
    maxEntryPriceDropPct: 35,
    maxEntryImpactPct: 25,
    entryProfiles: [
      {
        id: 'COB_A', label: 'broad organic burst', minAgeMs: 2_000, maxAgeMs: 15_000,
        newEntriesEnabled: false,
        maxCurvePct: 60, minBuyers5s: 4, minBuyTxSharePct: 60,
        minReturn2sPct: -5, minReturn5sPct: 5, maxReturn5sPct: 60,
      },
      {
        id: 'COB_B', label: 'balanced organic burst', minAgeMs: 2_000, maxAgeMs: 10_000,
        newEntriesEnabled: false,
        maxCurvePct: 55, minBuyers5s: 4, minNetFlow5sSol: 1, minBuyTxSharePct: 65,
        minReturn5sPct: 10, maxReturn5sPct: 60, maxReturn15sPct: 80,
      },
      {
        id: 'COB_C', label: 'early organic burst', minAgeMs: 2_000, maxAgeMs: 8_000,
        newEntriesEnabled: false,
        maxCurvePct: 50, minBuyers5s: 4, minBuyTxSharePct: 65,
        minReturn2sPct: 0, minReturn5sPct: 10, maxReturn5sPct: 60,
      },
      {
        id: 'COB_F', label: 'strict 7 SOL', newEntriesEnabled: true,
        liveStrategyId: 'cya_organic_burst_cob_f_core25_runner_live',
        liveExitProfileId: 'CORE25_R75_X120',
        exclusiveGroup: 'COB_STRICT',
        exitProfileIds: ['T30_10_X60', 'FIX30', 'FLOWFADE_X60', 'CORE25_R75_X120'],
        minAgeMs: 2_000, maxAgeMs: 10_000, minBuyers5s: 10,
        minNetFlow5sSol: 7, minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40, minDrawdown15sPct: 2,
      },
      {
        id: 'COB_D', label: 'strict 5 SOL', newEntriesEnabled: true,
        liveStrategyId: 'cya_organic_burst_cob_d_fix30_live',
        exclusiveGroup: 'COB_STRICT',
        exitProfileIds: ['T30_10_X60', 'FIX30', 'FLOWFADE_X60', 'CORE25_R75_X120'],
        minAgeMs: 2_000, maxAgeMs: 10_000, minBuyers5s: 10,
        minNetFlow5sSol: 5, minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40, minDrawdown15sPct: 2,
      },
      {
        id: 'COB_F_LR01', label: '0.1 SOL live replay', newEntriesEnabled: true,
        liveReplay: true, exclusiveGroup: 'COB_F_LIVE_REPLAY',
        exitProfileIds: ['CORE25_R75_X120'], positionSizeSol: 0.1,
        entryDelayMs: 200, entryTimeoutMs: 1_500,
        maxEntryPriceJumpPct: 15, maxEntryPriceDropPct: 35, maxEntryImpactPct: 10,
        minAgeMs: 2_000, maxAgeMs: 10_000, minBuyers5s: 10,
        minNetFlow5sSol: 7, minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40, minDrawdown15sPct: 2,
      },
    ],
    exitProfiles: [
      {
        id: 'INV10_X30', label: '10s invalidation / 30s max', maxHoldMs: 30_000,
        structureInvalidationEnabled: true, minInvalidationHoldMs: 1_000,
        invalidationWindowMs: 10_000, invalidationDrawdownPct: 8,
        maxInvalidationReturn2sPct: 0,
      },
      { id: 'FIX20', label: 'fixed 20s', maxHoldMs: 20_000, structureInvalidationEnabled: false },
      {
        id: 'FIX30', label: 'fixed 30s', mode: 'FIXED_HOLD',
        maxHoldMs: 30_000, structureInvalidationEnabled: false,
      },
      {
        id: 'FLOWFADE_X60', label: 'flow fade', mode: 'FLOW_FADE',
        minHoldMs: 5_000, maxHoldMs: 60_000, minFadeVotes: 2,
        minSellBuyFlowRatio: 0.8, maxBuyerRetentionRatio: 0.5,
        structureInvalidationEnabled: false,
      },
      {
        id: 'T30_10_X60', label: 'trailing', mode: 'TRAILING',
        hardStopPct: 20, minHoldMs: 0, trailingActivationPct: 30,
        trailingStopPct: 10, maxHoldMs: 60_000, structureInvalidationEnabled: false,
      },
      {
        id: 'CORE25_R75_X120', label: 'core runner', mode: 'CORE_RUNNER',
        coreActivationPct: 20, coreWeightPct: 25, maxHoldMs: 120_000,
        trailingTiers: [
          { activationPct: 20, drawdownPct: 15 },
          { activationPct: 50, drawdownPct: 20 },
          { activationPct: 100, drawdownPct: 25 },
        ],
        structureInvalidationEnabled: false,
      },
    ],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0.000005, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const suite = new CyaOrganicBurstShadowSuite({
    config,
    store,
    now: () => now,
    onLiveSignal: (event) => liveSignals.push(event),
  });
  suite.start();
  assert.strictEqual(
    suite._comparable(
      { entryMarket: 'PUMP_BONDING_CURVE' },
      { market: 'PUMP_AMM' },
    ),
    false,
    'COB must never compare a bonding-curve entry with a PumpSwap exit',
  );
  assert.strictEqual(
    suite._comparable(
      { entryMarket: 'PUMP_BONDING_CURVE' },
      { market: 'PUMP_BONDING_CURVE' },
    ),
    true,
  );

  const trade = (offset, side, sol, wallet, price) => {
    now = base + offset;
    sequence += 1;
    const row = {
      mint, symbol: 'COB', timestampMs: now, slot: 200 + Math.floor(offset / 400),
      market: 'PUMP_BONDING_CURVE', side, solAmount: sol,
      tokenAmount: sol / price, wallet, price, reservePrice: price,
      virtualTokenReservesRaw: '1000000000000000',
      virtualSolReservesRaw: String(Math.max(1, Math.round(price * 1e18))),
      curvePct: 40, ageMs: 6_000 + offset,
      signature: `cob-${sequence}`, eventIndex: 0,
    };
    return { row, signals: suite.observeTrade(row) };
  };

  const setup = [
    [-1_900, 0.000000100], [-1_700, 0.000000104], [-1_500, 0.000000108],
    [-1_300, 0.000000112], [-1_100, 0.000000116], [-900, 0.000000120],
    [-700, 0.000000124], [-600, 0.000000125], [-500, 0.000000124],
  ];
  setup.forEach(([offset, tradePrice], index) => {
    trade(offset, 'BUY', 0.6, `public-${index + 1}`, tradePrice);
  });
  trade(-400, 'SELL', 0.5, 'public-seller', 0.000000118);

  // Monitored-wallet flow is excluded from all causal entry features.
  const excluded = trade(-250, 'BUY', 50, targetWallet, 0.000000116);
  assert.strictEqual(excluded.signals.length, 0);
  assert.strictEqual(suite.health().excludedSmartTrades, 1);

  const signal = trade(0, 'BUY', 0.6, 'public-10', 0.000000120);
  assert.strictEqual(signal.signals.length, 4, 'COB-D should open four isolated exit cohorts');
  assert.strictEqual(liveSignals.length, 1, 'COB-D must emit exactly one independent live signal');
  assert.strictEqual(liveSignals[0].strategyId, 'cya_organic_burst_cob_d_fix30_live');
  assert.strictEqual(liveSignals[0].mint, mint);
  assert.strictEqual(liveSignals[0].features.shadowEntryProfileId, 'COB_D');
  assert.strictEqual(liveSignals[0].features.shadowExitProfileId, 'T30_10_X60');
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions',
  ).get().n, 4);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE entry_profile_id='COB_D' AND exit_profile_id='FIX30'
      AND buyers_5s=10 AND ABS(net_flow_5s-5.5)<0.000001
      AND buy_tx_5s=10 AND sell_tx_5s=1
  `).get().n, 1, 'monitored-wallet trade must not contaminate public-flow features');
  assert.ok(suite.health().retiredEntrySignalsSuppressed > 0);
  assert.strictEqual(suite.health().liveSignals, 1);
  assert.strictEqual(suite.health().liveSignalErrors, 0);

  // A monitored-wallet trade after the delay cannot fill a pending entry.
  trade(225, 'BUY', 20, targetWallet, 0.000000122);
  assert.strictEqual(suite.health().opened, 0);
  trade(250, 'BUY', 0.2, 'public-fill', 0.000000122);
  assert.strictEqual(suite.health().opened, 4);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE status='OPEN' AND entry_impact_pct IS NOT NULL AND total_invested_sol=1
  `).get().n, 4);

  // CYA's first OPEN remains a future label only.
  now = base + 500;
  assert.strictEqual(suite.onSmartWalletEvent({
    mint, wallet: targetWallet, side: 'BUY', positionPhase: 'OPEN', timestampMs: now,
  }), 4);

  // FIX30 remains the historical control while the new exits remain isolated.
  now = base + 30_500;
  suite.advanceTime(now);
  trade(30_750, 'BUY', 0.1, 'public-fix30-exit', 0.000000240);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE status='CLOSED' AND exit_reason='MAX_HOLD'
  `).get().n, 1);

  // The runner takes 25% at +20%; live-matched trailing activates at +30%
  // and exits after a 10% peak drawdown.
  trade(31_000, 'BUY', 0.1, 'public-core-fill', 0.000000240);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE exit_profile_id='CORE25_R75_X120' AND core_exit_at IS NOT NULL
      AND core_weight_pct=25 AND core_proceeds_sol>0
  `).get().n, 1);
  trade(31_100, 'BUY', 0.1, 'public-trailing-trigger', 0.000000210);
  trade(31_350, 'BUY', 0.1, 'public-trailing-fill', 0.000000210);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE exit_profile_id='T30_10_X60' AND status='CLOSED'
      AND exit_reason='TRAILING_T30_D10'
  `).get().n, 1);

  // Burst memory remains bounded and same-Mint episode cooldown prevents duplicates.
  for (let index = 0; index < 80; index += 1) {
    trade(31_500 + index, 'BUY', 0.01, `burst-${index}`, 0.000000210);
  }
  assert.ok(suite.states.get(mint).trades.length <= config.maxTradesPerMint);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions',
  ).get().n, 4);

  const dashboard = suite.dashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 4);
  assert.strictEqual(dashboard.positions.length, 4);
  assert.ok(dashboard.cohorts.every((row) => row.target_open_5s_rate_pct === 100));
  const fixed30Cohort = dashboard.cohorts.find((row) => row.exit_profile_id === 'FIX30');
  assert.strictEqual(fixed30Cohort.priced_exits, 1);
  assert.strictEqual(fixed30Cohort.unpriced_exits, 0);
  assert.strictEqual(fixed30Cohort.entry_coverage_pct, 100);
  assert.strictEqual(fixed30Cohort.exit_price_coverage_pct, 100);
  assert.strictEqual(fixed30Cohort.promotion_ready, false);
  assert.ok(fixed30Cohort.promotion_blockers.includes('PRICED<200'));
  assert.strictEqual(
    fixed30Cohort.stress_average_net_return_80_pct,
    fixed30Cohort.average_net_return_pct,
  );
  assert.deepStrictEqual(suite.health().activeEntryProfiles.map((row) => row.id), [
    'COB_F', 'COB_D', 'COB_F_LR01',
  ]);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  // COB-F keeps all four Shadow exits but promotes only its 25/75 runner cohort.
  now = base + 40_000;
  suite._recordSignal(
    suite.entryProfiles.get('COB_F'),
    {
      mint: 'cob-f-live-bridge', symbol: 'COBF', timestampMs: now,
      receivedAtMs: now, slot: 300, market: 'PUMP_BONDING_CURVE',
      virtualSolReservesRaw: '1000000000000',
      virtualTokenReservesRaw: '1000000000000000',
    },
    0.0000002,
    { buyers5s: 12, netFlow5s: 8, buyTxSharePct: 80, return2sPct: 10, drawdown15sPct: 3 },
  );
  assert.strictEqual(liveSignals.length, 2);
  assert.strictEqual(liveSignals[1].strategyId, 'cya_organic_burst_cob_f_core25_runner_live');
  assert.strictEqual(liveSignals[1].features.shadowEntryProfileId, 'COB_F');
  assert.strictEqual(liveSignals[1].features.shadowExitProfileId, 'CORE25_R75_X120');

  // The live-execution replay is a separate 0.1 SOL cohort, uses the shorter
  // 1.5s fill window and never emits a real live signal.
  suite._recordSignal(
    suite.entryProfiles.get('COB_F_LR01'),
    {
      mint: 'cob-f-live-replay', symbol: 'COBLR', timestampMs: now,
      receivedAtMs: now, slot: 301, market: 'PUMP_BONDING_CURVE',
      virtualSolReservesRaw: '1000000000000',
      virtualTokenReservesRaw: '1000000000000000',
    },
    0.0000002,
    { buyers5s: 12, netFlow5s: 8, buyTxSharePct: 80, return2sPct: 10, drawdown15sPct: 3 },
  );
  const replayRow = store.db.prepare(`
    SELECT * FROM cya_organic_burst_shadow_positions
    WHERE entry_profile_id='COB_F_LR01'
  `).get();
  assert.strictEqual(replayRow.position_sol, 0.1);
  assert.strictEqual(replayRow.exit_profile_id, 'CORE25_R75_X120');
  assert.strictEqual(replayRow.entry_target_at - replayRow.signal_at, 200);
  assert.strictEqual(replayRow.entry_deadline_at - replayRow.entry_target_at, 1_500);
  assert.strictEqual(liveSignals.length, 2, 'live replay must never emit a live signal');

  // A historical row carrying a cross-market CLOSED price remains visible as
  // an unpriced outcome, but can never contaminate COB return statistics.
  store.db.prepare(`
    UPDATE cya_organic_burst_shadow_positions
    SET exit_market='PUMP_AMM', gross_return_pct=9999, net_return_pct=9999
    WHERE entry_profile_id='COB_D' AND exit_profile_id='FIX30'
  `).run();
  const guardedDashboard = suite.dashboard({ positionLimit: 20 });
  const guardedFixed30 = guardedDashboard.cohorts.find(
    (row) => row.entry_profile_id === 'COB_D' && row.exit_profile_id === 'FIX30',
  );
  assert.strictEqual(guardedFixed30.priced_exits, 0);
  assert.strictEqual(guardedFixed30.closed_without_return, 1);
  assert.strictEqual(guardedFixed30.average_net_return_pct, null);
  store.close();
  testHighFrequencyRugPairSharesSignalAndOnlyFiltersRugx();
  console.log('CYA Organic Burst Shadow tests: PASS');
}

function testHighFrequencyRugPairSharesSignalAndOnlyFiltersRugx() {
  const base = 1_802_000_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const pairProfileIds = new Set(['COB_F_LR01_FIX30', 'COB_F_LR01_FIX30_RUGX']);
  const settings = {
    ...runtimeConfig.cyaOrganicBurstShadow,
    entryProfiles: runtimeConfig.cyaOrganicBurstShadow.entryProfiles
      .filter((profile) => pairProfileIds.has(profile.id))
      .map((profile) => ({ ...profile })),
    exitProfiles: runtimeConfig.cyaOrganicBurstShadow.exitProfiles
      .filter((profile) => profile.id === 'FIX30')
      .map((profile) => ({ ...profile })),
    stateRetentionMs: 60_000,
  };
  const guardCalls = [];
  store.preEntryRugRisk = {
    config: { enabled: true },
    evaluateGuard: (options) => {
      guardCalls.push(options);
      const blocked = Array.isArray(options.hardBlockSignatures);
      return {
        ...options,
        flagged: blocked,
        blocked,
        reason: blocked ? 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY' : 'RUG_RISK_LABEL_ONLY',
      };
    },
  };
  const suite = new CyaOrganicBurstShadowSuite({
    config: settings,
    store,
    now: () => now,
  });
  suite.start();
  const mint = 'CyaOrganicBurstRugPair111111111111111111111';
  store.recordCreate({
    mint, symbol: 'COBRUG', name: null, uri: null, bondingCurve: null,
    creator: 'rug-pair-creator', createdAt: base - 5_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  const signalTrade = {
    mint, symbol: 'COBRUG', timestampMs: base, receivedAtMs: base,
    slot: 500, market: 'PUMP_BONDING_CURVE', side: 'BUY',
    solAmount: 1, tokenAmount: 10_000_000, wallet: 'signal-wallet',
    price: 0.0000001, reservePrice: 0.0000001,
    virtualTokenReservesRaw: '1000000000000000',
    virtualSolReservesRaw: '100000000000',
    signature: 'cob-rug-signal', eventIndex: 0,
  };
  const features = {
    ageMs: 5_000, curvePct: 40, buyers2s: 10, buyers5s: 12,
    buyTx5s: 12, sellTx5s: 1, buyFlow5s: 9, sellFlow5s: 1,
    netFlow5s: 8, buyTxSharePct: 92, return2sPct: 10,
    return5sPct: 20, return15sPct: 30, runup15sPct: 35, drawdown15sPct: 3,
  };
  for (const profileId of pairProfileIds) {
    const rows = suite._recordSignal(
      suite.entryProfiles.get(profileId), signalTrade, signalTrade.price, features,
    );
    assert.strictEqual(rows.length, 1);
  }
  const signalRows = store.db.prepare(`
    SELECT entry_profile_id, signal_at FROM cya_organic_burst_shadow_positions
    WHERE mint=? ORDER BY entry_profile_id
  `).all(mint);
  assert.strictEqual(signalRows.length, 2);
  assert.strictEqual(signalRows[0].signal_at, signalRows[1].signal_at,
    'both COB-F LR01 FIX30 arms must share the exact signal');

  now = base + 250;
  suite.observeTrade({
    ...signalTrade,
    timestampMs: now,
    receivedAtMs: now,
    wallet: 'public-fill',
    signature: 'cob-rug-fill',
  });
  const pairRows = store.db.prepare(`
    SELECT entry_profile_id, exit_profile_id, status, rejection_reason, position_sol
    FROM cya_organic_burst_shadow_positions WHERE mint=? ORDER BY entry_profile_id
  `).all(mint);
  assert.deepStrictEqual(pairRows.map((row) => row.status), ['OPEN', 'NO_ENTRY']);
  assert.ok(pairRows.every((row) => row.exit_profile_id === 'FIX30'));
  assert.ok(pairRows.every((row) => row.position_sol === 0.1));
  assert.strictEqual(pairRows[1].rejection_reason, 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY');
  const baselineCall = guardCalls.find((row) => (
    row.strategyId.includes('COB_F_LR01_FIX30_FIX30')
    && !row.strategyId.includes('RUGX')
  ));
  assert.strictEqual(baselineCall.enforcementMode, 'LABEL_ONLY');
  assert.strictEqual(baselineCall.hardBlockSignatures, undefined);
  const rugxCall = guardCalls.find((row) => row.strategyId.includes('FIX30_RUGX'));
  assert.deepStrictEqual(rugxCall.hardBlockSignatures, [
    'crossMintToxicWallets', 'crossMintToxicTemplate', 'extremeCoordinatedDumpability',
  ]);

  store.db.prepare(`
    UPDATE cya_organic_burst_shadow_positions
    SET status='CLOSED', exit_market=entry_market, net_return_pct=-90
    WHERE mint=? AND entry_profile_id='COB_F_LR01_FIX30'
  `).run(mint);
  store.preEntryRugRisk.guardStrategies = new Map([[
    'CYA_ORGANIC_BURST:COB_F_LR01_FIX30_RUGX_FIX30',
    {
      evaluated: 1, sampleReady: 1, sampleInsufficient: 0,
      riskFlagged: 1, hardBlocked: 1,
    },
  ]]);
  const comparison = suite.dashboard().rugComparisons[0];
  assert.strictEqual(comparison.pairedSignals, 1);
  assert.strictEqual(comparison.blocked, 1);
  assert.strictEqual(comparison.avoidedRug50, 1);
  assert.strictEqual(comparison.avoidedRug80, 1);
  assert.strictEqual(comparison.averageNetReturnLiftPct, 90);
  assert.deepStrictEqual(comparison.guardAudit, {
    strategyId: 'CYA_ORGANIC_BURST:COB_F_LR01_FIX30_RUGX_FIX30',
    evaluated: 1,
    sampleReady: 1,
    sampleInsufficient: 0,
    riskFlagged: 1,
    hardBlocked: 1,
  });
  store.close();
}

main();
