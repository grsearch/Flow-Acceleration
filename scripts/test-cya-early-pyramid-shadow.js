'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { CyaEarlyPyramidShadowSuite } = require('../src/core/CyaEarlyPyramidShadowSuite');

function main() {
  const base = 1_800_000_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    positionSizeSol: 1,
    stateWindowMs: 5_000,
    stateRetentionMs: 240_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 15,
    addStepPct: 15,
    addFraction: 1 / 12,
    addCooldownMs: 250,
    maxAdds: 6,
    firstTakeProfitPct: 50,
    secondTakeProfitPct: 100,
    hardStopPct: 30,
    noStrengthMs: 25_000,
    noStrengthMfePct: 20,
    maxHoldMs: 180_000,
    entryProfiles: [{
      id: 'K5_30', label: 'strict', minAgeMs: 5_000, maxAgeMs: 30_000,
      minCurvePct: 20, maxCurvePct: 60, minBuyers5s: 3, maxBuyers5s: 14,
      minNetFlow5s: 0.1, maxNetFlow5s: 15, maxReturn2sPct: 15,
    }],
    exitProfiles: [
      { id: 'T20', label: '20', trailingStopPct: 20 },
      { id: 'T30', label: '30', trailingStopPct: 30 },
    ],
    costModel: {
      platformFeePct: 1,
      buySlippagePct: 0,
      sellSlippagePct: 0,
      priceImpactPct: 0,
      baseTxFeeSol: 0.001,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 1,
      entryFailureRatePct: 0,
      entryFailureCostPct: 0,
    },
  };
  const mint = 'CyaPyramidShadow111111111111111111111111111';
  store.recordCreate({
    mint, symbol: 'CYA', name: null, uri: null, bondingCurve: null, creator: null,
    createdAt: base - 5_000, initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  const suite = new CyaEarlyPyramidShadowSuite({ config, store, now: () => now });
  suite.start();
  let sequence = 0;
  const trade = (offset, side, sol, wallet, price) => {
    sequence += 1;
    now = base + offset;
    suite.observeTrade({
      mint, symbol: 'CYA', timestampMs: now, market: 'PUMP_BONDING_CURVE',
      side, solAmount: sol, tokenAmount: sol / price, wallet, price, reservePrice: price,
      curvePct: 40, ageMs: 5_000 + offset, signature: `${mint}:${sequence}`,
    });
  };

  trade(0, 'BUY', 1, 'buyer-1', 1);
  trade(50, 'BUY', 1, 'buyer-2', 1.01);
  trade(100, 'BUY', 1, 'buyer-3', 1.02);
  assert.strictEqual(suite.health().signals, 1);
  assert.strictEqual(suite.health().pendingEntries, 2);
  trade(350, 'BUY', 0.2, 'entry-fill', 1.03);
  assert.strictEqual(suite.health().opened, 2);

  // Two trend-continuation marks produce two 1/12 SOL adds in each cohort.
  trade(700, 'BUY', 0.2, 'trend-1', 1.20);
  trade(1_050, 'BUY', 0.2, 'trend-2', 1.40);
  let rows = store.db.prepare('SELECT * FROM cya_early_pyramid_shadow_positions').all();
  assert(rows.every((row) => row.add_count === 2));
  assert(rows.every((row) => row.total_invested_sol > 1));

  // +50% scales 25%, then a peak and 20% drawdown closes T20 only.
  trade(1_400, 'BUY', 0.2, 'tp-1', 1.80);
  trade(1_750, 'BUY', 0.2, 'peak', 2.05);
  rows = store.db.prepare('SELECT * FROM cya_early_pyramid_shadow_positions').all();
  assert(rows.every((row) => row.first_take_profit_at != null));
  trade(2_100, 'SELL', 0.2, 'drawdown', 1.60);
  trade(2_350, 'BUY', 0.1, 'exit-fill', 1.58);
  rows = store.db.prepare('SELECT * FROM cya_early_pyramid_shadow_positions').all();
  assert.strictEqual(rows.filter((row) => row.status === 'CLOSED').length, 1);
  assert.strictEqual(rows.filter((row) => row.status === 'OPEN').length, 1);

  // The wider T30 runner exits on a deeper pullback.
  trade(2_700, 'SELL', 0.2, 'deep-drawdown', 1.40);
  trade(2_950, 'BUY', 0.1, 'second-exit-fill', 1.39);
  rows = store.db.prepare('SELECT * FROM cya_early_pyramid_shadow_positions').all();
  assert(rows.every((row) => row.status === 'CLOSED'));
  assert(rows.every((row) => Number.isFinite(row.net_return_pct)));
  assert(rows.every((row) => row.estimated_cost_sol > 0.01));
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n, 0);

  const dashboard = store.cyaEarlyPyramidShadowDashboard({ positionLimit: 10 });
  assert.strictEqual(dashboard.cohorts.length, 2);
  assert.strictEqual(dashboard.positions.length, 2);
  assert.strictEqual(
    store.shadowTimeSessionDashboard('cya-early-pyramid').sessions
      .reduce((sum, session) => sum + session.resolved, 0),
    2,
  );
  store.close();
  console.log('CYA Early Pyramid Shadow K tests: PASS');
}

main();
