'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  BondingCurveMomentumShadowSuite,
} = require('../src/core/BondingCurveMomentumShadowSuite');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:',
    archiveDir: '.',
    rawRetentionHours: 24,
    flushMs: 60_000,
    flushMax: 100,
  }, { configuredTradingCostPct: 0 });
}

function makeConfig() {
  const base = {
    minAgeMs: 10_000,
    maxAgeMs: 60_000,
    minCurvePct: 40,
    maxCurvePct: 100,
    minNetFlow1s: 5,
    minFlowAccel1s: 1.5,
    minBuyers1s: 5,
    minBuyTx1s: 5,
  };
  return {
    enabled: true,
    positionSizeSol: 0.05,
    stateWindowMs: 5_000,
    stateRetentionMs: 60_000,
    episodeCooldownMs: 5_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 10,
    snapshotHorizonsMs: [1_000, 2_000, 3_000, 5_000],
    maxSnapshotLagMs: 500,
    flowExitNetFlowSol: 0,
    flowExitMaxBuyTxAccel: 0,
    flowExitMinSellSol: 0.5,
    bigWinnerPct: 50,
    entryProfiles: [
      { id: 'H0', label: 'H0', ...base },
      { id: 'H1', label: 'H1', ...base, minBuyTxAccel1s: 6, maxTop1SharePct: 50 },
      { id: 'H2', label: 'H2', ...base, minNewBuyers1s: 4, maxTop1SharePct: 30 },
      {
        id: 'H3',
        label: 'H3',
        ...base,
        maxAgeMs: 180_000,
        minNetFlow1s: 3,
        minPriorSellSol1s: 0.5,
        maxSellDecayRatio: 0.25,
      },
    ],
    exitProfiles: [
      { id: 'X3', label: '3s', exitMode: 'FIXED_HOLD', fixedHoldMs: 3_000, maxHoldMs: 3_000 },
      { id: 'XF', label: 'flow', exitMode: 'FLOW_REVERSAL', minHoldMs: 500, maxHoldMs: 10_000 },
      {
        id: 'XT',
        label: 'trail',
        exitMode: 'WINNER_TRAIL',
        minHoldMs: 500,
        trailingActivationPct: 10,
        trailingStopPct: 7.5,
        maxHoldMs: 30_000,
      },
    ],
    costModel: {
      platformFeePct: 1,
      buySlippagePct: 0,
      sellSlippagePct: 0,
      priceImpactPct: 0,
      baseTxFeeSol: 0,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 0.05,
      entryFailureRatePct: 0,
      entryFailureCostPct: 0,
    },
  };
}

function curveTrade(mint, timestampMs, side, solAmount, wallet, price = 1) {
  return {
    mint,
    symbol: mint.slice(0, 8),
    timestampMs,
    receivedAtMs: timestampMs,
    market: 'PUMP_BONDING_CURVE',
    side,
    wallet,
    solAmount,
    tokenAmount: solAmount / price,
    price,
    reservePrice: price,
    curvePct: 55,
    virtualSolReservesRaw: '45000000000',
    signature: `${mint}:${timestampMs}:${side}:${wallet}`,
  };
}

function ammTrade(mint, timestampMs, price) {
  return {
    mint,
    timestampMs,
    receivedAtMs: timestampMs,
    market: 'PUMP_AMM',
    side: 'BUY',
    wallet: 'amm-wallet',
    solAmount: 1,
    tokenAmount: 1 / price,
    price,
    reservePrice: price,
    signature: `${mint}:${timestampMs}:amm`,
  };
}

function main() {
  const base = 1_800_000_000_000;
  let now = base;
  const store = makeStore();
  const config = makeConfig();
  const mint = 'MomentumShadow11111111111111111111111111111';
  store.recordCreate({
    mint,
    symbol: 'MOM',
    name: null,
    uri: null,
    bondingCurve: null,
    creator: null,
    createdAt: base - 20_000,
    initialRealTokenReservesRaw: null,
    tokenTotalSupplyRaw: null,
  });
  const suite = new BondingCurveMomentumShadowSuite({ config, store, now: () => now });
  suite.start();

  // A sell-heavy prior second followed by six dispersed buys triggers H0-H3.
  suite.observeTrade(curveTrade(mint, base + 100, 'SELL', 1, 'seller'));
  for (let index = 0; index < 6; index += 1) {
    suite.observeTrade(curveTrade(
      mint,
      base + 1_000 + index * 100,
      'BUY',
      1,
      `buyer-${index}`,
      1 + index * 0.001,
    ));
  }
  assert.strictEqual(suite.health().signals, 4);
  assert.strictEqual(suite.health().pendingEntries, 12);
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM bonding_curve_momentum_shadow_positions').get().n,
    12,
  );

  // Continued passing trades do not create repeated signals while the edge remains active.
  suite.observeTrade(curveTrade(mint, base + 1_600, 'BUY', 1, 'buyer-6', 1.01));
  assert.strictEqual(suite.health().signals, 4);

  suite.observeTrade(curveTrade(mint, base + 1_800, 'BUY', 1, 'entry-buyer', 1.01));
  assert.strictEqual(suite.health().opened, 12);
  assert.strictEqual(suite.health().activePositions, 12);

  // First causal horizon is observed; later missing horizons remain explicit NO_TRADE rows.
  suite.observeTrade(curveTrade(mint, base + 2_500, 'BUY', 0.1, 'small-buyer', 1.04));
  assert(store.db.prepare(`
    SELECT COUNT(*) AS n FROM bonding_curve_momentum_shadow_snapshots
    WHERE horizon_ms = 1000 AND status = 'OBSERVED'
  `).get().n >= 1);

  // Sell-flow reversal exits XF and pre-activation XT, each with its own position.
  suite.observeTrade(curveTrade(mint, base + 2_600, 'SELL', 10, 'large-seller', 0.95));
  suite.observeTrade(curveTrade(mint, base + 2_800, 'BUY', 0.1, 'exit-fill', 0.96));
  let rows = store.db.prepare(`
    SELECT * FROM bonding_curve_momentum_shadow_positions ORDER BY id
  `).all();
  assert.strictEqual(rows.filter((row) => row.status === 'CLOSED').length, 8);
  assert(rows.filter((row) => row.status === 'CLOSED')
    .every((row) => ['XF', 'XT'].includes(row.exit_profile_id)));

  // Fixed 3-second positions cross graduation and close on a real PumpSwap observation.
  store.recordComplete({ mint, completedAt: base + 4_500, timestampMs: base + 4_500 });
  now = base + 5_000;
  suite.observeTrade(ammTrade(mint, now, 1.08));
  rows = store.db.prepare(`
    SELECT * FROM bonding_curve_momentum_shadow_positions ORDER BY id
  `).all();
  assert(rows.every((row) => row.status === 'CLOSED'));
  assert(rows.filter((row) => row.exit_profile_id === 'X3')
    .every((row) => row.exit_market === 'PUMP_AMM'));
  assert(
    suite.trackedMints().includes(mint),
    'the AMM subscription must remain until every causal horizon is labelled',
  );

  now = base + 10_000;
  suite.advanceTime(now);
  assert(!suite.trackedMints().includes(mint));
  const dashboard = store.bondingCurveMomentumShadowDashboard({
    positionLimit: 30,
    snapshotLimit: 40,
  });
  assert.strictEqual(dashboard.cohorts.length, 12);
  assert.strictEqual(dashboard.positions.length, 12);
  assert(dashboard.snapshotStats.length > 0);
  assert(store.db.prepare(`
    SELECT COUNT(*) AS n FROM bonding_curve_momentum_shadow_snapshots
    WHERE status = 'NO_TRADE'
  `).get().n > 0);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n, 0);
  assert.strictEqual(suite.health().sendsTransactions, false);
  assert.strictEqual(store.health().bondingCurveMomentumShadowPositions.signals, 4);
  store.close();
  console.log('Bonding Curve Momentum Shadow H tests: PASS');
}

main();
