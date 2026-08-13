'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { MigrationContinuityShadowSuite } = require(
  '../src/core/MigrationContinuityShadowSuite'
);

function trade(mint, timestampMs, price, side = 'BUY', solAmount = 1, wallet = null) {
  return {
    mint, timestampMs, receivedAtMs: timestampMs, market: 'PUMP_AMM', side,
    solAmount, tokenAmount: solAmount / price, price, reservePrice: price,
    wallet: wallet || `${mint}:${side}:${timestampMs}`,
    signature: `${mint}:${timestampMs}:${price}:${side}`,
  };
}

function config() {
  return {
    enabled: true, positionSizeSol: 1, confirmWindowMs: 5_000,
    detectionDeadlineMs: 10_000, flowWindowMs: 3_000,
    entryDelayMs: 200, entryTimeoutMs: 2_000, exitDelayMs: 200, exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 10,
    entryProfile: {
      id: 'MC_C5', minBuyers: 20, minNetFlowSol: 5,
      minReturnPct: 5, maxSellBuyRatio: 0.6,
    },
    exitProfiles: [
      { id: 'E60', exitMode: 'FIXED_HOLD', fixedHoldMs: 60_000, hardStopPct: 20, maxHoldMs: 60_000 },
      { id: 'T10', exitMode: 'TRAILING', minHoldMs: 5_000, trailingActivationPct: 10, trailingStopPct: 10, hardStopPct: 20, maxHoldMs: 120_000 },
      { id: 'FLOW', exitMode: 'FLOW_FADE', minHoldMs: 10_000, minSellBuyRatio: 1.2, maxNetFlowSol: -2, hardStopPct: 20, maxHoldMs: 180_000 },
    ],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0,
      jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
    },
  };
}

function main() {
  const base = 1_900_000_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:', rawRetentionHours: 168, archiveDir: './data/archive',
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const mint = 'MigrationContinuity11111111111111111111111111';
  store.recordCreate({ mint, symbol: 'MC', name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: base - 60_000, initialRealTokenReservesRaw: null,
    tokenTotalSupplyRaw: null });
  store.recordComplete({ mint, completedAt: base, timestampMs: base });
  let suite = new MigrationContinuityShadowSuite({ config: config(), store, now: () => now });
  suite.start();
  suite.onGraduated(store.getToken(mint));
  suite.observeTrade(trade(mint, base + 100, 1));
  for (let index = 0; index < 20; index += 1) {
    suite.observeTrade(trade(
      mint,
      base + 1_000 + index * 200,
      1 + (index + 1) * 0.003,
      'BUY',
      0.4,
      `buyer-${index}`,
    ));
  }
  now = base + 5_000;
  suite.observeTrade(trade(mint, now, 1.07, 'BUY', 0.4, 'buyer-20'));
  assert.strictEqual(suite.health().matched, 1);
  assert.strictEqual(suite.health().pendingEntries, 3);
  now += 250;
  suite.observeTrade(trade(mint, now, 1.075, 'BUY', 0.2, 'fill'));
  assert.strictEqual(suite.health().opened, 3);

  // A 12% peak arms T10; the first five seconds are protected from trailing.
  suite.observeTrade(trade(mint, base + 7_000, 1.21, 'BUY', 0.2, 'peak'));
  suite.observeTrade(trade(mint, base + 9_000, 1.08, 'SELL', 0.2, 'dip'));
  assert.strictEqual(suite.health().activePositions, 3);
  suite.observeTrade(trade(mint, base + 11_000, 1.08, 'SELL', 0.2, 'trail-trigger'));
  suite.observeTrade(trade(mint, base + 11_250, 1.07, 'SELL', 0.2, 'trail-fill'));
  let rows = store.migrationContinuityShadowDashboard({ positionLimit: 20 }).positions;
  assert.strictEqual(rows.find((row) => row.exit_profile_id === 'T10').status, 'CLOSED');

  // Three seconds of sell-dominant flow exits FLOW after its ten-second guard.
  for (let index = 0; index < 3; index += 1) {
    suite.observeTrade(trade(mint, base + 16_000 + index * 500, 1.05, 'SELL', 1.1, `seller-${index}`));
  }
  suite.observeTrade(trade(mint, base + 17_500, 1.04, 'SELL', 0.2, 'flow-fill'));
  rows = store.migrationContinuityShadowDashboard({ positionLimit: 20 }).positions;
  assert.strictEqual(rows.find((row) => row.exit_profile_id === 'FLOW').status, 'CLOSED');

  suite.observeTrade(trade(mint, base + 65_300, 1.3, 'BUY', 0.2, 'fixed-trigger'));
  suite.observeTrade(trade(mint, base + 65_550, 1.29, 'BUY', 0.2, 'fixed-fill'));
  rows = store.migrationContinuityShadowDashboard({ positionLimit: 20 }).positions;
  assert.strictEqual(rows.find((row) => row.exit_profile_id === 'E60').status, 'CLOSED');
  assert(rows.every((row) => Number.isFinite(row.net_return_pct)));

  suite.stop();
  suite = new MigrationContinuityShadowSuite({ config: config(), store, now: () => now });
  suite.start();
  assert(store.hasMigrationContinuityShadowSignal(mint));
  assert.strictEqual(suite.health().pendingEntries, 0);
  store.close();
  console.log('test-migration-continuity-shadow: ok');
}

main();
