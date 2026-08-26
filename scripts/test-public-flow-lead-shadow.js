'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { PublicFlowLeadShadowSuite } = require('../src/core/PublicFlowLeadShadowSuite');

function main() {
  const base = 1_800_300_000_000;
  let now = base;
  let sequence = 0;
  const smartWallet = 'smart-a';
  let riskSnapshotCalls = 0;
  const rugRiskTracker = {
    snapshot() {
      riskSnapshotCalls += 1;
      return {
        sampleReady: true,
        flagged: false,
        returnPct: 18,
        maxConsecutiveBuys: 6,
        buySharePct: 72,
        sideAlternationPct: 41,
        repeatedBuySizePct: 8,
        largestWalletSharePct: 21,
      };
    },
  };
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    positionSizeSol: 1,
    smartWallets: [smartWallet],
    featureWindowMs: 5_000,
    stateRetentionMs: 60_000,
    episodeCooldownMs: 60_000,
    smartLabelWindowMs: 15_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 15,
    maxEntryPriceDropPct: 30,
    maxCrossMarketPriceJumpPct: 50,
    entryProfiles: [
      {
        id: 'PFL_B', minAgeMs: 5_000, maxAgeMs: 20_000,
        minCurvePct: 60, maxCurvePct: 80,
        minPublicBuyers5s: 5, minPublicBuyFlow5sSol: 4,
        minPublicNetFlow5sSol: 3, maxLargestBuyerSharePct: 30,
        maxReturn5sPct: 50,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 50,
        maxPreConsecutiveBuys: 8,
      },
      {
        id: 'PFL_A', minAgeMs: 5_000, maxAgeMs: 20_000,
        minCurvePct: 60, maxCurvePct: 80,
        minPublicBuyers1s: 4, minPublicBuyers5s: 5,
        minPublicBuyFlow1sSol: 3, minPublicBuyFlow5sSol: 4,
        minPublicNetFlow5sSol: 3, maxLargestBuyerSharePct: 30,
        minFlowAccelerationRatio: 1.5, maxReturn5sPct: 50,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 50,
        maxPreConsecutiveBuys: 8,
      },
    ],
    exitProfiles: [
      { id: 'H20_T1', hardStopPct: 20, maxHoldMs: 1_000 },
      { id: 'H30_T2', hardStopPct: 30, maxHoldMs: 2_000 },
    ],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0.001, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const suite = new PublicFlowLeadShadowSuite({
    config, store, now: () => now, rugRiskTracker,
  });
  suite.start();
  const boundedProfile = {
    minAgeMs: 8_000, maxAgeMs: 12_000,
    minCurvePct: 60, maxCurvePct: 75,
    minPublicBuyers1s: 9, maxPublicBuyers1s: 12,
    minPublicBuyers5s: 45,
    minPublicBuyFlow5sSol: 26, maxPublicBuyFlow5sSol: 35,
    minPublicNetFlow5sSol: 2, maxLargestBuyerSharePct: 15,
    minReturn5sPct: 10, maxReturn5sPct: 25,
    minFlowAccelerationRatio: 1, maxFlowAccelerationRatio: 2.5,
  };
  const boundedFeatures = {
    ageMs: 10_000, curvePct: 70, publicBuyers1s: 10, publicBuyers5s: 50,
    publicBuyFlow1s: 6, publicBuyFlow5s: 30, publicNetFlow5s: 4,
    largestBuyerSharePct: 12, sellBuyRatio: 0.5, return5sPct: 18,
    flowAccelerationRatio: 1.5,
  };
  assert.deepStrictEqual(suite._entryReasons(boundedProfile, boundedFeatures), []);
  assert.ok(suite._entryReasons(boundedProfile, {
    ...boundedFeatures, publicBuyers1s: 13, publicBuyFlow5s: 36,
    return5sPct: 9, flowAccelerationRatio: 3,
  }).includes('BUYERS_1S_ABOVE_MAX'));
  assert.ok(suite._entryReasons(boundedProfile, {
    ...boundedFeatures, publicBuyFlow5s: 36,
  }).includes('BUY_FLOW_5S_ABOVE_MAX'));
  assert.ok(suite._entryReasons(boundedProfile, {
    ...boundedFeatures, return5sPct: 9,
  }).includes('RETURN_5S_BELOW_MIN'));
  assert.ok(suite._entryReasons(boundedProfile, {
    ...boundedFeatures, flowAccelerationRatio: 3,
  }).includes('FLOW_ACCEL_ABOVE_MAX'));
  const riskProfile = {
    requirePreRiskSampleReady: true,
    maxPreReturnPct: 50,
    maxPreConsecutiveBuys: 8,
  };
  const riskFeatures = {
    preRiskSampleReady: true,
    preReturnPct: 40,
    preMaxConsecutiveBuys: 7,
  };
  assert.deepStrictEqual(suite._entryReasons(riskProfile, riskFeatures), []);
  assert.ok(suite._entryReasons(riskProfile, {
    ...riskFeatures, preRiskSampleReady: false,
  }).includes('PRE_RISK_SAMPLE_INCOMPLETE'));
  assert.ok(suite._entryReasons(riskProfile, {
    ...riskFeatures, preReturnPct: 51,
  }).includes('PRE_RETURN_ABOVE_MAX'));
  assert.ok(suite._entryReasons(riskProfile, {
    ...riskFeatures, preMaxConsecutiveBuys: 9,
  }).includes('PRE_CONSECUTIVE_BUYS_ABOVE_MAX'));
  const mint = 'PublicFlowLead111111111111111111111111111';
  store.recordCreate({
    mint, symbol: 'PFL', name: null, uri: null, bondingCurve: null, creator: null,
    createdAt: base - 10_000, initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });

  const trade = (offset, side, sol, wallet, price, overrides = {}) => {
    sequence += 1;
    now = base + offset;
    const row = {
      mint, symbol: 'PFL', timestampMs: now, market: 'PUMP_BONDING_CURVE',
      side, solAmount: sol, tokenAmount: sol / price, wallet, price, reservePrice: price,
      curvePct: 70, ageMs: 10_000 + offset, signature: `pfl-sig-${sequence}`, eventIndex: 0,
      ...overrides,
    };
    return { row, signals: suite.observeTrade(row) };
  };

  trade(-1_900, 'BUY', 0.5, 'public-old-1', 1);
  trade(-1_800, 'BUY', 0.5, 'public-old-2', 1);
  trade(-500, 'BUY', 0.8, 'public-1', 1.01);
  trade(-400, 'BUY', 0.8, 'public-2', 1.02);
  trade(-300, 'BUY', 0.8, 'public-3', 1.03);

  // A monitored-wallet trade is excluded from both the entry features and signal decision.
  const excluded = trade(-250, 'BUY', 10, smartWallet, 1.04);
  assert.strictEqual(excluded.signals.length, 0);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM public_flow_lead_shadow_positions',
  ).get().n, 0);
  assert.strictEqual(riskSnapshotCalls, 0,
    'public flow must pass before the RUG snapshot is read');

  // Public order flow independently creates both entry profiles before any Smart OPEN label.
  const signal = trade(0, 'BUY', 0.8, 'public-4', 1.05);
  assert.strictEqual(signal.signals.length, 4);
  assert.strictEqual(riskSnapshotCalls, 1,
    'all qualifying profiles for one trade must share one local RUG snapshot');
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM public_flow_lead_shadow_positions',
  ).get().n, 4);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_lead_shadow_positions
    WHERE public_buyers_5s=6 AND ABS(public_buy_flow_5s-4.2)<0.000001
      AND ABS(previous_buy_flow_1s-1)<0.000001
      AND pre_risk_sample_ready=1 AND pre_risk_flagged=0
      AND ABS(pre_return_pct-18)<0.000001 AND pre_max_consecutive_buys=6
      AND smart_open_at IS NULL
  `).get().n, 4, 'Smart trades must not contaminate public-flow features');

  now = base + 100;
  assert.strictEqual(suite.onSmartWalletEvent({
    mint, wallet: smartWallet, side: 'BUY', positionPhase: 'ADD', timestampMs: now,
  }), 0);
  assert.strictEqual(suite.health().ignoredSmartAdds, 1);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_lead_shadow_positions WHERE smart_open_at IS NOT NULL
  `).get().n, 0, 'Smart ADD must not label or trigger this strategy');

  // The next comparable public trade after 200ms is the simulated fill.
  trade(300, 'BUY', 0.2, 'public-fill', 1.1);
  assert.strictEqual(suite.health().opened, 4);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_lead_shadow_positions
    WHERE status='OPEN' AND entry_price=1.1 AND signal_price=1.05
  `).get().n, 4);

  // First Smart OPEN is a future label only and never changes the already-open entry.
  now = base + 1_000;
  assert.strictEqual(suite.onSmartWalletEvent({
    mint, wallet: smartWallet, side: 'BUY', positionPhase: 'OPEN', timestampMs: now,
  }), 4);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_lead_shadow_positions
    WHERE smart_open_delay_ms=1000 AND smart_open_wallet=?
  `).get(smartWallet).n, 4);

  // A 27% price fall closes H20; H30 remains until its independent fixed-hold exit.
  trade(1_100, 'SELL', 0.2, 'public-stop', 0.8);
  trade(1_400, 'BUY', 0.1, 'public-stop-fill', 0.79);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_lead_shadow_positions
    WHERE status='CLOSED' AND exit_profile_id='H20_T1'
      AND exit_reason='HARD_STOP_20'
  `).get().n, 2);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_lead_shadow_positions
    WHERE status='OPEN' AND exit_profile_id='H30_T2'
  `).get().n, 2);

  now = base + 2_500;
  suite.advanceTime(now);
  trade(2_600, 'BUY', 0.1, 'public-time-fill', 1.8);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_lead_shadow_positions
    WHERE status='CLOSED' AND exit_profile_id='H30_T2' AND exit_reason='MAX_HOLD'
  `).get().n, 2);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  const dashboard = suite.dashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 4);
  assert.strictEqual(dashboard.positions.length, 4);
  assert.ok(dashboard.cohorts.every((row) => row.smart_open_15s_rate_pct === 100));
  assert.strictEqual(riskSnapshotCalls, 1);
  assert.strictEqual(suite.health().riskSnapshots, 1);
  const columns = store.db.prepare(
    'PRAGMA table_info(public_flow_lead_shadow_positions)',
  ).all().map((row) => row.name);
  assert.ok(!columns.includes('source_wallet'), 'entry table must not depend on a Smart wallet');
  assert.ok(columns.includes('pre_risk_sample_ready'));
  assert.ok(columns.includes('pre_return_pct'));
  assert.ok(columns.includes('pre_max_consecutive_buys'));
  store.close();
  console.log('Public Flow Lead Shadow tests: PASS');
}

main();
