'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { CyaOrganicBurstShadowSuite } = require('../src/core/CyaOrganicBurstShadowSuite');

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
  assert.deepStrictEqual(suite.health().activeEntryProfiles.map((row) => row.id), ['COB_F', 'COB_D']);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);
  store.close();
  console.log('CYA Organic Burst Shadow tests: PASS');
}

main();
