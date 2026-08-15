'use strict';

const assert = require('assert');
const {
  GraduationAccelerationShadowSuite,
  STATUS,
} = require('../src/core/GraduationAccelerationShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function config() {
  return {
    enabled: true,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 15_000,
    maxEntryPriceJumpPct: 1_000,
    hardStopPct: 30,
    maxPreGraduationHoldMs: 300_000,
    maxPostGraduationHoldMs: 300_000,
    coreExitPct: 50,
    capacitySols: [0.05, 0.5, 1],
    entryProfiles: [
      {
        id: 'O_FAST10_C80_B20_R07', label: 'fast10', mode: 'FIXED_10S', horizonMs: 10_000,
        minCurvePct: 80, minBuyers: 20, maxSellBuyRatio: 0.7,
      },
      {
        id: 'O_C80_D5_B2_S0_NC', label: 'curve80', mode: 'CURVE_MILESTONE',
        thresholdPct: 80, recentWindowMs: 5_000, minCurveDeltaPct: 5,
        minBuyers: 2, maxSellTx: 0, requireNoCreatorSell: true,
      },
    ],
    trailingTiers: [
      { activationPct: 20, drawdownPct: 10 },
      { activationPct: 40, drawdownPct: 15 },
      { activationPct: 80, drawdownPct: 20 },
      { activationPct: 150, drawdownPct: 25 },
      { activationPct: 300, drawdownPct: 30 },
    ],
    costModel: {
      platformFeePct: 1.4,
      buySlippagePct: 0.3,
      sellSlippagePct: 0.3,
      priceImpactPct: 0.2,
      baseTxFeeSol: 0.00001,
      priorityFeeSol: 0.0005,
      positionSizeSol: 1,
    },
  };
}

function trade({
  mint, timestampMs, price = 1e-7, curvePct, side = 'BUY', wallet,
  market = 'PUMP_BONDING_CURVE', solAmount = 1,
}) {
  return {
    mint,
    timestampMs,
    price,
    reservePrice: price,
    curvePct,
    side,
    wallet: wallet || `wallet-${timestampMs}`,
    solAmount,
    market,
    virtualSolReservesRaw: market === 'PUMP_BONDING_CURVE' ? '100000000000' : null,
    virtualTokenReservesRaw: market === 'PUMP_BONDING_CURVE' ? '1000000000000000' : null,
  };
}

function main() {
  const store = makeStore();
  let now = 100_000;
  const suite = new GraduationAccelerationShadowSuite({ config: config(), store, now: () => now });
  suite.start();
  assert.strictEqual(suite.health().sendsTransactions, false);
  assert.strictEqual(suite.health().mode, 'SHADOW_O');

  suite.onCreate({ mint: 'fast-mint', symbol: 'FAST', creator: 'creator-fast', createdAt: 100_000 });
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 100_050, curvePct: 10, side: 'SELL',
    wallet: 'creator-fast', solAmount: 0.5,
  }));
  for (let index = 0; index < 20; index += 1) {
    suite.observeTrade(trade({
      mint: 'fast-mint',
      timestampMs: 100_100 + index * 490,
      curvePct: 12 + index * 3.55,
      wallet: `fast-buyer-${index}`,
      solAmount: 1,
    }));
  }
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 110_000, curvePct: 82, wallet: 'fast-buyer-20',
  }));
  assert.strictEqual(suite.health().pendingEntries, 3, 'FAST10 creates one row per capacity');
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 110_200, curvePct: 83, wallet: 'fill-wallet',
  }));
  let dashboard = store.graduationAccelerationShadowDashboard();
  let fastRows = dashboard.positions.filter((row) => row.mint === 'fast-mint');
  assert.strictEqual(fastRows.length, 3);
  assert.ok(fastRows.every((row) => row.status === STATUS.OPEN));
  const impacts = fastRows.sort((left, right) => left.position_sol - right.position_sol)
    .map((row) => row.entry_impact_pct);
  assert.ok(impacts[2] > impacts[1] && impacts[1] > impacts[0], 'larger capacities model more curve impact');

  suite.onGraduated({ mint: 'fast-mint', graduated_at: 111_000 });
  const entryPrice = fastRows[0].entry_price;
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_200, price: entryPrice * 1.3,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  assert.strictEqual(suite.health().coreExits, 3, 'graduation takes the 50% core exit');
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_300, price: entryPrice * 2,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_500, price: entryPrice * 1.05,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_700, price: entryPrice * 1.04,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  dashboard = store.graduationAccelerationShadowDashboard();
  fastRows = dashboard.positions.filter((row) => row.mint === 'fast-mint');
  assert.ok(fastRows.every((row) => row.status === STATUS.CLOSED));
  assert.ok(fastRows.every((row) => row.core_exit_price > 0 && row.net_return_pct > 0));

  suite.onCreate({ mint: 'curve80-mint', symbol: 'C80', creator: 'creator-c80', createdAt: 200_000 });
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 200_100, curvePct: 10, wallet: 'c80-buyer-0',
  }));
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 201_000, curvePct: 72, wallet: 'c80-buyer-1',
  }));
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 202_000, curvePct: 80, wallet: 'c80-buyer-2',
  }));
  assert.strictEqual(suite.health().pendingEntries, 3, 'Curve80 order flow creates capacity rows');
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 202_200, curvePct: 81, wallet: 'c80-fill',
  }));
  suite.onGraduated({ mint: 'curve80-mint', graduated_at: 203_000 });
  suite.onGraduated({ mint: 'curve80-mint', migrated_at: 204_000 });
  assert.strictEqual(suite.health().graduated, 2, 'complete and migration events deduplicate the mint');
  now = 504_001;
  suite.advanceTime(now);
  dashboard = store.graduationAccelerationShadowDashboard();
  const noExitRows = dashboard.positions.filter((row) => row.mint === 'curve80-mint');
  assert.ok(noExitRows.every((row) => row.status === STATUS.NO_EXIT));
  assert.ok(noExitRows.every((row) => row.net_return_pct == null), 'NO_EXIT is not forced to -100%');

  const cohorts = dashboard.cohorts;
  assert.strictEqual(cohorts.length, 6, '2 entries x 3 capacities remain independent');
  assert.ok(cohorts.some((row) => row.closed === 1 && row.resolved === 1));
  assert.ok(cohorts.some((row) => row.no_exit === 1 && row.resolved === 0));
  store.close();
  console.log('graduation acceleration shadow tests passed');
}

main();
