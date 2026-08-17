'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartLikeEarlyShadowSuite } = require('../src/core/SmartLikeEarlyShadowSuite');

function main() {
  const base = 1_800_100_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const walletA = 'priority-wallet-a';
  const walletB = 'priority-wallet-b';
  const config = {
    enabled: true,
    positionSizeSol: 1,
    stateWindowMs: 5_000,
    stateRetentionMs: 240_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 15,
    maxEntryPriceDropPct: 30,
    maxCurvePct: 40,
    maxAgeMs: 10_000,
    maxReturn5sPct: 10,
    minNetFlow5s: 0,
    minSmartOpenSol: 0.1,
    smartConfirmationMs: 5_000,
    clusterDedupMs: 1_000,
    addThresholdsPct: [50, 80, 120],
    addFraction: 0.08,
    hardStopPct: 20,
    noStrengthMs: 25_000,
    noStrengthMfePct: 10,
    flowDecayNetFlow1s: -1,
    flowDecaySellTx1s: 3,
    priorityWallets: [walletA, walletB],
    walletClusters: [{ id: 'same-operator', wallets: [walletA, walletB] }],
    entryProfiles: [
      { id: 'SMART_DIRECT', sourceType: 'SMART_OPEN', requireAge: false, requireFlowConfirmation: false },
      { id: 'SMART_STRICT', sourceType: 'SMART_OPEN', requireAge: true, requireFlowConfirmation: true },
      { id: 'FLOW_PREDICT', sourceType: 'FLOW_PREDICT', requireAge: true, requireFlowConfirmation: false },
    ],
    addProfiles: [
      { id: 'BASE', thresholdsPct: [], addFraction: 0 },
      { id: 'PYRAMID', thresholdsPct: [50, 80, 120], addFraction: 0.08 },
    ],
    exitProfiles: [
      { id: 'E50', activationPct: 50, sellFraction: 0.4, trailingStopPct: 12, maxHoldMs: 180_000, flowDecayExit: false },
      { id: 'E75', activationPct: 75, sellFraction: 0.5, trailingStopPct: 15, maxHoldMs: 180_000, flowDecayExit: false },
      { id: 'E100', activationPct: 100, sellFraction: 0.4, trailingStopPct: 20, maxHoldMs: 180_000, flowDecayExit: true },
      { id: 'FIX60_H20', mode: 'FIXED_HOLD', hardStopPct: 20, maxHoldMs: 60_000,
        allowedAddProfileIds: ['BASE'] },
      { id: 'FIX120_H20', mode: 'FIXED_HOLD', hardStopPct: 20, maxHoldMs: 120_000,
        allowedAddProfileIds: ['BASE'] },
    ],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0.001, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const suite = new SmartLikeEarlyShadowSuite({ config, store, now: () => now });
  suite.start();
  let sequence = 0;
  const mint = 'SmartLikeEarly11111111111111111111111111111';
  store.recordCreate({
    mint, symbol: 'SLE', name: null, uri: null, bondingCurve: null, creator: null,
    createdAt: base - 5_000, initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  const trade = (offset, side, sol, wallet, price, overrides = {}) => {
    sequence += 1;
    now = base + offset;
    const row = {
      mint, symbol: 'SLE', timestampMs: now, market: 'PUMP_BONDING_CURVE',
      side, solAmount: sol, tokenAmount: sol / price, wallet, price, reservePrice: price,
      curvePct: 30, ageMs: 5_000 + offset, signature: `sig-${sequence}`, eventIndex: 0,
      ...overrides,
    };
    suite.observeTrade(row);
    return row;
  };

  trade(-4_000, 'BUY', 0.5, 'buyer-0', 1);
  trade(-500, 'BUY', 0.5, 'buyer-1', 1.02);
  const smartTrade = trade(0, 'BUY', 1, walletA, 1.04);
  suite.onSmartWalletEvent({ ...smartTrade, id: 1, positionPhase: 'OPEN',
    nearestFlowSignal: 5, timeFromFlowSignalMs: 1_000 });
  assert.strictEqual(store.db.prepare(
    "SELECT COUNT(*) n FROM smart_like_early_shadow_positions WHERE source_type='SMART_OPEN'",
  ).get().n, 16);

  // A second wallet from the same operator cluster must not generate another episode.
  const duplicate = trade(10, 'BUY', 1, walletB, 1.04);
  suite.onSmartWalletEvent({ ...duplicate, id: 2, positionPhase: 'OPEN',
    nearestFlowSignal: 5, timeFromFlowSignalMs: 1_010 });
  assert.strictEqual(store.db.prepare(
    "SELECT COUNT(*) n FROM smart_like_early_shadow_positions WHERE source_type='SMART_OPEN'",
  ).get().n, 16);

  // Predictive entry exists before a later Smart OPEN and is labelled after the fact.
  suite.onSignal({
    mint, symbol: 'SLE', timestampMs: now, price: 1.04, curvePct: 30, ageMs: 5_010,
    signalVariant: 'primary_3w', signalRankInMint: 1, signalId: 99,
  });
  assert.strictEqual(store.db.prepare(
    "SELECT COUNT(*) n FROM smart_like_early_shadow_positions WHERE source_type='FLOW_PREDICT'",
  ).get().n, 8);

  trade(260, 'BUY', 0.2, 'fill', 1.05);
  assert.strictEqual(suite.health().opened, 24);

  // Only PYRAMID cohorts add, at the three configured profit thresholds.
  trade(600, 'BUY', 0.2, 'trend-a', 1.65);
  trade(900, 'BUY', 0.2, 'trend-b', 2.1);
  trade(1_200, 'BUY', 0.2, 'trend-c', 2.8);
  const addStats = store.db.prepare(`SELECT add_profile_id, MIN(add_count) min_add,
    MAX(add_count) max_add FROM smart_like_early_shadow_positions GROUP BY add_profile_id`).all();
  assert.deepStrictEqual(addStats.find((row) => row.add_profile_id === 'BASE'), {
    add_profile_id: 'BASE', min_add: 0, max_add: 0,
  });
  assert.deepStrictEqual(addStats.find((row) => row.add_profile_id === 'PYRAMID'), {
    add_profile_id: 'PYRAMID', min_add: 1, max_add: 3,
  });

  // Every exit profile has taken a partial profit; a deep pullback then closes all runners.
  trade(1_500, 'BUY', 0.2, 'peak', 3.3);
  assert.strictEqual(store.db.prepare(
    "SELECT MIN(partial_exit_count) n FROM smart_like_early_shadow_positions WHERE exit_profile_id NOT LIKE 'FIX%'",
  ).get().n, 1);
  assert.strictEqual(store.db.prepare(
    "SELECT MAX(partial_exit_count) n FROM smart_like_early_shadow_positions WHERE exit_profile_id LIKE 'FIX%'",
  ).get().n, 0, 'fixed-hold cohorts must never take partial profit');
  trade(1_800, 'SELL', 0.2, 'drawdown', 2.2);
  trade(2_050, 'BUY', 0.1, 'exit-fill', 2.18);
  assert.strictEqual(store.db.prepare(
    "SELECT COUNT(*) n FROM smart_like_early_shadow_positions WHERE status='CLOSED'",
  ).get().n, 18);
  assert.strictEqual(store.db.prepare(
    "SELECT COUNT(*) n FROM smart_like_early_shadow_positions WHERE status='OPEN' AND exit_profile_id LIKE 'FIX%'",
  ).get().n, 6);
  now = base + 60_300;
  suite.advanceTime(now);
  trade(60_600, 'BUY', 0.1, 'fixed-60-fill', 4);
  now = base + 120_300;
  suite.advanceTime(now);
  trade(120_600, 'BUY', 0.1, 'fixed-120-fill', 5);
  assert.strictEqual(store.db.prepare(
    "SELECT COUNT(*) n FROM smart_like_early_shadow_positions WHERE status='CLOSED'",
  ).get().n, 24);
  assert.ok(store.db.prepare(`SELECT COUNT(*) n FROM smart_like_early_shadow_positions
    WHERE exit_profile_id LIKE 'FIX%' AND partial_exit_count=0 AND exit_reason='MAX_HOLD'
      AND net_return_pct>100`).get().n === 6);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM smart_like_early_shadow_positions WHERE net_return_pct IS NULL',
  ).get().n, 0);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  const dashboard = suite.dashboard({ positionLimit: 30 });
  assert.strictEqual(dashboard.cohorts.length, 24);
  assert.strictEqual(dashboard.positions.length, 24);

  // A missing executable exit is censored, not fabricated as a -100% loss.
  const mint2 = 'SmartLikeNoExit111111111111111111111111111111';
  store.recordCreate({
    mint: mint2, symbol: 'NX', name: null, uri: null, bondingCurve: null, creator: null,
    createdAt: now - 1_000, initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  sequence += 1;
  const event2 = {
    mint: mint2, symbol: 'NX', timestampMs: now + 10, market: 'PUMP_BONDING_CURVE',
    side: 'BUY', solAmount: 1, tokenAmount: 1, wallet: walletA, price: 1, reservePrice: 1,
    curvePct: 20, ageMs: 1_000, signature: `sig-${sequence}`, eventIndex: 0,
  };
  now = event2.timestampMs;
  suite.observeTrade(event2);
  suite.onSmartWalletEvent({ ...event2, id: 3, positionPhase: 'OPEN',
    nearestFlowSignal: 7, timeFromFlowSignalMs: 100 });
  sequence += 1;
  now += 250;
  suite.observeTrade({ ...event2, timestampMs: now, wallet: 'fill-2', price: 1,
    reservePrice: 1, signature: `sig-${sequence}` });
  sequence += 1;
  now += 250;
  suite.observeTrade({ ...event2, timestampMs: now, side: 'SELL', wallet: 'stop-2', price: 0.7,
    reservePrice: 0.7, signature: `sig-${sequence}` });
  now += 2_000;
  suite.advanceTime(now);
  const censored = store.db.prepare(`SELECT COUNT(*) n FROM smart_like_early_shadow_positions
    WHERE mint=? AND status='NO_EXIT' AND net_return_pct IS NULL`).get(mint2).n;
  assert.strictEqual(censored, 16);

  store.close();
  console.log('Smart-Like Early Shadow tests: PASS');
}

main();
