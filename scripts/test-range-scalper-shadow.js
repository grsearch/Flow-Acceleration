'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { RangeScalperShadowSuite } = require('../src/core/RangeScalperShadowSuite');

function run() {
  const base = 1_800_000_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:', rawRetentionHours: 168, archiveDir: './data/archive',
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    positionSizeSol: 0.05,
    initialObservationMs: 2_000,
    maxTrackingMs: 20_000,
    windowMs: 10_000,
    recentFlowWindowMs: 1_000,
    rangeLossConfirmMs: 1_000,
    unsubscribeGraceMs: 500,
    minTrades: 8,
    minVolumeSol: 8,
    minUniqueWallets: 6,
    minBuySharePct: 30,
    maxBuySharePct: 70,
    minRangePct: 10,
    maxEfficiencyRatio: 0.8,
    minMeanCrosses: 2,
    maxTopWalletSharePct: 25,
    maxTrendPct: 50,
    minRangeScore: 30,
    entryDelayMs: 200,
    entryTimeoutMs: 1_000,
    exitDelayMs: 200,
    exitTimeoutMs: 2_000,
    maxEntryPriceJumpPct: 3,
    entryProfiles: [{
      id: 'JA', label: 'test', deviationSigma: 0.5, reboundPct: 2,
      reboundTimeoutMs: 2_000,
    }],
    exitProfiles: [
      { id: 'XM', label: 'mid', exitMode: 'MIDLINE', hardStopPct: 8, maxHoldMs: 5_000 },
      {
        id: 'X6', label: 'tp', exitMode: 'TAKE_PROFIT', takeProfitPct: 6,
        hardStopPct: 8, maxHoldMs: 5_000,
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
  const suite = new RangeScalperShadowSuite({ config, store, now: () => now });
  const mint = 'RangeScalperMint111111111111111111111111111';
  store.recordCreate({
    mint, symbol: 'RANGE', name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: base - 1_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  store.recordComplete({ mint, completedAt: base, timestampMs: base });
  suite.onGraduated(store.getToken(mint));

  let sequence = 0;
  const observe = (offset, price, side = sequence % 2 ? 'SELL' : 'BUY') => {
    sequence += 1;
    now = base + offset;
    suite.observeTrade({
      mint, symbol: 'RANGE', market: 'PUMP_AMM', timestampMs: now,
      side, solAmount: 1, tokenAmount: 1 / price, price, reservePrice: price,
      wallet: `wallet-${sequence}`,
      signature: `${mint}:${offset}`,
    });
  };

  [1, 1.2, 0.9, 1.15, 0.92, 1.18, 0.91, 1.16, 1, 1.1]
    .forEach((price, index) => observe(100 + index * 150, price));
  assert.strictEqual(suite.health().rangeActive, 1);
  assert(suite.trackedMints(base + 3_000).includes(mint), 'qualified mint should extend');

  observe(1_700, 0.85, 'SELL');
  observe(1_850, 0.88, 'BUY');
  assert.strictEqual(suite.health().signals, 1);
  assert.strictEqual(suite.health().pendingEntries, 2);
  observe(2_100, 0.89, 'BUY');
  assert.strictEqual(suite.health().opened, 2);
  observe(2_350, 1.05, 'BUY');
  observe(2_600, 1.04, 'SELL');
  assert.strictEqual(suite.health().closed, 2);

  // Re-arm above the midline, then record an independent second swing.
  observe(2_900, 1.08, 'SELL');
  observe(3_200, 0.84, 'SELL');
  observe(3_350, 0.87, 'BUY');
  observe(3_600, 0.88, 'BUY');
  observe(3_900, 1.04, 'BUY');
  observe(4_150, 1.03, 'SELL');
  assert.strictEqual(suite.health().signals, 2);
  assert.strictEqual(suite.health().closed, 4);

  const dashboard = store.rangeScalperShadowDashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 2);
  assert.strictEqual(dashboard.positions.length, 4);
  assert(dashboard.positions.every((row) => row.status === 'CLOSED'));
  assert(dashboard.positions.every((row) => Number.isFinite(row.net_return_pct)));
  assert.deepStrictEqual(
    [...new Set(dashboard.positions.map((row) => row.swing_index))].sort(),
    [1, 2],
  );
  assert.strictEqual(store.health().rangeScalperShadowPositions.signals, 2);
  assert.strictEqual(
    store.shadowTimeSessionDashboard('range-scalper').sessions
      .reduce((sum, session) => sum + session.resolved, 0),
    4,
  );

  // A persistently one-sided regime is invalidated and dynamically unsubscribed.
  for (let index = 0; index < 12; index += 1) {
    observe(15_000 + index * 150, 1 + index * 0.02, 'BUY');
  }
  suite.advanceTime(base + 18_000);
  assert(!suite.trackedMints(base + 18_000).includes(mint));

  store.close();
  console.log('PumpSwap Range Scalper Shadow J tests: PASS');
}

run();
